import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
}));

import { useNotifications } from "../../shell/notifications";
import { useComposerDrafts } from "../agent/drafts";
import type { Conversation } from "../agent/model";
import { useAgents } from "../agent/store";
import { ArchivedConversations } from "./ArchivedConversations";

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};

function archived(id: string, title: string, updatedAt: number, archivedAt?: number): Conversation {
  return {
    id,
    title,
    provider: "codex",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: 0,
    updatedAt,
    archived: true,
    unread: false,
    started: true,
    turns: [],
    ...(archivedAt === undefined ? {} : { archivedAt }),
  } as Conversation;
}

let database: Record<string, Conversation>;

beforeEach(() => {
  // « Factures » a été mise à jour en dernier, mais « Notes » a été archivée après elle.
  database = {
    a: archived("a", "Factures", Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 11, 9, 30)),
    b: archived("b", "Notes", Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 12, 14, 0)),
    c: archived("c", "Ancienne", Date.UTC(2026, 9, 1)),
  };
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "conversations.list") return Object.values(database).map(({ turns: _turns, ...header }) => header);
    if (command === "conversations.get") return structuredClone(database[args.id as string] ?? null);
    if (command === "conversations.save") {
      const conversation = args.conversation as Conversation;
      database[conversation.id] = structuredClone(conversation);
      return null;
    }
    if (command === "conversations.delete") {
      delete database[args.id as string];
      return null;
    }
    return null;
  });
  useNotifications.setState({ items: [], toasts: [] });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: false });
});

const titles = () =>
  within(screen.getByRole("list", { name: "Conversations archivées" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");

const lastNotification = () => useNotifications.getState().items[0];

it("trie par date d’archivage et l’affiche, la date de mise à jour servant aux plus anciennes", async () => {
  render(<ArchivedConversations />);
  await screen.findByText("Notes");
  const rows = titles();
  expect(rows.map((row) => row.split("Codex")[0])).toEqual(["Notes", "Factures", "Ancienne"]);
  expect(rows[0]).toMatch(/Codex · archivée le 12 nov\. 2026/);
  expect(screen.getByRole("heading", { name: "Conversations archivées · 3" })).toBeInTheDocument();
  // Comme dans OneApp : restaurer ou supprimer, rien d’autre ; l’origine n’est pas rappelée.
  expect(screen.queryByRole("button", { name: /^Ouvrir / })).toBeNull();
});

it("restaure avec une notification, et supprime définitivement après confirmation", async () => {
  const clear = vi.spyOn(useComposerDrafts.getState(), "clear");
  render(<ArchivedConversations />);
  fireEvent.click(await screen.findByRole("button", { name: "Restaurer Notes" }));
  await waitFor(() => expect(database.b.archived).toBe(false));
  expect(lastNotification()).toMatchObject({
    title: "Conversation restaurée",
    description: "Notes est de nouveau dans la page Agent.",
  });

  fireEvent.click(screen.getByRole("button", { name: "Supprimer définitivement Factures" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Supprimer définitivement « Factures » ?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Supprimer définitivement" }));
  await waitFor(() => expect(database.a).toBeUndefined());
  // Son brouillon part avec elle, comme `deleteChatDraft` dans OneApp.
  await waitFor(() => expect(clear).toHaveBeenCalledWith("a"));
  expect(lastNotification()).toMatchObject({ title: "Conversation supprimée", description: "Factures" });
  // Une seule conversation archivée : plus de « Tout supprimer ».
  expect(screen.queryByRole("button", { name: "Tout supprimer" })).toBeNull();
});

it("« Tout supprimer » efface toutes les conversations archivées après confirmation", async () => {
  render(<ArchivedConversations />);
  fireEvent.click(await screen.findByRole("button", { name: "Tout supprimer" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Supprimer les 3 conversations archivées ?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Tout supprimer" }));
  await waitFor(() => expect(Object.keys(database)).toEqual([]));
  expect(lastNotification()).toMatchObject({
    title: "Conversations supprimées",
    description: "3 conversations effacées.",
  });
  expect(await screen.findByText("Aucune conversation archivée")).toBeInTheDocument();
});
