/**
 * Conversations d’agents : liste, relevé de chaque tour et session vivante dans le harnais. Les sessions restent
 * ouvertes d’un message à l’autre ; changer de harnais, de modèle ou d’autonomie en rouvre une au message suivant.
 */
import { create } from "zustand";
import { invoke, onNativeEvent } from "../../lib/native";
import type { Commit } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import {
  type ApprovalRequest,
  type Autonomy,
  createSession,
  type HarnessEvent,
  type HarnessSession,
  PROVIDER_LABEL,
  type Provider,
} from "./harness";
import {
  type AgentQuestion,
  type Conversation,
  type ConversationHeader,
  type ConversationRuntime,
  compactForStorage,
  conversationTitle,
  lastAssistantText,
  outgoingText,
  plainText,
  type Turn,
  type TurnItem,
  turnCommitMessage,
  type UserMessage,
} from "./model";
import { notifySystem } from "./systemNotification";

export interface AgentDefaults {
  provider: Provider;
  autonomy: Autonomy;
  /** Modèle et effort retenus pour chaque harnais. */
  models: Partial<Record<Provider, { model?: string; effort?: string }>>;
}

const DEFAULTS: AgentDefaults = { provider: "claude", autonomy: "ask", models: {} };
const idleRuntime: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

export interface NewConversation {
  provider?: Provider;
  model?: string;
  effort?: string;
  cwd?: string;
  autonomy?: Autonomy;
  title?: string;
  origin?: Conversation["origin"];
}

