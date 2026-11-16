import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { AgentPage } from "./AgentPage";
import { compareConversations, type GitSummary } from "./ConversationList";
import type { Conversation, ConversationHeader } from "./model";
import { useAgentPreferences } from "./panel/ModelPicker";
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
vi.mock("./harness", async (original) => ({
  ...(await original<typeof import("./harness")>()),
  listModels: vi.fn(async () => []),
}));

function stored(id: string, title: string, at: number, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title,
    provider: "claude",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: at,
    updatedAt: at,
    archived: false,
    unread: false,
    started: true,
    turns: [
      {
        id: `${id}-t1`,
        user: { text: `Bonjour ${title}`, attachments: [], contexts: [] },
        items: [],
        status: "done",
        startedAt: at,
        endedAt: at,
      },
    ],
    ...patch,
  };
}

const realLoad = useAgents.getState().load;
let database: Record<string, Conversation>;
let git: GitSummary | Error;
let settings: Record<string, unknown>;

beforeEach(() => {
  database = { c1: stored("c1", "Factures", 2_000) };
  git = { root: "/espace", files: [], additions: 0, deletions: 0, truncated: false };
  settings = {};
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "conversations.list")
      return Object.values(database)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ turns: _turns, ...header }) => header);
    if (command === "conversations.get") return structuredClone(database[args.id as string] ?? null);
    if (command === "settings.get") return settings[args.key as string] ?? null;
    if (command === "agentWorkspace.gitSummary") {
      if (git instanceof Error) throw git;
      return git;
    }
    return null;
  });
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
    view: { kind: "agent" },
  });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: false, load: realLoad });
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, textEditor: null },
    status: "idle",
  });
});

describe("page Agent", () => {
  it("F2 met le titre de la conversation ouverte en édition", async () => {
    render(<AgentPage />);
    await screen.findByRole("heading", { name: "Factures" });
    fireEvent.keyDown(window, { key: "F2" });
    expect(await screen.findByRole("textbox", { name: "Nom de la conversation" })).toHaveValue("Factures");
  });

  it("ouvre le dossier de travail dans l’explorateur, et dans l’éditeur une fois choisi", async () => {
    render(<AgentPage />);
    await screen.findByRole("heading", { name: "Factures" });
    const editor = screen.getByRole("button", { name: "Ouvrir le dossier dans l’éditeur" });
    // Sans éditeur dans les réglages, le bouton reste visible mais grisé.
    expect(editor).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le dossier dans l’explorateur" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.openExplorer", { path: "/espace" }));

    act(() =>
      useAgentPreferences.setState({
        values: { shownModels: {}, titling: null, textEditor: { command: 'code "{{directory}}"' } },
      }),
    );
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.click(editor);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.openEditor", {
        command: 'code "{{directory}}"',
        path: "/espace",
      }),
    );
  });

  it("montre l’état Git du dossier de travail sous la saisie et dans la carte « Modifications »", async () => {
    git = {
      root: "/espace",
      files: [
        { path: "a.txt", state: "modifié" },
        { path: "b.txt", state: "nouveau" },
      ],
      additions: 1200,
      deletions: 3,
      truncated: false,
    };
    render(<AgentPage />);
    await screen.findByRole("heading", { name: "Factures" });
    const pill = await screen.findByRole("status");
    expect(pill).toHaveTextContent("2 fichiers modifiés");
    expect(pill).toHaveTextContent("+1 200");
    expect(pill).toHaveTextContent("−3");
    const card = within(screen.getByLabelText("Suivi des conversations")).getByRole("region", {
      name: "Modifications",
    });
    expect(within(card).getByText("Modifications", { selector: ".agent-changes__name" })).toHaveAttribute(
      "title",
      "/espace",
    );
    expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.gitSummary", { path: "/espace" });
  });

  it("signale un dépôt illisible, sans pastille", async () => {
    git = new Error("Ce dossier n’est pas un dépôt Git.");
    render(<AgentPage />);
    expect(await screen.findByText("1 dépôt indisponible.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("affiche le bandeau d’échec de chargement avec « Réessayer » quand le magasin l’expose", async () => {
    const load = vi.fn(async () => undefined);
    render(<AgentPage />);
    await screen.findByRole("heading", { name: "Factures" });
    act(() => useAgents.setState({ loadError: "Base illisible.", load } as never));
    expect(await screen.findByText("L’historique des agents n’a pas pu être chargé.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(load).toHaveBeenCalled();
    act(() => useAgents.setState({ loadError: undefined } as never));
  });

  it("affiche l’échec d’enregistrement près de la saisie avec « Réessayer la sauvegarde »", async () => {
    const retrySave = vi.fn(async () => undefined);
    render(<AgentPage />);
    await screen.findByRole("heading", { name: "Factures" });
    act(() =>
      useAgents.setState({
        saveError: "Les conversations n’ont pas pu être enregistrées : disque plein",
        retrySave,
      } as never),
    );
    expect(await screen.findByText(/n’ont pas pu être enregistrées : disque plein/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer la sauvegarde" }));
    expect(retrySave).toHaveBeenCalled();
    act(() => useAgents.setState({ saveError: undefined, retrySave: undefined } as never));
  });
});

describe("tri du suivi", () => {
  const header = (id: string, createdAt: number, updatedAt: number): ConversationHeader => {
    const { turns: _turns, ...rest } = stored(id, id, createdAt, { updatedAt });
    return rest;
  };

  it("classe par état, les conversations au travail par création, les autres par mise à jour", () => {
    const old = header("ancienne", 1, 50);
    const recent = header("récente", 10, 20);
    // Au travail : la plus récemment créée d’abord, même si l’autre vient d’écrire.
    expect(compareConversations(old, "working", recent, "working")).toBeGreaterThan(0);
    // Terminées : la plus récemment mise à jour d’abord.
    expect(compareConversations(old, "idle", recent, "idle")).toBeLessThan(0);
    // Une réponse attendue passe devant tout, une erreur devant le travail, le travail devant le reste.
    expect(compareConversations(recent, "attention", old, "error")).toBeLessThan(0);
    expect(compareConversations(recent, "error", old, "working")).toBeLessThan(0);
    expect(compareConversations(recent, "working", old, "unread")).toBeLessThan(0);
    expect(compareConversations(recent, "unread", old, "idle")).toBeLessThan(0);
  });
});
