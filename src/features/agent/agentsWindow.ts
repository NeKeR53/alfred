/**
 * Fenêtre Agent détachée : la page Agent seule, dans une deuxième fenêtre. Elle affiche et pilote les conversations
 * sans les reprendre à la fenêtre principale, qui reste leur propriétaire : c’est elle qui garde les sessions
 * (pilotées par Rust), enregistre les conversations et fait tourner les suivis et la délégation.
 *
 * - La fenêtre principale publie l’état des conversations (en-têtes, état d’exécution, conversations chargées, celles
 *   qui ont changé seulement) et exécute les actions que la fenêtre détachée lui envoie.
 * - Dans la fenêtre détachée, le magasin `useAgents` devient un miroir : son état vient de la principale, ses actions
 *   y sont transmises. Seule la conversation ouverte lui est propre : ouvrir une conversation ici ne change pas celle
 *   de la fenêtre principale.
 *
 * Le transport passe par les événements Tauri d’une fenêtre à l’autre ; hors de Tauri (navigateur de test, pont de
 * développement), par un `BroadcastChannel`.
 */
import { inTauri, toError } from "../../lib/native";
import type { Conversation } from "./model";
import { useAgents } from "./store";

/** Libellé de la fenêtre (`src-tauri/src/agents/window.rs`) : celui d’une fenêtre de page, pour en avoir les droits. */
export const AGENTS_WINDOW_LABEL = "page-agents";
const STATE_EVENT = "agents-window:state";
const ACTION_EVENT = "agents-window:action";
const REPLY_EVENT = "agents-window:reply";
const HELLO_EVENT = "agents-window:hello";
/** Rythme maximal des publications : une réponse diffusée ne doit pas inonder la deuxième fenêtre. */
const PUBLISH_MS = 60;

/** Cette fenêtre est-elle la fenêtre Agent détachée (posée par Rust avant le chargement) ? */
export function isAgentsWindow(): boolean {
  return (window as { __ALFRED_AGENTS_WINDOW__?: unknown }).__ALFRED_AGENTS_WINDOW__ === true;
}

type State = ReturnType<typeof useAgents.getState>;
type Message = { name: string; payload: unknown };

/** Clés d’état recopiées dans le miroir ; `activeId` reste propre à chaque fenêtre. */
const SHARED_KEYS = ["headers", "runtime", "defaults", "titling", "ready", "loadError", "saveError", "follow"] as const;

export interface StatePatch {
  shared: Partial<Pick<State, (typeof SHARED_KEYS)[number]>>;
  /** Conversations chargées qui ont changé depuis la dernière publication. */
  loaded: Record<string, Conversation>;
  /** Conversations qui ne sont plus chargées. */
  removed: string[];
  /** Publication complète : le miroir remplace tout. */
  full?: boolean;
}

export interface Transport {
  send(name: string, payload: unknown): void;
  listen(handler: (message: Message) => void): () => void;
}

