import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppInfo, Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { createSession, type HarnessEvent, type HarnessSession, type SessionOptions } from "./harness";
import type { UserMessage } from "./model";
import { checkAgentSilence, flushAgentUpdates, releaseIdleAgentSessions, resetAgentEngine, useAgents } from "./store";

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
  resetAgentEngine();
  useAgents.setState({
    loaded: {},
    headers: [],
    runtime: {},
    activeId: null,
    ready: true,
    loadError: undefined,
    saveError: undefined,
    follow: {},
  });
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
    // Les fragments d’une réponse sont annoncés au plus toutes les 120 ms.
    flushAgentUpdates();
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

  it("met en file un message écrit pendant que l’agent répond et l’envoie à la fin du tour", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    await useAgents.getState().send(id, message("Deux"));
    expect(conversation(id).turns).toHaveLength(1);
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["Deux"]);

    sessions[0].emit({ type: "message", itemId: "m1", content: "Réponse un.", replace: true });
    sessions[0].emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(conversation(id).turns).toHaveLength(2));
    expect(conversation(id).turns[0].status).toBe("done");
    expect(lastTurn(id)).toMatchObject({ status: "running", user: { text: "Deux" } });
    expect(runtime(id).queued).toEqual([]);
    await vi.waitFor(() => expect(sessions[0].session.send).toHaveBeenCalledTimes(2));
  });

  it("glisse tout de suite un message dans la réponse en cours, comme OneApp avec Codex", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    sessions[0].emit({ type: "status", status: "responding" });
    await useAgents.getState().send(id, message("Plutôt ceci"), { now: true });
    expect(sessions[0].session.steer).toHaveBeenCalledWith("Plutôt ceci", [], expect.any(String));
    expect(runtime(id).queued).toEqual([]);
    expect(conversation(id).turns.map((turn) => turn.status)).toEqual(["done", "running"]);
    expect(lastTurn(id).user.text).toBe("Plutôt ceci");
    expect(sessions[0].session.cancel).not.toHaveBeenCalled();
  });

  it("interrompt la réponse puis envoie le message quand l’agent ne sait pas l’orienter", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    sessions[0].emit({ type: "status", status: "responding" });
    sessions[0].session.steer.mockRejectedValueOnce(new Error("non"));
    await useAgents.getState().send(id, message("Autre chose"), { now: true });
    // Comme OneApp : le tour s’arrête tout de suite, la session est fermée et le message part dans une neuve.
    await vi.waitFor(() => expect(lastTurn(id)).toMatchObject({ status: "running", user: { text: "Autre chose" } }));
    expect(sessions[0].session.cancel).toHaveBeenCalled();
    expect(sessions[0].session.close).toHaveBeenCalled();
    expect(conversation(id).turns[0].status).toBe("cancelled");
    expect(runtime(id).queued).toEqual([]);
    await vi.waitFor(() =>
      expect(sessions[1]?.session.send).toHaveBeenCalledWith("Autre chose", [], expect.any(String)),
    );
    // Les derniers événements de la session fermée ne touchent plus la conversation.
    sessions[0].emit({ type: "status", status: "idle" });
    expect(lastTurn(id).status).toBe("running");
  });

  it("après une erreur, ferme la session et garde la file, comme OneApp", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    await useAgents.getState().send(id, message("Deux"));
    sessions[0].emit({ type: "error", message: "Le modèle a échoué." });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("error"));
    expect(sessions[0].session.close).toHaveBeenCalled();
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["Deux"]);
    expect(conversation(id).turns).toHaveLength(1);
    // Le message suivant part dans une session neuve.
    await useAgents.getState().send(id, message("Trois"));
    await vi.waitFor(() => expect(sessions[1]?.session.send).toHaveBeenCalled());
  });

  it("rend un message retiré de la file", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    await useAgents.getState().send(id, message("Deux"));
    const [queued] = runtime(id).queued;
    expect(useAgents.getState().unqueue(id, queued.id)).toMatchObject({ text: "Deux" });
    expect(runtime(id).queued).toEqual([]);

    sessions[0].emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("done"));
    expect(conversation(id).turns).toHaveLength(1);
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

