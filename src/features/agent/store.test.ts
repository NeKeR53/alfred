import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppInfo, Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { createSession, type HarnessEvent, type HarnessSession, type SessionOptions } from "./harness";
import type { UserMessage } from "./model";
import { useAgents } from "./store";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), onNativeEvent: vi.fn() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: native.onNativeEvent,
}));
vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  createSession: vi.fn(),
}));

/** Session de harnais simulée : le test émet les événements que l’adaptateur produirait. */
interface FakeSession {
  options: SessionOptions;
  session: Record<"send" | "steer" | "answer" | "cancel" | "close", Mock>;
  emit: (event: HarnessEvent) => void;
}

let sessions: FakeSession[];
let commands: Array<[string, Record<string, unknown> | undefined]>;
let nextCommit: string | null;

beforeEach(() => {
  sessions = [];
  commands = [];
  nextCommit = "c0ffee1";
  native.onNativeEvent.mockReturnValue(() => undefined);
  native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    commands.push([command, args]);
    if (command === "space.commit") return { commit: nextCommit };
    if (command === "space.history")
      return [{ id: nextCommit, message: "", date: "", files: ["modules/factures/page.tsx"] }];
    return null;
  });
  vi.mocked(createSession).mockImplementation(async (options) => {
    const fake: FakeSession = {
      options,
      emit: (event) => options.onEvent(event),
      session: {
        send: vi.fn(async () => undefined),
        steer: vi.fn(async () => undefined),
        answer: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        // Comme les vrais adaptateurs : fermer la session annonce « closed ».
        close: vi.fn(async () => options.onEvent({ type: "status", status: "closed" })),
      },
    };
    sessions.push(fake);
    return fake.session as unknown as HarnessSession;
  });
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
    info: { serverPort: 4100 } as AppInfo,
    view: { kind: "agent" },
  });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: true });
});

const message = (text: string): UserMessage => ({ text, attachments: [], contexts: [] });
const conversation = (id: string) => useAgents.getState().loaded[id]!;
const lastTurn = (id: string) => conversation(id).turns.at(-1)!;
const runtime = (id: string) => useAgents.getState().runtime[id];
const called = (command: string) => commands.filter(([name]) => name === command).map(([, args]) => args);

function start(options: Parameters<ReturnType<typeof useAgents.getState>["create"]>[0] = {}) {
  const created = useAgents.getState().create({ provider: "codex", model: "gpt-5", autonomy: "ask", ...options });
  useAgents.setState({ activeId: created.id });
  return created.id;
}

/** Un tour complet : message envoyé, réponse, fin. */
async function answeredTurn(id: string, text: string, reply: string) {
  await useAgents.getState().send(id, message(text));
  const live = sessions.at(-1)!;
  live.emit({ type: "status", status: "responding" });
  live.emit({ type: "message", itemId: `m-${text}`, content: reply, replace: true });
  live.emit({ type: "status", status: "idle" });
  await vi.waitFor(() => expect(lastTurn(id).status).toBe("done"));
  return live;
}