interface AgentState {
  headers: ConversationHeader[];
  loaded: Record<string, Conversation>;
  runtime: Record<string, ConversationRuntime>;
  activeId: string | null;
  defaults: AgentDefaults;
  ready: boolean;
  load: () => Promise<void>;
  setDefaults: (defaults: AgentDefaults) => Promise<void>;
  open: (id: string | null) => Promise<void>;
  /** Charge une conversation sans en faire la conversation ouverte de la page Agent. */
  ensureLoaded: (id: string) => Promise<void>;
  create: (options?: NewConversation) => Conversation;
  update: (id: string, patch: Partial<ConversationHeader>) => void;
  /** Nouveau titre ; vide, l’ancien est gardé. */
  rename: (id: string, title: string) => Promise<void>;
  /** Masque la conversation de la liste sans rien effacer ; une réponse en cours est arrêtée. */
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  markUnread: (id: string) => Promise<void>;
  /** Pendant une réponse, le message attend dans la file de la conversation et part à la fin du tour. */
  send: (id: string, message: UserMessage) => Promise<void>;
  /** Retire un message de la file et le rend, pour le remettre dans la saisie. */
  unqueue: (id: string, queuedId: string) => UserMessage | undefined;
  cancel: (id: string) => Promise<void>;
  answerApproval: (id: string, approvalId: string, optionId: string) => Promise<void>;
  answerQuestion: (id: string, requestId: string, result: unknown, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  undoTurn: (id: string, turnId: string) => Promise<void>;
}

type Live = { session: HarnessSession; signature: string };
const sessions = new Map<string, Live>();
/**
 * Génération de la session vivante de chaque conversation. Fermer une session pour en ouvrir une autre (modèle ou
 * autonomie changés) ne doit pas terminer le tour en cours : ses derniers événements sont ignorés.
 */
const generations = new Map<string, number>();
const nextGeneration = (id: string) => {
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  return generation;
};
/** Attentes de fin de tour, pour les pages qui lancent un agent et en attendent la réponse. */
const turnWaiters = new Map<string, Array<(turn: Turn) => void>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Tours en train de se terminer : deux signaux de fin rapprochés ne doivent donner qu’un commit. */
const finishing = new Set<string>();
/** Conversations dont l’utilisateur a demandé l’interruption : le prochain tour terminé est « annulé ». */
const cancelRequested = new Set<string>();

const newId = () => crypto.randomUUID();

function signature(conversation: Conversation) {
  return [conversation.provider, conversation.model, conversation.effort, conversation.autonomy, conversation.cwd].join(
    "|",
  );
}

/** Consignes données au harnais, hors du fil : où est l’espace et où lire les règles de construction. */
function instructions(spaceDir: string) {
  return [
    "Tu travailles dans Alfred, une application de bureau que l’utilisateur construit avec toi.",
    `Son espace est le dossier ${spaceDir} : pages, panneaux, fonctions et clients y sont rangés par module.`,
    // Le séparateur du dossier est repris : un chemin Windows reste en barres inverses.
    `Avant de créer ou de modifier quoi que ce soit dans l’espace, lis ${spaceDir}${spaceDir.includes("\\") ? "\\" : "/"}AGENTS.md et suis-le.`,
    "Les outils « alfred » servent à placer une page, vérifier qu’elle compile, lire ses erreurs et interroger la base.",
    "Réponds en français.",
  ].join("\n");
}

function withoutTurns(conversation: Conversation): ConversationHeader {
  const { turns: _turns, ...header } = conversation;
  return header;
}

export const useAgents = create<AgentState>((set, get) => {
  const patchConversation = (id: string, change: (conversation: Conversation) => Conversation) => {
    const current = get().loaded[id];
    if (!current) return;
    const next = change(current);
    set((state) => ({
      loaded: { ...state.loaded, [id]: next },
      headers: state.headers.map((header) => (header.id === id ? withoutTurns(next) : header)),
    }));
    scheduleSave(id);
  };

  const patchTurn = (id: string, change: (turn: Turn) => Turn) =>
    patchConversation(id, (conversation) => {
      const turns = [...conversation.turns];
      const last = turns.at(-1);
      if (!last) return conversation;
      turns[turns.length - 1] = change(last);
      return { ...conversation, turns };
    });

  const patchRuntime = (id: string, change: (runtime: ConversationRuntime) => ConversationRuntime) =>
    set((state) => ({ runtime: { ...state.runtime, [id]: change(state.runtime[id] ?? idleRuntime) } }));

  const save = async (id: string) => {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const conversation = get().loaded[id];
    if (!conversation) return;
    try {
      await invoke("conversations.save", { conversation: compactForStorage(conversation) });
    } catch (error) {
      notify({
        title: "Conversation non enregistrée",
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  function scheduleSave(id: string) {
    if (saveTimers.has(id)) return;
    saveTimers.set(
      id,
      setTimeout(() => void save(id), 1500),
    );
  }

  const upsertItem = (items: TurnItem[], item: TurnItem): TurnItem[] => {
    const index = items.findIndex((candidate) => candidate.id === item.id && candidate.kind === item.kind);
    if (index < 0) return [...items, item];
    const next = [...items];
    next[index] = item;
    return next;
  };

  const finishTurn = async (id: string, status: Turn["status"]) => {
    const conversation = get().loaded[id];
    const turn = conversation?.turns.at(-1);
    if (!conversation || !turn || turn.status !== "running" || finishing.has(turn.id)) return;
    finishing.add(turn.id);
    if (cancelRequested.delete(id) && status === "done") status = "cancelled";
    patchRuntime(id, (runtime) => ({ ...runtime, status: "idle", approvals: [], questions: [] }));
    // Ce que l’agent a écrit dans l’espace devient un commit : c’est ce qui rend le tour annulable.
    let commit: string | undefined;
    let changedFiles: string[] | undefined;
    let changedLines: Turn["changedLines"];
    try {
      const result = await invoke<{ commit: string | null }>("space.commit", {
        message: turnCommitMessage(conversation.title, turn.user.text),
      });
      if (result.commit) {
        commit = result.commit;
        const [latest] = await invoke<Commit[]>("space.history", { limit: 1 });
        if (latest?.id === commit) {
          changedFiles = latest.files;
          changedLines = Object.fromEntries(
            latest.files.flatMap((file, index) => {
              const lines = latest.lines?.[index];
              return lines ? [[file, lines]] : [];
            }),
          );
        }
      }
    } catch {
      // Un espace sans dépôt utilisable n’empêche pas la conversation de se terminer.
    }
    const viewed = get().activeId === id && useShell.getState().view.kind === "agent";
    patchConversation(id, (current) => {
      const turns = [...current.turns];
      const last = turns.at(-1);
      if (!last) return current;
      const finished = {
        ...last,
        status,
        endedAt: Date.now(),
        ...(commit ? { commit, changedFiles, changedLines } : {}),
      };
      turns[turns.length - 1] = finished;
      return {
        ...current,
        turns,
        updatedAt: Date.now(),
        unread: !viewed,
        preview: plainText(lastAssistantText(finished)).slice(0, 200) || current.preview,
      };
    });
    await save(id);
    const finished = get().loaded[id]?.turns.at(-1);
    if (finished) {
      for (const resolve of turnWaiters.get(id) ?? []) resolve(finished);
      turnWaiters.delete(id);
    }
    // Le message suivant de la file part aussitôt : seule la fin du dernier tour est annoncée.
    const [next, ...rest] = get().runtime[id]?.queued ?? [];
    if (next && (get().runtime[id]?.status ?? "idle") === "idle") {
      patchRuntime(id, (runtime) => ({ ...runtime, queued: rest }));
      void get()
        .send(id, next.message)
        .catch(() => undefined);
      return;
    }
    if (finished && status !== "cancelled") {
      const title = get().loaded[id]?.title ?? "L’agent";
      void notifySystem(
        status === "error" ? `${title} : l’agent a rencontré une erreur` : `${title} : l’agent a terminé`,
        plainText(lastAssistantText(finished)) || undefined,
      );
    }
    if (!viewed && finished) {
      notify({
        title: status === "error" ? `${conversation.title} : l’agent s’est arrêté sur une erreur` : conversation.title,
        description: finished.error ?? plainText(lastAssistantText(finished)).slice(0, 160),
        tone: status === "error" ? "error" : "info",
        source: PROVIDER_LABEL[conversation.provider],
      });
    }
  };

  const onEvent = (id: string, generation: number) => (event: HarnessEvent) => {
    if (generations.get(id) !== generation) return;
    switch (event.type) {
      case "session":
        patchConversation(id, (conversation) => ({ ...conversation, sessionId: event.sessionId }));
        return;
      case "status":
        if (event.status === "responding" || event.status === "connecting")
          patchRuntime(id, (runtime) => ({
            ...runtime,
            status: event.status === "connecting" ? "connecting" : "responding",
          }));
        else if (event.status === "idle") {
          const turn = get().loaded[id]?.turns.at(-1);
          void finishTurn(id, turn?.error ? "error" : "done");
        } else if (event.status === "closed") {
          sessions.delete(id);
          void finishTurn(id, "error");
          patchRuntime(id, (runtime) => ({ ...runtime, status: "idle" }));
        }
        return;
      case "message":
        patchTurn(id, (turn) => {
          const existing = turn.items.find((item) => item.kind === "message" && item.id === event.itemId);
          const content =
            event.replace || !existing ? event.content : (existing as { content: string }).content + event.content;
          return { ...turn, items: upsertItem(turn.items, { kind: "message", id: event.itemId, content }) };
        });
        return;
      case "activity":
        patchTurn(id, (turn) => {
          const previous = turn.items.find((item) => item.kind === "activity" && item.id === event.itemId);
          const kept = previous?.kind === "activity" ? previous : undefined;
          return {
            ...turn,
            items: upsertItem(turn.items, {
              kind: "activity",
              id: event.itemId,
              activityKind: event.kind,
              title: event.title,
              detail: event.detail ?? kept?.detail,
              actions: event.actions ?? kept?.actions,
              content: event.content ?? kept?.content,
              images: event.images ?? kept?.images,
              files: event.files ?? kept?.files,
              status: event.status,
            }),
          };
        });
        return;
      case "activityDelta":
        patchTurn(id, (turn) => {
          const previous = turn.items.find((item) => item.kind === "activity" && item.id === event.itemId);
          const base: Extract<TurnItem, { kind: "activity" }> =
            previous?.kind === "activity"
              ? previous
              : { kind: "activity", id: event.itemId, activityKind: "analysis", title: "Analyse", status: "running" };
          return { ...turn, items: upsertItem(turn.items, { ...base, content: (base.content ?? "") + event.content }) };
        });
        return;
      case "approval":
        patchRuntime(id, (runtime) => ({ ...runtime, approvals: [...runtime.approvals, event.request] }));
        void notifySystem(`${get().loaded[id]?.title ?? "Un agent"} attend votre accord`, event.request.title);
        if (get().activeId !== id || useShell.getState().view.kind !== "agent") {
          notify({
            title: `${get().loaded[id]?.title ?? "Un agent"} attend votre accord`,
            description: event.request.title,
            tone: "warning",
          });
        }
        return;
      case "approvalClosed":
        patchRuntime(id, (runtime) => ({
          ...runtime,
          approvals: runtime.approvals.filter((approval: ApprovalRequest) => approval.id !== event.id),
        }));
        return;
      case "error":
        patchTurn(id, (turn) => ({ ...turn, error: event.message }));
        return;
    }
  };

  const ensureSession = async (conversation: Conversation): Promise<HarnessSession> => {
    const live = sessions.get(conversation.id);
    const wanted = signature(conversation);
    if (live && live.signature === wanted) return live.session;
    const generation = nextGeneration(conversation.id);
    if (live) {
      sessions.delete(conversation.id);
      await live.session.close().catch(() => undefined);
    }
    const shell = useShell.getState();
    const spaceDir = shell.snapshot?.path;
    const session = await createSession({
      provider: conversation.provider,
      cwd: conversation.cwd,
      spaceDir,
      conversation: conversation.id,
      toolsUrl: shell.info ? `http://127.0.0.1:${shell.info.serverPort}/mcp` : undefined,
      model: conversation.model,
      effort: conversation.effort,
      instructions: spaceDir ? instructions(spaceDir) : undefined,
      resumeSessionId: conversation.sessionId,
      autonomy: conversation.autonomy,
      title: conversation.title,
      onEvent: onEvent(conversation.id, generation),
    });
    sessions.set(conversation.id, { session, signature: wanted });
    return session;
  };

  return {
    headers: [],
    loaded: {},
    runtime: {},
    activeId: null,
    defaults: DEFAULTS,
    ready: false,

    async load() {
      const [headers, defaults] = await Promise.all([
        invoke<ConversationHeader[]>("conversations.list"),
        invoke<AgentDefaults | null>("settings.get", { key: "agents.defaults" }),
      ]);
      set((state) => {
        const known = new Set(headers.map((header) => header.id));
        const unsaved = Object.values(state.loaded)
          .filter((conversation) => !known.has(conversation.id))
          .map(withoutTurns);
        return { headers: [...unsaved, ...headers], defaults: { ...DEFAULTS, ...(defaults ?? {}) }, ready: true };
      });
    },

    async setDefaults(defaults) {
      set({ defaults });
      await invoke("settings.set", { key: "agents.defaults", value: defaults });
    },

    async open(id) {
      set({ activeId: id });
      if (!id) return;
      await get().ensureLoaded(id);
      if (get().loaded[id]?.unread) patchConversation(id, (conversation) => ({ ...conversation, unread: false }));
    },

    async ensureLoaded(id) {
      if (!get().loaded[id]) {
        const conversation = await invoke<Conversation | null>("conversations.get", { id });
        if (!conversation) return;
        // Un tour resté « en cours » vient d’une fermeture d’Alfred au milieu d’une réponse.
        const turns = conversation.turns.map((turn) =>
          turn.status === "running"
            ? { ...turn, status: "cancelled" as const, endedAt: turn.endedAt ?? Date.now() }
            : turn,
        );
        set((state) => ({ loaded: { ...state.loaded, [id]: { ...conversation, turns } } }));
      }
    },

    create(options = {}) {
      const { defaults } = get();
      const provider = options.provider ?? defaults.provider;
      const preset = defaults.models[provider] ?? {};
      const now = Date.now();
      const conversation: Conversation = {
        id: newId(),
        title: options.title ?? "Nouvelle conversation",
        provider,
        model: options.model ?? preset.model,
        effort: options.effort ?? preset.effort,
        cwd: options.cwd ?? useShell.getState().snapshot?.path ?? "",
        autonomy: options.autonomy ?? defaults.autonomy,
        createdAt: now,
        updatedAt: now,
        archived: false,
        unread: false,
        started: false,
        ...(options.origin ? { origin: options.origin } : {}),
        turns: [],
      };
      set((state) => ({
        loaded: { ...state.loaded, [conversation.id]: conversation },
        headers: [withoutTurns(conversation), ...state.headers],
      }));
      return conversation;
    },

    update(id, patch) {
      patchConversation(id, (conversation) => ({ ...conversation, ...patch }));
    },

    async rename(id, title) {
      const next = title.trim().slice(0, 120);
      if (!next) return;
      await get().ensureLoaded(id);
      patchConversation(id, (conversation) => ({ ...conversation, title: next }));
      await save(id);
    },

    async archive(id) {
      await get().ensureLoaded(id);
      patchRuntime(id, (runtime) => ({ ...runtime, queued: [] }));
      if ((get().runtime[id]?.status ?? "idle") !== "idle") await get().cancel(id);
      patchConversation(id, (conversation) => ({ ...conversation, archived: true }));
      if (get().activeId === id) set({ activeId: null });
      await save(id);
    },

    async unarchive(id) {
      await get().ensureLoaded(id);
      // Rendue visible sans être signalée « à consulter », comme dans OneApp.
      patchConversation(id, (conversation) => ({ ...conversation, archived: false, unread: false }));
      await save(id);
    },

    async markUnread(id) {
      await get().ensureLoaded(id);
      patchConversation(id, (conversation) => ({ ...conversation, unread: true }));
      await save(id);
      // La conversation ouverte se lirait aussitôt : la page Agent passe à une autre, ou à un brouillon.
      if (get().activeId === id) {
        const other = get().headers.find((header) => header.id !== id && header.started && !header.archived);
        await get().open(other?.id ?? get().create().id);
      }
    },

    async send(id, message) {
      const conversation = get().loaded[id];
      if (!conversation) return;
      const busy = (get().runtime[id]?.status ?? "idle") !== "idle" || conversation.turns.at(-1)?.status === "running";
      if (busy) {
        patchRuntime(id, (runtime) => ({ ...runtime, queued: [...runtime.queued, { id: newId(), message }] }));
        return;
      }
      const first = conversation.turns.length === 0;
      const turn: Turn = { id: newId(), user: message, items: [], status: "running", startedAt: Date.now() };
      patchConversation(id, (current) => ({
        ...current,
        title: first && current.title === "Nouvelle conversation" ? conversationTitle(message.text) : current.title,
        turns: [...current.turns, turn],
        started: true,
        updatedAt: Date.now(),
      }));
      patchRuntime(id, (runtime) => ({ ...runtime, status: "connecting" }));
      try {
        const session = await ensureSession(get().loaded[id] ?? conversation);
        await session.send(outgoingText(message), message.attachments, turn.id);
      } catch (error) {
        patchTurn(id, (current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
        await finishTurn(id, "error");
      }
    },

    unqueue(id, queuedId) {
      const found = get().runtime[id]?.queued.find((item) => item.id === queuedId);
      if (found)
        patchRuntime(id, (runtime) => ({ ...runtime, queued: runtime.queued.filter((item) => item.id !== queuedId) }));
      return found?.message;
    },

    async cancel(id) {
      if (get().loaded[id]?.turns.at(-1)?.status === "running") cancelRequested.add(id);
      const live = sessions.get(id);
      await live?.session.cancel().catch(() => undefined);
      // Un harnais qui ne confirme pas l’interruption ne doit pas laisser le tour bloqué.
      setTimeout(() => {
        if (get().loaded[id]?.turns.at(-1)?.status === "running") void finishTurn(id, "cancelled");
      }, 4000);
    },

    async answerApproval(id, approvalId, optionId) {
      patchRuntime(id, (runtime) => ({
        ...runtime,
        approvals: runtime.approvals.filter((approval) => approval.id !== approvalId),
      }));
      await sessions.get(id)?.session.answer(approvalId, optionId);
    },

    async answerQuestion(id, requestId, result, error) {
      patchRuntime(id, (runtime) => ({
        ...runtime,
        questions: runtime.questions.filter((question) => question.requestId !== requestId),
      }));
      await invoke("ui.resolve", error ? { requestId, error } : { requestId, result });
    },

    async remove(id) {
      patchRuntime(id, (runtime) => ({ ...runtime, queued: [] }));
      const live = sessions.get(id);
      sessions.delete(id);
      nextGeneration(id);
      await live?.session.close().catch(() => undefined);
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      await invoke("conversations.delete", { id });
      set((state) => {
        const { [id]: _removed, ...loaded } = state.loaded;
        return {
          loaded,
          headers: state.headers.filter((header) => header.id !== id),
          activeId: state.activeId === id ? null : state.activeId,
        };
      });
    },

    async undoTurn(id, turnId) {
      const turn = get().loaded[id]?.turns.find((candidate) => candidate.id === turnId);
      if (!turn?.commit) return;
      await invoke("space.undo", { commit: turn.commit });
      patchConversation(id, (conversation) => ({
        ...conversation,
        turns: conversation.turns.map((candidate) =>
          candidate.id === turnId
            ? { ...candidate, commit: undefined, changedFiles: undefined, changedLines: undefined }
            : candidate,
        ),
      }));
      notify({
        title: "Modification annulée",
        description: "L’espace est revenu à son état d’avant ce tour.",
        tone: "success",
      });
    },
  };
});

/** Résout quand le tour en cours de la conversation se termine. */
export function waitForTurn(id: string): Promise<Turn> {
  return new Promise((resolve) => {
    turnWaiters.set(id, [...(turnWaiters.get(id) ?? []), resolve]);
  });
}

let questionsBound = false;

/** Relie les questions posées par les outils d’Alfred (emplacement d’une page) à leur conversation. */
export function bindAgentQuestions() {
  if (questionsBound) return;
  questionsBound = true;
  onNativeEvent("agent:question", (payload) => {
    const question = payload as {
      requestId: string;
      conversation: string;
      kind: AgentQuestion["kind"];
      payload: Record<string, unknown>;
    };
    const title = useAgents.getState().loaded[question.conversation]?.title ?? "Un agent";
    void notifySystem(
      `${title} attend votre réponse`,
      question.kind === "placement" ? "Où placer la nouvelle page ?" : undefined,
    );
    useAgents.setState((state) => {
      const runtime = state.runtime[question.conversation] ?? idleRuntime;
      return {
        runtime: {
          ...state.runtime,
          [question.conversation]: {
            ...runtime,
            questions: [
              ...runtime.questions,
              { requestId: question.requestId, kind: question.kind, payload: question.payload },
            ],
          },
        },
      };
    });
    const { activeId, loaded } = useAgents.getState();
    if (activeId !== question.conversation || useShell.getState().view.kind !== "agent") {
      notify({
        title: `${loaded[question.conversation]?.title ?? "Un agent"} a une question`,
        description: "Ouvrir la conversation pour lui répondre.",
        tone: "warning",
      });
    }
  });
  // Une question tranchée ailleurs (autre fenêtre, délai dépassé) disparaît de toutes les conversations.
  onNativeEvent("ui:resolved", (payload) => {
    const { requestId } = payload as { requestId: string };
    useAgents.setState((state) => {
      const runtime = Object.fromEntries(
        Object.entries(state.runtime).map(([id, current]) => [
          id,
          current.questions.some((question) => question.requestId === requestId)
            ? { ...current, questions: current.questions.filter((question) => question.requestId !== requestId) }
            : current,
        ]),
      );
      return { runtime };
    });
  });
}