describe("lot 3 · envoi et file", () => {
  it("refuse un message vide et envoie « Analyse les fichiers joints. » pour des pièces jointes seules", async () => {
    const id = start();
    await expect(useAgents.getState().send(id, message("   "))).rejects.toThrow("Saisissez un message.");
    expect(conversation(id).turns).toEqual([]);

    const file = { path: "/espace/facture.pdf", name: "facture.pdf" };
    await useAgents.getState().send(id, { text: "", attachments: [file], contexts: [] });
    expect(sessions[0].session.send).toHaveBeenCalledWith("Analyse les fichiers joints.", [file], lastTurn(id).id);
    expect(lastTurn(id).user.text).toBe("Analyse les fichiers joints.");
  });

  it("transmet « Applique les références sélectionnées. » pour un message fait de références seules", async () => {
    const id = start();
    await useAgents.getState().send(id, {
      text: "",
      attachments: [],
      contexts: [],
      references: [{ kind: "command", name: "revue", path: "/espace/.claude/commands/revue.md" }],
    } as unknown as UserMessage);
    expect(sessions[0].session.send.mock.calls[0][0]).toMatch(/^Applique les références sélectionnées\./);
  });

  it("ignore un message déjà présent sous le même identifiant", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"), { messageId: "msg-1" });
    await useAgents.getState().send(id, message("Un"), { messageId: "msg-1" });
    expect(conversation(id).turns).toHaveLength(1);
    expect(lastTurn(id).id).toBe("msg-1");
    await useAgents.getState().send(id, message("Deux"), { messageId: "msg-2" });
    await useAgents.getState().send(id, message("Deux"), { messageId: "msg-2" });
    expect(runtime(id).queued.map((item) => item.id)).toEqual(["msg-2"]);
  });

  it("plafonne la file à 50 messages", async () => {
    const id = start();
    await useAgents.getState().send(id, message("En cours"));
    for (let index = 0; index < 50; index += 1) await useAgents.getState().send(id, message(`File ${index}`));
    await expect(useAgents.getState().send(id, message("De trop"))).rejects.toThrow(
      "La file contient déjà 50 messages.",
    );
    expect(runtime(id).queued).toHaveLength(50);
  });

  it("réordonne la file, et ignore un ordre qui ne la reprend pas en entier", async () => {
    const id = start();
    await useAgents.getState().send(id, message("En cours"));
    for (const text of ["A", "B", "C"]) await useAgents.getState().send(id, message(text));
    const ids = runtime(id).queued.map((item) => item.id);
    useAgents.getState().reorderQueued(id, [ids[2], ids[0], ids[1]]);
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["C", "A", "B"]);
    useAgents.getState().reorderQueued(id, [ids[0], ids[1]]);
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["C", "A", "B"]);
    useAgents.getState().moveQueued(id, ids[1], -1);
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["C", "B", "A"]);
    useAgents.getState().moveQueued(id, ids[2], -1);
    expect(runtime(id).queued.map((item) => item.message.text)).toEqual(["C", "B", "A"]);
  });

  it("demande au relevé de se recoller en bas à chaque envoi", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Un"));
    await useAgents.getState().send(id, message("Deux"));
    expect(useAgents.getState().follow[id]).toBe(2);
  });

  it("renvoie un message du fil tel quel, et le met en file pendant une réponse", async () => {
    const id = start();
    const file = { path: "/espace/a.png", name: "a.png" };
    await useAgents.getState().send(id, { text: "Regarde", attachments: [file], contexts: [] });
    const first = lastTurn(id).id;
    await useAgents.getState().resend(id, first);
    expect(runtime(id).queued.map((item) => item.message)).toEqual([
      { text: "Regarde", attachments: [file], contexts: [] },
    ]);
    sessions[0].emit({ type: "status", status: "idle" });
    await vi.waitFor(() => expect(conversation(id).turns).toHaveLength(2));
    expect(lastTurn(id).user).toEqual({ text: "Regarde", attachments: [file], contexts: [] });
    await expect(useAgents.getState().resend(id, "inconnu")).rejects.toThrow("Ce message n’existe plus.");
  });
});