describe("conversation d’agent · un tour", () => {
  it("crée le tour, le remplit des événements du harnais, puis en fait un commit enregistré", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Ajoute une page Factures"));

    const [live] = sessions;
    expect(live.options).toMatchObject({
      provider: "codex",
      cwd: "/espace",
      spaceDir: "/espace",
      conversation: id,
      toolsUrl: "http://127.0.0.1:4100/mcp",
      model: "gpt-5",
      autonomy: "ask",
      title: "Ajoute une page Factures",
    });
    expect(live.options.instructions).toContain("lis /espace/AGENTS.md");
    expect(live.session.send).toHaveBeenCalledWith("Ajoute une page Factures", [], lastTurn(id).id);
    expect(conversation(id)).toMatchObject({ title: "Ajoute une page Factures", started: true });
    expect(lastTurn(id)).toMatchObject({ status: "running", items: [] });

    live.emit({ type: "status", status: "responding" });
    live.emit({ type: "session", sessionId: "thr_1" });
    live.emit({ type: "message", itemId: "am_1", content: "Je lis " });
    live.emit({ type: "message", itemId: "am_1", content: "les règles." });
    live.emit({
      type: "activity",
      itemId: "cmd_1",
      kind: "command",
      title: "Commande",
      detail: "cat AGENTS.md",
      status: "running",
    });
    live.emit({ type: "activityDelta", itemId: "cmd_1", content: "# Règles" });
    live.emit({ type: "activity", itemId: "cmd_1", kind: "command", title: "Commande", status: "completed" });
    live.emit({ type: "message", itemId: "am_2", content: "Page créée.", replace: true });
    expect(runtime(id).status).toBe("responding");
    expect(conversation(id).sessionId).toBe("thr_1");
    expect(lastTurn(id).items).toEqual([
      { kind: "message", id: "am_1", content: "Je lis les règles." },
      expect.objectContaining({
        kind: "activity",
        id: "cmd_1",
        detail: "cat AGENTS.md",
        content: "# Règles",
        status: "completed",
      }),
      { kind: "message", id: "am_2", content: "Page créée." },
    ]);

    live.emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("done"));
    expect(called("space.commit")).toEqual([{ message: "Ajoute une page Factures" }]);
    expect(lastTurn(id)).toMatchObject({ commit: "c0ffee1", changedFiles: ["modules/factures/page.tsx"] });
    expect(conversation(id).preview).toBe("Page créée.");
    expect(runtime(id).status).toBe("idle");
    const saved = called("conversations.save").at(-1)?.conversation as { id: string; turns: unknown[] };
    expect(saved).toMatchObject({ id, turns: [expect.objectContaining({ status: "done", commit: "c0ffee1" })] });
  });

  it("ne note pas de commit quand l’agent n’a rien modifié", async () => {
    nextCommit = null;
    const id = start();
    await answeredTurn(id, "Bonjour", "Bonjour !");
    expect(lastTurn(id).commit).toBeUndefined();
    expect(called("space.history")).toEqual([]);
  });

  it("garde la session ouverte d’un message à l’autre", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    await answeredTurn(id, "Deux", "Réponse deux.");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessions[0].session.send).toHaveBeenCalledTimes(2);
    expect(conversation(id).turns.map((turn) => turn.status)).toEqual(["done", "done"]);
  });

  it("refuse un message pendant que l’agent répond", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    await expect(useAgents.getState().send(id, message("Deux"))).rejects.toThrow("prépare déjà une réponse");
  });
});

describe("conversation d’agent · changement de réglages", () => {
  it("changer de modèle entre deux messages ferme l’ancienne session sans terminer le nouveau tour", async () => {
    const id = start();
    const first = await answeredTurn(id, "Un", "Réponse un.");
    first.emit({ type: "session", sessionId: "thr_1" });

    useAgents.getState().update(id, { model: "gpt-5-mini" });
    await useAgents.getState().send(id, message("Deux"));

    // L’ancienne session annonce sa fermeture pendant que le nouveau tour démarre : ce n’est pas sa fin.
    expect(first.session.close).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(2);
    const second = sessions[1];
    expect(second.options).toMatchObject({ model: "gpt-5-mini", resumeSessionId: "thr_1" });
    expect(second.session.send).toHaveBeenCalledWith("Deux", [], lastTurn(id).id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastTurn(id)).toMatchObject({ status: "running" });
    expect(lastTurn(id).error).toBeUndefined();

    // Un dernier événement de l’ancienne session ne touche pas non plus le tour.
    first.emit({ type: "error", message: "Codex s’est arrêté." });
    first.emit({ type: "status", status: "idle" });
    expect(lastTurn(id)).toMatchObject({ status: "running" });
    expect(lastTurn(id).error).toBeUndefined();

    second.emit({ type: "message", itemId: "m2", content: "Réponse deux.", replace: true });
    second.emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("done"));
    expect(conversation(id).turns.map((turn) => turn.status)).toEqual(["done", "done"]);
  });

  it("changer d’autonomie rouvre aussi la session", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    useAgents.getState().update(id, { autonomy: "auto" });
    await useAgents.getState().send(id, message("Deux"));
    expect(sessions.map((live) => live.options.autonomy)).toEqual(["ask", "auto"]);
  });
});

