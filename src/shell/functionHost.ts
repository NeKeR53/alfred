/**
 * Exécute les fonctions de l’espace. Chaque module a son cadre invisible, isolé comme une page : la fonction y est
 * chargée à la demande et parle à Alfred par le même pont. Pages, agents, webhooks et planification passent tous
 * par `callFunction`.
 */
import { AlfredError, frameBase, invoke } from "../lib/native";
import { ALFRED_MESSAGE, type FrameMessage, isFrameMessage } from "../sdk/protocol";
import { inExampleMode } from "./examples";
import { type FrameIdentity, frameServices, handleFrameRequest } from "./frameBridge";
import { frameKey } from "./frameKeys";
import { useShell } from "./store";

interface Host {
  frame: HTMLIFrameElement;
  ready: Promise<void>;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  revision: number;
}

const hosts = new Map<string, Host>();
const CALL_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_CALLS = 40;
let active = 0;
let sequence = 0;

/** `examples` : cadre à part, dont tout ce que demandent les fonctions reste en mode « données d’exemple ». */
function createHost(module: string, examples: boolean): Host {
  const { info, theme, revision } = useShell.getState();
  if (!info) throw new AlfredError({ message: "Alfred n’a pas fini de démarrer." });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.display = "none";
  // Le cadre ne reçoit son adresse qu’avec la clé de son module : sans elle, il ne charge aucune fonction.
  const keyed = frameKey(module).then((key) => {
    frame.src = `${frameBase(info.pageBase)}/host/functions?${new URLSearchParams({ module, key, theme, v: String(revision) })}`;
  });
  const identity: FrameIdentity = {
    kind: "function",
    module,
    reference: `${module}/*`,
    ...(examples ? { examples: true } : {}),
  };
  let markReady: () => void = () => undefined;
  const host: Host = {
    frame,
    pending: new Map(),
    revision,
    ready: Promise.all([
      keyed,
      new Promise<void>((resolve) => {
        markReady = resolve;
      }),
    ]).then(() => undefined),
  };
  const post = (message: FrameMessage) => frame.contentWindow?.postMessage(message, "*");
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || !isFrameMessage(event.data)) return;
    const message = event.data;
    if (message.kind === "event") {
      if (message.name === "ready") markReady();
      if (message.name === "result") {
        const result = message.payload as {
          callId: string;
          output?: unknown;
          error?: { message: string; detail?: unknown };
        };
        const settle = host.pending.get(result.callId);
        if (!settle) return;
        host.pending.delete(result.callId);
        if (result.error) settle.reject(new AlfredError(result.error));
        else settle.resolve(result.output ?? null);
      }
      return;
    }
    if (message.kind !== "request") return;
    handleFrameRequest(identity, message.method, (message.params ?? {}) as Record<string, unknown>).then(
      (result) => post({ alfred: ALFRED_MESSAGE, kind: "response", id: message.id, result }),
      (error: unknown) =>
        post({
          alfred: ALFRED_MESSAGE,
          kind: "response",
          id: message.id,
          error: {
            message: error instanceof Error ? error.message : String(error),
            detail: (error as { detail?: unknown })?.detail,
          },
        }),
    );
  });
  document.body.append(frame);
  // Clé refusée (Alfred redémarré, module invalide) : le prochain appel recrée le cadre.
  const key = hostKey(module, examples);
  host.ready.catch(() => {
    if (hosts.get(key) === host) hosts.delete(key);
    frame.remove();
  });
  return host;
}

function hostKey(module: string, examples: boolean): string {
  return examples ? `${module}#exemples` : module;
}

function hostFor(module: string, examples: boolean): Host {
  const key = hostKey(module, examples);
  let host = hosts.get(key);
  if (!host) {
    host = createHost(module, examples);
    hosts.set(key, host);
  }
  return host;
}

/** Ferme les cadres de fonctions : à appeler quand l’espace change ou se ferme. */
export function resetFunctionHosts() {
  for (const host of hosts.values()) {
    for (const settle of host.pending.values())
      settle.reject(new AlfredError({ message: "L’espace de travail a été fermé." }));
    host.frame.remove();
  }
  hosts.clear();
}

/**
 * Appelle `module/fonction` avec `input`. `caller` dit qui appelle (page, agent, webhook, planification) : il est
 * noté au journal avec la durée et l’erreur éventuelle. `examples` : l’appelant montre des données d’exemple ;
 * l’appel les suit aussi quand le module de la fonction est réglé en mode exemple.
 */
export async function callFunction(
  reference: string,
  input: unknown,
  caller: string,
  examples = false,
): Promise<unknown> {
  const [module, name] = reference.split("/");
  const { snapshot } = useShell.getState();
  const declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  if (!module || !name || !declared) throw new AlfredError({ message: `La fonction « ${reference} » n’existe pas.` });
  const sample = examples || inExampleMode(snapshot, module);
  // Une fonction de connecteur en mode exemple n’est pas lancée : Alfred rend l’exemple le plus proche de l’entrée.
  if (sample && (declared.uses.clients ?? []).length > 0)
    return invoke("functions.example", { function: reference, input, caller });
  if (declared.missing) throw new AlfredError({ message: `La fonction « ${reference} » n’est pas encore écrite.` });
  // Un script (bash, PowerShell, Python) est lancé par Alfred lui-même, qui le note au journal.
  if (declared.runtime && declared.runtime !== "ts")
    return invoke("functions.call", { function: reference, input, caller, ...(sample ? { examples: true } : {}) });
  if (active >= MAX_ACTIVE_CALLS)
    throw new AlfredError({
      message: "Trop d’appels de fonctions en cours : une fonction s’appelle peut-être en boucle.",
    });
  const host = hostFor(module, sample);
  const callId = `c${++sequence}`;
  const started = performance.now();
  active += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await host.ready;
    const output = await new Promise<unknown>((resolve, reject) => {
      host.pending.set(callId, { resolve, reject });
      timer = setTimeout(() => {
        host.pending.delete(callId);
        reject(
          new AlfredError({ message: `La fonction « ${reference} » n’a pas répondu en ${CALL_TIMEOUT_MS / 1000} s.` }),
        );
      }, CALL_TIMEOUT_MS);
      host.frame.contentWindow?.postMessage(
        {
          alfred: ALFRED_MESSAGE,
          kind: "event",
          name: "call",
          // La révision recharge le code de la fonction dès qu’il a changé.
          payload: { callId, function: name, input, revision: String(useShell.getState().revision) },
        } satisfies FrameMessage,
        "*",
      );
    });
    void record(reference, caller, started, true);
    return output;
  } catch (error) {
    void record(reference, caller, started, false, error);
    throw error;
  } finally {
    clearTimeout(timer);
    active -= 1;
  }
}

frameServices.callFunction = (identity, reference, input) =>
  callFunction(reference, input, identity.reference, identity.examples === true);

function record(reference: string, caller: string, started: number, ok: boolean, error?: unknown) {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  return invoke("journal.record", {
    kind: "function",
    subject: reference,
    ok,
    durationMs: Math.round(performance.now() - started),
    summary: ok ? `Appelée par ${caller}` : `Échec (appelée par ${caller}) : ${message}`,
    detail: { caller, ...(message ? { error: message, diagnostics: (error as { detail?: unknown })?.detail } : {}) },
  }).catch(() => undefined);
}