describe("lot 3 · repartir d’ici", () => {
  it("depuis un message : reprend le fil avant lui et rend le message pour la saisie", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    await answeredTurn(id, "Deux", "Réponse deux.");
    const second = conversation(id).turns[1];

    const { id: forkId, draft } = await useAgents.getState().fork(id, second.id, "user");
    expect(draft).toEqual(second.user);
    expect(useAgents.getState().activeId).toBe(forkId);
    expect(conversation(forkId)).toMatchObject({
      title: "Un · reprise",
      started: true,
      forkedFrom: { id, title: "Un" },
      provider: "codex",
      model: "gpt-5",
    });
    expect(conversation(forkId).turns.map((turn) => turn.user.text)).toEqual(["Un"]);
    expect(conversation(forkId).sessionId).toBeUndefined();

    // Sa première session reçoit l’historique, sans reprendre la session du harnais d’origine.
    await useAgents.getState().send(forkId, message("Trois"));
    const live = sessions.at(-1)!;
    expect(live.options.resumeSessionId).toBeUndefined();
    expect(live.options.instructions).toContain("Historique de cette conversation");
    expect(live.options.instructions).toContain("Réponse un.");
    expect(live.options.instructions).not.toContain("Réponse deux.");
    expect(live.options.instructions).not.toContain('"content":"Trois"');
  });

  it("change de harnais en cours de conversation : la session suivante rejoue l’historique, comme OneApp", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    sessions[0].emit({ type: "session", sessionId: "claude-1" });
    await useAgents
      .getState()
      .update(id, { provider: "codex", model: undefined, effort: undefined, sessionId: undefined });
    await useAgents.getState().send(id, message("Deux"));
    const live = sessions.at(-1)!;
    expect(live.options.provider).toBe("codex");
    expect(live.options.resumeSessionId).toBeUndefined();
    expect(live.options.instructions).toContain("Réponse un.");
  });

  it("depuis une réponse : reprend le fil jusqu’à elle", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    await answeredTurn(id, "Deux", "Réponse deux.");
    const { id: forkId, draft } = await useAgents.getState().fork(id, conversation(id).turns[1].id, "reply");
    expect(draft).toBeUndefined();
    expect(conversation(forkId).turns.map((turn) => turn.user.text)).toEqual(["Un", "Deux"]);
  });
});