describe("conversation d’agent · accords et erreurs", () => {
  const request = {
    id: "codex-41",
    title: "Exécuter une commande",
    detail: "rm -rf dist",
    options: [
      { id: "accept", label: "Autoriser", kind: "allow" as const },
      { id: "decline", label: "Refuser", kind: "deny" as const },
    ],
  };

  it("affiche la demande d’accord puis la retire une fois répondue", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Nettoie"));
    const [live] = sessions;
    live.emit({ type: "approval", request });
    expect(runtime(id).approvals).toEqual([request]);

    await useAgents.getState().answerApproval(id, "codex-41", "accept");
    expect(live.session.answer).toHaveBeenCalledWith("codex-41", "accept");
    expect(runtime(id).approvals).toEqual([]);
  });

  it("retire la demande que le harnais déclare close", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Nettoie"));
    sessions[0].emit({ type: "approval", request });
    sessions[0].emit({ type: "approvalClosed", id: "codex-41" });
    expect(runtime(id).approvals).toEqual([]);
  });

  it("termine le tour en erreur quand le harnais ne peut pas démarrer", async () => {
    vi.mocked(createSession).mockRejectedValueOnce(new Error("Codex n’est pas installé."));
    const id = start();
    await useAgents.getState().send(id, message("Bonjour"));
    expect(lastTurn(id)).toMatchObject({ status: "error", error: "Codex n’est pas installé." });
    expect(runtime(id).status).toBe("idle");
    expect(called("conversations.save")).not.toEqual([]);
  });

  it("termine le tour en erreur quand le harnais signale une erreur puis la fin", async () => {
    const id = start({ provider: "claude" });
    await useAgents.getState().send(id, message("Bonjour"));
    sessions[0].emit({ type: "error", message: "Claude Code n’a pas pu terminer sa réponse : Not logged in." });
    sessions[0].emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("error"));
    expect(lastTurn(id).error).toBe("Claude Code n’a pas pu terminer sa réponse : Not logged in.");
  });

  it("termine le tour en erreur à l’arrêt inattendu du harnais, puis rouvre une session au message suivant", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Bonjour"));
    sessions[0].emit({ type: "error", message: "Codex s’est arrêté. Envoyer un message relance la conversation." });
    sessions[0].emit({ type: "status", status: "closed" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("error"));
    expect(runtime(id).status).toBe("idle");

    await useAgents.getState().send(id, message("Encore"));
    expect(sessions).toHaveLength(2);
  });

  it("annuler le tour d’un modifié restaure l’espace et oublie le commit", async () => {
    const id = start();
    await answeredTurn(id, "Ajoute une page", "Fait.");
    const turnId = lastTurn(id).id;
    await useAgents.getState().undoTurn(id, turnId);
    expect(called("space.undo")).toEqual([{ commit: "c0ffee1" }]);
    expect(lastTurn(id)).toMatchObject({ commit: undefined, changedFiles: undefined });
  });

  it("transmet l’interruption au harnais", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Long travail"));
    await useAgents.getState().cancel(id);
    expect(sessions[0].session.cancel).toHaveBeenCalledTimes(1);
  });
});

/** Régressions corrigées dans `store.ts` : fin de tour unique et tour interrompu marqué annulé. */
describe("conversation d’agent · défauts connus", () => {
  it("deux fins de tour rapprochées ne créent qu’un commit", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Ajoute une page"));
    // Exemple réel : arrêt du processus (« closed ») puis rejet de `send`, ou « idle » puis « closed ».
    sessions[0].emit({ type: "status", status: "idle" });
    sessions[0].emit({ type: "status", status: "closed" });
    await vi.waitFor(() => expect(lastTurn(id).status).not.toBe("running"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called("space.commit")).toHaveLength(1);
  });

  it("un tour interrompu par l’utilisateur est marqué annulé, pas terminé", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Long travail"));
    // Les harnais confirment l’interruption par un retour à « idle ».
    sessions[0].session.cancel.mockImplementation(async () => sessions[0].emit({ type: "status", status: "idle" }));
    await useAgents.getState().cancel(id);
    await vi.waitFor(() => expect(lastTurn(id).status).not.toBe("running"));
    expect(lastTurn(id).status).toBe("cancelled");
  });
});
