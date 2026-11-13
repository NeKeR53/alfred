import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { NotificationToasts } from "../../shell/NotificationCenter";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { ArchivedConversations } from "../agentSettings/ArchivedConversations";
import { AgentPage } from "./AgentPage";
import type { Conversation } from "./model";
import { useAgents } from "./store";

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

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};

function stored(id: string, title: string, updatedAt: number): Conversation {
  return {
    id,
    title,
    provider: "claude",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    unread: false,
    started: true,
    turns: [
      {
        id: `${id}-t1`,
        user: { text: `Bonjour ${title}`, attachments: [], contexts: [] },
        items: [],
        status: "done",
        startedAt: updatedAt,
        endedAt: updatedAt,
      },
    ],
  };
}

/** Faux backend des conversations : ce qu’enregistre `conversations.save` est ce que relit la liste. */
let database: Record<string, Conversation>;

beforeEach(() => {
  database = { c1: stored("c1", "Factures", 2_000), c2: stored("c2", "Notes", 1_000) };
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "conversations.list")
      return Object.values(database)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ turns: _turns, ...header }) => header);
    if (command === "conversations.get") return structuredClone(database[args.id as string] ?? null);
    if (command === "conversations.save") {
      const conversation = args.conversation as Conversation;
      database[conversation.id] = structuredClone(conversation);
      return null;
    }
    return null;
  });
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
    view: { kind: "agent" },
  });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: false });
});

describe("conversations d’agent", () => {
  it("renomme, marque comme non lue, archive (avec annulation) puis retrouve et désarchive", async () => {
    render(
      <>
        <AgentPage />
        <NotificationToasts />
      </>,
    );
    await screen.findByRole("heading", { name: "Factures" });

    // Renommer depuis le menu de la conversation.
    fireEvent.click(screen.getByRole("button", { name: "Autres actions sur la conversation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Renommer" }));
    const input = await screen.findByRole("textbox", { name: "Nom de la conversation" });
    fireEvent.change(input, { target: { value: "Factures de novembre" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(database.c1.title).toBe("Factures de novembre"));
    await screen.findByRole("heading", { name: "Factures de novembre" });

    // Marquer comme non lue : la page passe à l’autre conversation, la première reste « à consulter ».
    fireEvent.click(screen.getByRole("button", { name: "Autres actions sur la conversation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Marquer comme non lue" }));
    await screen.findByRole("heading", { name: "Notes" });
    expect(database.c1.unread).toBe(true);
    expect(useAgents.getState().headers.find((header) => header.id === "c1")?.unread).toBe(true);

    // Archiver, puis annuler depuis la notification.
    fireEvent.click(screen.getAllByRole("button", { name: "Archiver Notes" })[0]);
    await waitFor(() => expect(database.c2.archived).toBe(true));
    const toast = (await screen.findByText("Conversation archivée")).closest(".notification") as HTMLElement;
    fireEvent.click(within(toast).getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(database.c2.archived).toBe(false));

    // Archiver depuis sa ligne de la liste, puis la retrouver dans les Réglages et la désarchiver.
    const panel = await screen.findByLabelText("Suivi des conversations");
    fireEvent.click(await within(panel).findByRole("button", { name: "Archiver Notes" }));
    await waitFor(() => expect(database.c2.archived).toBe(true));
    const settings = render(<ArchivedConversations />);
    const list = await settings.findByRole("list", { name: "Conversations archivées" });
    expect(within(list).getByText("Notes")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Désarchiver Notes" }));
    await waitFor(() => expect(database.c2.archived).toBe(false));
    await settings.findByText("Aucune conversation archivée");
  });
});