describe("lot 3 · enregistrement et chargement", () => {
  it("expose l’échec d’enregistrement et l’efface quand un nouvel essai réussit", async () => {
    const id = start();
    let failing = true;
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      commands.push([command, args]);
      if (command === "conversations.save" && failing) throw new Error("disque plein");
      if (command === "space.commit") return { commit: null };
      return null;
    });
    await useAgents.getState().rename(id, "Factures");
    expect(useAgents.getState().saveError).toBe("Les conversations n’ont pas pu être enregistrées : disque plein");
    await expect(useAgents.getState().flush()).rejects.toThrow("disque plein");

    failing = false;
    await useAgents.getState().retrySave();
    expect(useAgents.getState().saveError).toBeUndefined();
    expect(called("conversations.save").at(-1)).toMatchObject({ conversation: { id, title: "Factures" } });
  });

  it("expose l’échec de chargement et n’écrit rien d’ici le nouvel essai", async () => {
    useAgents.setState({ ready: false });
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      commands.push([command, args]);
      if (command === "conversations.list") throw new Error("base verrouillée");
      return null;
    });
    await useAgents.getState().load();
    expect(useAgents.getState()).toMatchObject({
      ready: false,
      loadError:
        "Impossible de charger les conversations enregistrées. Vos données sont conservées ; réessayez le chargement.",
    });
    const id = start();
    await useAgents.getState().rename(id, "Factures");
    expect(called("conversations.save")).toEqual([]);

    native.invoke.mockImplementation(async (command: string) => (command === "conversations.list" ? [] : null));
    await useAgents.getState().retryLoad();
    expect(useAgents.getState()).toMatchObject({ ready: true, loadError: undefined });
  });

  it("refuse un historique mal formé", async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === "conversations.list" ? [{ id: "x", title: 3 }] : null,
    );
    await useAgents.getState().load();
    expect(useAgents.getState().loadError).toMatch(/réessayez le chargement/);
  });

  it("marque arrêté, avec un message, un tour resté en cours à la fermeture", async () => {
    const saved = {
      id: "c1",
      title: "Factures",
      provider: "codex",
      cwd: "/espace",
      autonomy: "ask",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      unread: false,
      started: true,
      turns: [
        {
          id: "t1",
          user: { text: "Fais-le", attachments: [], contexts: [] },
          items: [],
          status: "running",
          startedAt: 1,
        },
      ],
    };
    native.invoke.mockImplementation(async (command: string) => (command === "conversations.get" ? saved : null));
    await useAgents.getState().ensureLoaded("c1");
    expect(lastTurn("c1")).toMatchObject({
      status: "cancelled",
      error: "Cette tâche a été interrompue à la fermeture d’Alfred. Reprenez-la explicitement pour continuer.",
    });
    expect(conversation("c1").lastStatus).toBe("cancelled");
  });

  it("n’ouvre pas une conversation enregistrée mal formée", async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === "conversations.get" ? { id: "c2", title: "X", turns: "rien" } : null,
    );
    await useAgents.getState().ensureLoaded("c2");
    expect(useAgents.getState().loaded.c2).toBeUndefined();
    expect(useAgents.getState().loadError).toMatch(/invalide/);
  });

  it("rouvre la conversation retenue pour la session, sinon la plus récente", async () => {
    const header = (id: string, createdAt: number) => ({
      id,
      title: id,
      provider: "codex",
      cwd: "/espace",
      autonomy: "ask",
      createdAt,
      updatedAt: createdAt,
      archived: false,
      unread: false,
      started: true,
    });
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "conversations.list") return [header("ancienne", 1), header("recente", 5)];
      if (command === "conversations.get") return { ...header(String(args?.id), 1), turns: [] };
      return null;
    });
    sessionStorage.removeItem("alfred.agents.selected");
    await useAgents.getState().load();
    expect(useAgents.getState().activeId).toBe("recente");

    await useAgents.getState().open("ancienne");
    useAgents.setState({ activeId: null });
    await useAgents.getState().load();
    expect(useAgents.getState().activeId).toBe("ancienne");
  });
});

