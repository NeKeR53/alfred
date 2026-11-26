/**
 * Sessions d’agent pilotées par Rust (`src-tauri/src/agents/`). L’interface n’a que des commandes fermées — ouvrir,
 * envoyer, orienter, répondre à un accord, interrompre, fermer — et reçoit des événements normalisés : elle ne parle
 * plus aucun protocole, n’écrit jamais sur l’entrée d’un CLI et ne voit ni jeton, ni mot de passe, ni sortie brute.
 */
import { inTauri, invoke, onNativeEvent, toError } from "../../../lib/native";
import { isSecondaryWindow } from "../../../shell/pageWindowMode";
import type {
  Autonomy,
  HarnessEvent,
  HarnessModel,
  HarnessSession,
  InputFile,
  Provider,
  SessionOptions,
} from "./types";

/** Options d’une session ; un appel unique n’a ni outil, ni demande d’accord, ni trace dans l’historique du CLI. */
export interface NativeSessionOptions extends SessionOptions {
  oneShot?: boolean;
  /** Schéma JSON qui contraint la réponse d’un appel unique. */
  outputSchema?: unknown;
  /** Reçoit le résultat structuré d’un appel unique. */
  onStructuredResult?: (value: unknown) => void;
}

type Incoming = (HarnessEvent | { type: "structured"; value: unknown }) & { session: string };

const listeners = new Map<string, (event: Incoming) => void>();
/** Événements arrivés avant que `agents.start` n’ait rendu la poignée de la session. */
const early = new Map<string, Incoming[]>();
let listening = false;

function deliver(event: Incoming) {
  const listener = listeners.get(event.session);
  if (listener) listener(event);
  else early.set(event.session, [...(early.get(event.session) ?? []), event]);
}

function listen() {
  if (listening) return;
  listening = true;
  onNativeEvent("agent:event", (payload) => deliver(payload as Incoming));
}

/**
 * Sessions ouvertes par cette fenêtre, gardées dans `sessionStorage`, qui survit au rechargement de la même fenêtre
 * sans être partagé avec une autre. Un rechargement perd les objets qui pilotaient ces sessions, pas les CLI :
 * reprendre ensuite la même conversation échouait (« thread … already has an active writer » chez Codex). Elles
 * sont donc fermées au démarrage, avant toute nouvelle session.
 */
const OWNED_KEY = "alfred.agentSessions";

