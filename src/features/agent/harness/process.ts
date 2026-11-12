/** Processus d’un harnais, lancé par Rust : l’interface n’en reçoit que les lignes et n’y écrit que du texte. */
import { invoke, onNativeEvent } from "../../../lib/native";
import type { Provider } from "./types";

export interface HarnessProcess {
  write(data: string): Promise<void>;
  kill(): Promise<void>;
  onStdout(handler: (chunk: string) => void): () => void;
  onStderr(handler: (chunk: string) => void): () => void;
  onClose(handler: (code: number | null) => void): () => void;
  onError(handler: () => void): () => void;
}

export interface SpawnOptions {
  cwd: string;
  conversation?: string;
  claude?: {
    model?: string;
    effort?: string;
    resume?: string;
    permissionMode?: string;
    addDirs?: string[];
    appendSystemPrompt?: string;
    oneShot?: boolean;
    jsonSchema?: unknown;
  };
  opencodeConfig?: string;
}

type Output =
  | { session: string; kind: "stdout"; line: string }
  | { session: string; kind: "stderr"; chunk: string }
  | { session: string; kind: "closed"; code: number | null };

type Listeners = {
  stdout: Set<(chunk: string) => void>;
  stderr: Set<(chunk: string) => void>;
  close: Set<(code: number | null) => void>;
};

const processes = new Map<string, Listeners>();
/** Sorties arrivées avant que `agents.spawn` n’ait renvoyé l’identifiant de la session. */
const early = new Map<string, Output[]>();
let listening = false;

/**
 * Sessions lancées par cette fenêtre, gardées dans `sessionStorage`, qui survit au rechargement de la même fenêtre
 * (Cmd+R, rechargement de développement) sans être partagé avec une autre. Un rechargement perd les objets qui
 * pilotaient ces processus, mais pas les processus : reprendre ensuite la même conversation échouait (« thread …
 * already has an active writer » chez Codex). Ils sont donc arrêtés au démarrage, avant tout nouveau lancement.
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

function writeOwned(sessions: string[]) {
  try {
    if (sessions.length) sessionStorage.setItem(OWNED_KEY, JSON.stringify(sessions));
    else sessionStorage.removeItem(OWNED_KEY);
  } catch {
    // Sans stockage, un rechargement peut laisser un processus orphelin ; Alfred l’arrête à sa fermeture.
  }
}

const own = (session: string) => writeOwned([...readOwned().filter((item) => item !== session), session]);
const disown = (session: string) => writeOwned(readOwned().filter((item) => item !== session));

let orphansReleased: Promise<void> | undefined;

/** Arrête, une seule fois par chargement, les sessions qu’un chargement précédent de cette fenêtre a laissées. */
function releaseOrphans(): Promise<void> {
  orphansReleased ??= (async () => {
    const orphans = readOwned();
    if (!orphans.length) return;
    await Promise.all(orphans.map((session) => invoke("agents.kill", { session }).catch(() => undefined)));
    writeOwned(readOwned().filter((session) => !orphans.includes(session)));
  })();
  return orphansReleased;
}

function deliver(output: Output) {
  const listeners = processes.get(output.session);
  if (!listeners) {
    const queue = early.get(output.session) ?? [];
    queue.push(output);
    early.set(output.session, queue);
    return;
  }
  if (output.kind === "stdout") for (const handler of listeners.stdout) handler(`${output.line}\n`);
  else if (output.kind === "stderr") for (const handler of listeners.stderr) handler(output.chunk);
  else {
    for (const handler of listeners.close) handler(output.code);
    processes.delete(output.session);
    disown(output.session);
  }
}

function listen() {
  if (listening) return;
  listening = true;
  onNativeEvent("agent:output", (payload) => deliver(payload as Output));
}

export async function spawnProcess(provider: Provider, options: SpawnOptions): Promise<HarnessProcess> {
  listen();
  await releaseOrphans();
  const { session } = await invoke<{ session: string }>("agents.spawn", { provider, ...options });
  own(session);
  const listeners: Listeners = { stdout: new Set(), stderr: new Set(), close: new Set() };
  processes.set(session, listeners);
  // Les abonnements se posent dans la même tâche que la création ; les sorties déjà reçues suivent juste après.
  queueMicrotask(() => {
    const queued = early.get(session);
    early.delete(session);
    for (const output of queued ?? []) deliver(output);
  });
  const subscribe = <Handler>(set: Set<Handler>, handler: Handler) => {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
  return {
    write: (data) => invoke<void>("agents.write", { session, data }),
    kill: async () => {
      await invoke<void>("agents.kill", { session });
      disown(session);
    },
    onStdout: (handler) => subscribe(listeners.stdout, handler),
    onStderr: (handler) => subscribe(listeners.stderr, handler),
    onClose: (handler) => subscribe(listeners.close, handler),
    // Un échec de lancement est levé par `spawnProcess` ; un arrêt inattendu passe par `onClose`.
    onError: () => () => undefined,
  };
}

export interface ProbeResult {
  installed: boolean;
  version?: string | null;
  loggedIn?: boolean | null;
}

export function probe(provider: Provider): Promise<ProbeResult> {
  return invoke<ProbeResult>("agents.probe", { provider });
}