describe("lot 3 · sessions", () => {
  it("rattrape une reprise refusée par une session neuve qui rejoue l’historique", async () => {
    const id = start();
    const first = await answeredTurn(id, "Un", "Réponse un.");
    first.emit({ type: "session", sessionId: "thr_1" });
    useAgents.getState().update(id, { model: "gpt-5-mini" });
    const realCreate = vi.mocked(createSession).getMockImplementation()!;
    vi.mocked(createSession).mockImplementationOnce(async () => {
      throw new Error("thread introuvable");
    });
    await useAgents.getState().send(id, message("Deux"));
    expect(vi.mocked(createSession).mock.calls.at(-2)?.[0].resumeSessionId).toBe("thr_1");
    const fresh = sessions.at(-1)!;
    expect(fresh.options.resumeSessionId).toBeUndefined();
    expect(fresh.options.instructions).toContain("Réponse un.");
    expect(fresh.session.send).toHaveBeenCalledWith("Deux", [], lastTurn(id).id);
    expect(conversation(id).sessionId).toBeUndefined();
    vi.mocked(createSession).mockImplementation(realCreate);
  });

  it("Claude Code qui refuse la reprise au premier message : session neuve et même message renvoyé", async () => {
    const id = start({ provider: "claude", model: "opus" });
    const first = await answeredTurn(id, "Un", "Réponse un.");
    first.emit({ type: "session", sessionId: "sess_1" });
    useAgents.getState().update(id, { model: "sonnet" });
    await useAgents.getState().send(id, message("Deux"));
    const resumed = sessions.at(-1)!;
    expect(resumed.options.resumeSessionId).toBe("sess_1");
    resumed.emit({ type: "error", message: "Claude Code s’est arrêté : No conversation found with session ID" });
    resumed.emit({ type: "status", status: "closed" });
    await vi.waitFor(() => expect(sessions).toHaveLength(3));
    const fresh = sessions[2];
    expect(fresh.options.resumeSessionId).toBeUndefined();
    expect(fresh.options.instructions).toContain("Réponse un.");
    await vi.waitFor(() => expect(fresh.session.send).toHaveBeenCalledWith("Deux", [], lastTurn(id).id));
    expect(lastTurn(id)).toMatchObject({ status: "running" });
    expect(lastTurn(id).error).toBeUndefined();
  });

  it("libère le CLI d’une conversation au repos depuis 10 min, puis le rouvre au message suivant", async () => {
    const id = start();
    const first = await answeredTurn(id, "Un", "Réponse un.");
    first.emit({ type: "session", sessionId: "thr_1" });
    expect(await releaseIdleAgentSessions(10 * 60_000, Date.now() + 60_000)).toBe(0);
    expect(await releaseIdleAgentSessions(10 * 60_000, Date.now() + 10 * 60_000)).toBe(1);
    expect(first.session.close).toHaveBeenCalled();
    await useAgents.getState().send(id, message("Deux"));
    expect(sessions).toHaveLength(2);
    expect(sessions[1].options.resumeSessionId).toBe("thr_1");
  });

  it("donne à chaque session la consigne du bloc de question", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Bonjour"));
    expect(sessions[0].options.instructions).toContain("bloc de code de langage alfred-question");
  });
});