function readOwned(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(OWNED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeOwned(handles: string[]) {
  try {
    if (handles.length) sessionStorage.setItem(OWNED_KEY, JSON.stringify(handles));
    else sessionStorage.removeItem(OWNED_KEY);
  } catch {
    // Sans stockage, un rechargement peut laisser une session ouverte ; Alfred l’arrête à sa fermeture.
  }
}

const own = (handle: string) => writeOwned([...readOwned().filter((item) => item !== handle), handle]);
const disown = (handle: string) => writeOwned(readOwned().filter((item) => item !== handle));

/**
 * Interface de ce chargement de la page, donnée à chaque session qu’elle ouvre. Les tâches déléguées d’une
 * coordinatrice partent dans l’interface qui tient sa session (`delegation.rs`) : une autre interface ouverte sur le
 * même Alfred (fenêtre cachée, navigateur par le pont de développement) les laisse. Une fenêtre secondaire ne lance
 * pas de délégués : ses sessions n’en donnent pas.
 */
export const INTERFACE_ID = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `i${Date.now()}`;

let orphansReleased: Promise<void> | undefined;

/**
 * Ferme les sessions du chargement précédent. La délégation l’appelle avant de réclamer des tâches : la tâche d’un
 * délégué ainsi coupé passe « interrompue » et repart dans cette interface.
 */
export function releaseOrphans(): Promise<void> {
  orphansReleased ??= (async () => {
    const orphans = readOwned();
    if (!orphans.length) return;
    // La tâche d’un délégué ainsi coupé reprend dans cette interface (`owner`), pas dans une autre ouverte à côté.
    await Promise.all(
      orphans.map((handle) => invoke("agents.close", { handle, owner: INTERFACE_ID }).catch(() => undefined)),
    );
    writeOwned(readOwned().filter((handle) => !orphans.includes(handle)));
  })();
  return orphansReleased;
}

/**
 * Ouvre la session. Dans la fenêtre, ses événements arrivent par un `Channel` Tauri qui lui est propre : le bus
 * commun perd des messages quand la fenêtre prend du retard. Le navigateur de test passe par ce bus, à travers le
 * pont de développement.
 */
async function startSession(args: Record<string, unknown>): Promise<{ handle: string; sessionId?: string | null }> {
  if (!inTauri) return invoke("agents.start", args);
  const { Channel, invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  const channel = new Channel<Incoming>();
  channel.onmessage = deliver;
  try {
    return await tauriInvoke("alfred_agent_spawn", { args, onEvent: channel });
  } catch (error) {
    throw toError(error);
  }
}

const files = (attachments: readonly InputFile[] = []) =>
  attachments.map(({ path, name, mimeType }) => ({ path, name, ...(mimeType ? { mimeType } : {}) }));

export async function createSession(options: NativeSessionOptions): Promise<HarnessSession> {
  listen();
  await releaseOrphans();
  const autonomy: Autonomy = options.autonomy;
  const opened = await startSession({
    provider: options.provider,
    cwd: options.cwd,
    ...(options.spaceDir ? { spaceDir: options.spaceDir } : {}),
    ...(options.conversation && !options.oneShot ? { conversation: options.conversation } : {}),
    ...(!options.oneShot && !isSecondaryWindow() ? { owner: INTERFACE_ID } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.title ? { title: options.title } : {}),
    autonomy,
    ...(options.oneShot ? { oneShot: true } : {}),
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
  });
  const handle = opened.handle;
  own(handle);
  let sessionId = opened.sessionId ?? undefined;
  const onEvent = (event: Incoming) => {
    if (event.type === "structured") {
      options.onStructuredResult?.(event.value);
      return;
    }
    const { session: _session, ...rest } = event;
    const harnessEvent = rest as HarnessEvent;
    if (harnessEvent.type === "session") sessionId = harnessEvent.sessionId;
    if (harnessEvent.type === "status" && harnessEvent.status === "closed") {
      listeners.delete(handle);
      disown(handle);
    }
    options.onEvent(harnessEvent);
  };
  listeners.set(handle, onEvent);
  const queued = early.get(handle);
  early.delete(handle);
  for (const event of queued ?? []) onEvent(event);
  const close = async () => {
    await invoke<void>("agents.close", { handle }).catch(() => undefined);
    listeners.delete(handle);
    disown(handle);
  };
  return {
    get sessionId() {
      return sessionId;
    },
    send: (message, attachments, clientId) =>
      invoke<void>("agents.send", {
        handle,
        text: message,
        files: files(attachments),
        ...(clientId ? { clientId } : {}),
      }),
    // Codex et Claude Code savent orienter une réponse en cours (Claude Code prend le message entre deux étapes et
    // poursuit sa tâche) ; ailleurs, l’appelant interrompt puis renvoie.
    ...(options.provider === "codex" || options.provider === "claude"
      ? {
          steer: (message: string, attachments?: readonly InputFile[], clientId?: string) =>
            invoke<void>("agents.steer", {
              handle,
              text: message,
              files: files(attachments),
              ...(clientId ? { clientId } : {}),
            }),
        }
      : {}),
    answer: (approvalId, optionId) => invoke<void>("agents.answer", { handle, approvalId, optionId }),
    // Seul Claude Code arrête une tâche seule (requête de contrôle `stop_task`).
    ...(options.provider === "claude"
      ? { stopTask: (taskId: string) => invoke<void>("agents.stopTask", { handle, taskId }) }
      : {}),
    cancel: () => invoke<void>("agents.cancel", { handle }),
    close,
  };
}

/** Claude Code n’expose pas de catalogue : ce sont les alias que le CLI accepte, plus le modèle par défaut du compte. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: HarnessModel[] = [
  { id: "default", name: "Modèle par défaut du compte", efforts: CLAUDE_EFFORTS },
  { id: "fable", name: "Fable", efforts: CLAUDE_EFFORTS },
  { id: "opus", name: "Opus", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", name: "Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "haiku", name: "Haiku", efforts: CLAUDE_EFFORTS },
];

/** Catalogue des modèles du CLI installé, lu par Rust (Codex, OpenCode). */
export async function listNativeModels(provider: Provider, cwd: string): Promise<HarnessModel[]> {
  if (provider === "claude") return CLAUDE_MODELS;
  const models = await invoke<HarnessModel[] | null>("agents.models", { provider, cwd });
  return Array.isArray(models) ? models : [];
}

export interface ProbeResult {
  installed: boolean;
  version?: string | null;
  loggedIn?: boolean | null;
}

export function probe(provider: Provider): Promise<ProbeResult> {
  return invoke<ProbeResult>("agents.probe", { provider });
}