/** Transport de la fenêtre courante vers l’autre fenêtre (`target`). */
async function windowTransport(target: string): Promise<Transport> {
  if (inTauri) {
    const { emitTo } = await import("@tauri-apps/api/event");
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    // Seuls les événements adressés à cette fenêtre : pas ceux qu’elle envoie à l’autre.
    const current = getCurrentWebviewWindow();
    const listen = current.listen.bind(current);
    const stops: Array<() => void> = [];
    return {
      send: (name, payload) => void emitTo(target, name, payload).catch(() => undefined),
      listen: (handler) => {
        let stopped = false;
        for (const name of [STATE_EVENT, ACTION_EVENT, REPLY_EVENT, HELLO_EVENT])
          void listen(name, (event) => handler({ name, payload: event.payload })).then((stop) =>
            stopped ? stop() : stops.push(stop),
          );
        return () => {
          stopped = true;
          for (const stop of stops.splice(0)) stop();
        };
      },
    };
  }
  const channel = new BroadcastChannel("alfred-agents-window");
  return {
    send: (name, payload) => channel.postMessage({ name, payload }),
    listen: (handler) => {
      const listener = (event: MessageEvent<Message>) => handler(event.data);
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
  };
}

/** Ce qui a changé dans l’état depuis `previous` (comparaison par référence, comme zustand). */
export function diffState(state: State, previous: State | undefined): StatePatch {
  const shared: StatePatch["shared"] = {};
  for (const key of SHARED_KEYS)
    if (!previous || state[key] !== previous[key]) Object.assign(shared, { [key]: state[key] });
  const loaded: Record<string, Conversation> = {};
  for (const [id, conversation] of Object.entries(state.loaded))
    if (!previous || previous.loaded[id] !== conversation) loaded[id] = conversation;
  const removed = previous ? Object.keys(previous.loaded).filter((id) => !(id in state.loaded)) : [];
  return { shared, loaded, removed, ...(previous ? {} : { full: true }) };
}

/** Applique une publication de la fenêtre principale à l’état du miroir. */
export function applyPatch(state: State, patch: StatePatch): Partial<State> {
  const loaded = patch.full ? { ...patch.loaded } : { ...state.loaded, ...patch.loaded };
  for (const id of patch.removed) delete loaded[id];
  return { ...patch.shared, loaded };
}

const isEmpty = (patch: StatePatch) =>
  !Object.keys(patch.shared).length && !Object.keys(patch.loaded).length && !patch.removed.length && !patch.full;

/**
 * Fenêtre principale : publie l’état des conversations vers la fenêtre détachée et exécute ses actions. Le transport
 * est injectable pour les tests.
 */
export async function serveAgentsWindow(transport?: Transport): Promise<() => void> {
  const channel = transport ?? (await windowTransport(AGENTS_WINDOW_LABEL));
  let sent: State | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    timer = undefined;
    const state = useAgents.getState();
    const patch = diffState(state, sent);
    sent = state;
    if (!isEmpty(patch)) channel.send(STATE_EVENT, patch);
  };
  const schedule = () => {
    timer ??= setTimeout(publish, PUBLISH_MS);
  };
  const stopStore = useAgents.subscribe(schedule);
  const stopChannel = channel.listen(({ name, payload }) => {
    if (name === HELLO_EVENT) {
      // Une fenêtre détachée (r)ouverte : tout l’état, puis les changements.
      sent = undefined;
      clearTimeout(timer);
      publish();
      return;
    }
    if (name !== ACTION_EVENT) return;
    const { id, action, args } = payload as { id: string; action: string; args: unknown[] };
    const run = async () => {
      const store = useAgents.getState() as unknown as Record<string, unknown>;
      const handler = store[action];
      if (typeof handler !== "function" || !FORWARDED.has(action))
        throw new Error(`Action inconnue de la page Agent : ${action}`);
      return (handler as (...values: unknown[]) => unknown)(...args);
    };
    void run().then(
      (result) => channel.send(REPLY_EVENT, { id, result: result ?? null }),
      (error: unknown) => channel.send(REPLY_EVENT, { id, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  return () => {
    clearTimeout(timer);
    stopStore();
    stopChannel();
  };
}

/** Actions que la fenêtre détachée peut demander à la principale. */
const FORWARDED = new Set([
  "retryLoad",
  "retrySave",
  "flush",
  "setDefaults",
  "ensureLoaded",
  "create",
  "update",
  "rename",
  "archive",
  "unarchive",
  "markUnread",
  "send",
  "retry",
  "resend",
  "fork",
  "reorderQueued",
  "moveQueued",
  "sendQueuedNow",
  "unqueue",
  "cancel",
  "answerApproval",
  "answerQuestion",
  "remove",
  "undoTurn",
  "undoTurns",
]);

let mirrored = false;

/**
 * Fenêtre détachée : le magasin devient le miroir de celui de la fenêtre principale. À appeler avant le premier
 * rendu de la page Agent : les actions sont remplacées tout de suite, le transport s’ouvre ensuite.
 */
export function mirrorAgents(transport?: Transport): () => void {
  if (mirrored) return () => undefined;
  mirrored = true;
  const ready = transport ? Promise.resolve(transport) : windowTransport("main");
  const send = (name: string, payload: unknown) => void ready.then((channel) => channel.send(name, payload));
  const original = useAgents.getState();
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const call = (action: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      waiting.set(id, { resolve, reject });
      send(ACTION_EVENT, { id, action, args });
    });
  const forwarders: Record<string, unknown> = {};
  for (const action of FORWARDED) forwarders[action] = (...args: unknown[]) => call(action, args);
  useAgents.setState({
    ...forwarders,
    // Les conversations viennent de la fenêtre principale : charger, c’est lui demander l’état complet.
    load: async () => send(HELLO_EVENT, null),
    // La conversation ouverte reste propre à cette fenêtre ; elle se charge et se lit dans la principale.
    open: async (id: string | null) => {
      useAgents.setState({ activeId: id });
      if (!id) return;
      await call("ensureLoaded", [id]);
      if (useAgents.getState().loaded[id]?.unread) await call("update", [id, { unread: false }]);
    },
    show: async (id: string) => useAgents.getState().open(id),
    // Créée ici aussitôt (la page l’affiche sans attendre), et sous le même identifiant dans la principale.
    create: (options = {}) => {
      const conversation = original.create({ ...options, id: options.id ?? crypto.randomUUID() });
      void call("create", [{ ...options, id: conversation.id }]);
      return conversation;
    },
    // La file se lit ici ; le message est retiré dans la principale.
    unqueue: (id: string, queuedId: string) => {
      const item = useAgents.getState().runtime[id]?.queued.find((queued) => queued.id === queuedId);
      void call("unqueue", [id, queuedId]);
      return item?.message;
    },
  } as Partial<State>);
  let stop: () => void = () => undefined;
  void ready.then((channel) => {
    stop = channel.listen(({ name, payload }) => {
      if (name === STATE_EVENT) useAgents.setState((state) => applyPatch(state, payload as StatePatch));
      if (name === REPLY_EVENT) {
        const { id, result, error } = payload as { id: string; result?: unknown; error?: string };
        const pending = waiting.get(id);
        waiting.delete(id);
        if (error !== undefined) pending?.reject(new Error(error));
        else pending?.resolve(result);
      }
    });
    channel.send(HELLO_EVENT, null);
  });
  return () => stop();
}

/** Ouvre (ou ramène) la fenêtre Agent détachée. */
export async function openAgentsWindow(): Promise<void> {
  if (!inTauri) throw new Error("La fenêtre Agent ne s’ouvre que dans l’application Alfred.");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    await tauriInvoke("alfred_open_agents_window");
  } catch (error) {
    throw toError(error);
  }
}