describe("lot 3 · flux d’une réponse", () => {
  it("borne la sortie d’une activité à 32 000 caractères en gardant la fin", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Lance"));
    sessions[0].emit({ type: "activity", itemId: "c", kind: "command", title: "Commande", status: "running" });
    sessions[0].emit({ type: "activityDelta", itemId: "c", content: `${"a".repeat(40_000)}FIN` });
    flushAgentUpdates();
    const item = lastTurn(id).items[0] as { content: string };
    expect(item.content).toHaveLength(32_000);
    expect(item.content.startsWith("[… début de la sortie omis …]\n")).toBe(true);
    expect(item.content.endsWith("FIN")).toBe(true);
  });

  it("annonce le premier fragment tout de suite et regroupe les suivants", async () => {
    vi.useFakeTimers();
    try {
      const id = start();
      await useAgents.getState().send(id, message("Bonjour"));
      sessions[0].emit({ type: "message", itemId: "m", content: "Bon" });
      expect(lastTurn(id).items).toEqual([{ kind: "message", id: "m", content: "Bon" }]);
      sessions[0].emit({ type: "message", itemId: "m", content: "jour" });
      sessions[0].emit({ type: "message", itemId: "m", content: " !" });
      expect(lastTurn(id).items).toEqual([{ kind: "message", id: "m", content: "Bon" }]);
      vi.advanceTimersByTime(120);
      expect(lastTurn(id).items).toEqual([{ kind: "message", id: "m", content: "Bonjour !" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arrête un tour muet depuis 3 min au milieu de sa réponse", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Bonjour"));
    sessions[0].emit({ type: "status", status: "responding" });
    sessions[0].emit({ type: "message", itemId: "m", content: "Je commence" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60_000);
    try {
      checkAgentSilence();
      expect(lastTurn(id).status).toBe("running");
      clock.mockReturnValue(now + 4 * 60_000);
      checkAgentSilence();
      await vi.waitFor(() => expect(lastTurn(id).status).toBe("error"));
      expect(lastTurn(id).error).toBe(
        "Le CLI ne donne plus signe de vie depuis 4 min au milieu de sa réponse. Le tour a été arrêté ; relancez la tâche.",
      );
      expect(sessions[0].session.close).toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("laisse travailler sans limite une commande en cours", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Compile"));
    sessions[0].emit({ type: "activity", itemId: "c", kind: "command", title: "Commande", status: "running" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    try {
      checkAgentSilence();
      expect(lastTurn(id).status).toBe("running");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("lot 3 · titres, archives, notifications", () => {
  it("limite le titre à 80 caractères et retire le nommage automatique au renommage", async () => {
    const id = start();
    await useAgents
      .getState()
      .send(id, message(`Une demande dont la première ligne est bien trop longue pour un titre ${"x".repeat(40)}`));
    expect(conversation(id).title.endsWith("…")).toBe(true);
    expect(conversation(id).autoTitle).toBe(true);
    await useAgents.getState().rename(id, "y".repeat(120));
    expect(conversation(id).title).toHaveLength(80);
    expect(conversation(id).autoTitle).toBeUndefined();
  });

  it("ne confie pas au nommage un titre déjà parlant", async () => {
    const id = start();
    await useAgents.getState().send(id, message("Page Factures"));
    expect(conversation(id).autoTitle).toBeUndefined();
  });

  it("note la date d’archivage et l’efface à la restauration", async () => {
    const id = start();
    await answeredTurn(id, "Un", "Réponse un.");
    useAgents.getState().update(id, { unread: true });
    await useAgents.getState().archive(id);
    expect(conversation(id)).toMatchObject({ archived: true, unread: false, archivedAt: expect.any(Number) });
    await useAgents.getState().unarchive(id);
    expect(conversation(id).archived).toBe(false);
    expect("archivedAt" in conversation(id)).toBe(false);
  });

  it("une notification par tour, avec « Ouvrir » qui affiche la conversation", async () => {
    const { useNotifications } = await import("../../shell/notifications");
    useNotifications.setState({ items: [], toasts: [] });
    const id = start();
    useShell.setState({ view: { kind: "settings" } });
    await useAgents.getState().send(id, message("Bonjour"));
    sessions[0].emit({ type: "message", itemId: "m", content: "Fait.", replace: true });
    sessions[0].emit({ type: "status", status: "idle" });
    sessions[0].emit({ type: "status", status: "closed" });
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("done"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tone: "success", action: { label: "Ouvrir" } });
    items[0].action!.run();
    await vi.waitFor(() => expect(useShell.getState().view).toEqual({ kind: "agent" }));
    expect(useAgents.getState().activeId).toBe(id);
  });

  it("une demande d’accord reste affichée, avec « Répondre »", async () => {
    const { useNotifications } = await import("../../shell/notifications");
    useNotifications.setState({ items: [], toasts: [] });
    vi.useFakeTimers();
    try {
      const id = start();
      useShell.setState({ view: { kind: "settings" } });
      await useAgents.getState().send(id, message("Nettoie"));
      const request = { id: "a1", title: "Supprimer dist", options: [] };
      sessions[0].emit({ type: "approval", request });
      sessions[0].emit({ type: "approval", request: { ...request, id: "a2" } });
      expect(useNotifications.getState().items).toHaveLength(1);
      expect(useNotifications.getState().items[0]).toMatchObject({ tone: "warning", action: { label: "Répondre" } });
      vi.advanceTimersByTime(10_000);
      expect(useNotifications.getState().toasts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un tour arrêté non lu est annoncé comme un échec", async () => {
    const { useNotifications } = await import("../../shell/notifications");
    useNotifications.setState({ items: [], toasts: [] });
    const id = start();
    useShell.setState({ view: { kind: "settings" } });
    await useAgents.getState().send(id, message("Long travail"));
    sessions[0].session.cancel.mockImplementation(async () => sessions[0].emit({ type: "status", status: "idle" }));
    await useAgents.getState().cancel(id);
    await vi.waitFor(() => expect(lastTurn(id).status).toBe("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useNotifications.getState().items[0]).toMatchObject({
      tone: "error",
      title: "Long travail : je me suis arrêté",
    });
  });
});
