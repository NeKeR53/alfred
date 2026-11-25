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
import { createQueryStore, inputInstance, type QueryCall } from "./sharedQueries";
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

/**
 * Comptes qu’une page passe aux fonctions du module `module` : ceux de ses besoins, nommés comme la fonction les
 * appelle. Pour une fonction de son propre module, tels quels (`jira`, `dep/jira`) ; pour une fonction d’un module
 * dont elle dépend, ceux qu’elle a choisis pour ses besoins (`dep/jira` devient `jira`).
 */
export function accountsFor(
  module: string,
  caller: string,
  accounts: Record<string, string> | undefined,
): Record<string, string> {
  const chosen: Record<string, string> = {};
  for (const [need, instance] of Object.entries(accounts ?? {})) {
    if (module === caller) chosen[need] = instance;
    else if (need.startsWith(`${module}/`)) chosen[need.slice(module.length + 1)] = instance;
  }
  return chosen;
}

/**
 * `examples` : cadre à part, dont tout ce que demandent les fonctions reste en mode « données d’exemple ».
 * `accounts` : comptes de la page qui appelle ; un cadre par jeu de comptes, pour que `client(besoin)` vise d’office
 * le compte de la page.
 */
function createHost(module: string, examples: boolean, accounts: Record<string, string> = {}): Host {
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
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
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
  const key = hostKey(module, examples, accounts);
  host.ready.catch(() => {
    if (hosts.get(key) === host) hosts.delete(key);
    frame.remove();
  });
  return host;
}

function hostKey(module: string, examples: boolean, accounts: Record<string, string> = {}): string {
  const chosen = Object.entries(accounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([need, instance]) => `${need}=${instance}`)
    .join(",");
  return `${module}${examples ? "#exemples" : ""}${chosen ? `#${chosen}` : ""}`;
}

function hostFor(module: string, examples: boolean, accounts: Record<string, string> = {}): Host {
  const key = hostKey(module, examples, accounts);
  let host = hosts.get(key);
  if (!host) {
    host = createHost(module, examples, accounts);
    hosts.set(key, host);
  }
  return host;
}

/** Ferme les cadres de fonctions : à appeler quand l’espace change ou se ferme. */
export function resetFunctionHosts() {
  sharedQueries.clear();
  runningByModule.clear();
  for (const host of hosts.values()) {
    for (const settle of host.pending.values())
      settle.reject(new AlfredError({ message: "L’espace de travail a été fermé." }));
    host.frame.remove();
  }
  hosts.clear();
}

/**
 * Lectures partagées : toute fonction `effect: "read"` passe par ce magasin, qui dédoublonne les appels identiques
 * en vol et publie chaque réponse aux pages abonnées (`useQuery`). Voir `sharedQueries.ts`.
 */
export const sharedQueries = createQueryStore({
  execute: (call) => executeRead(call),
});

/** Identifiant de cette coquille : une réponse qu’elle a diffusée ne lui revient pas. */
const ORIGIN = `shell-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/** Modules dont les lectures dépendent de `module` : lui-même et ceux qui en dépendent (`requires`), de proche en proche. */
export function dependentModules(module: string): string[] {
  const modules = useShell.getState().snapshot?.modules ?? [];
  const found = new Set([module]);
  const queue = [module];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const candidate of modules)
      if (!found.has(candidate.id) && candidate.requires.some((need) => need.module === current)) {
        found.add(candidate.id);
        queue.push(candidate.id);
      }
  }
  return [...found];
}

async function executeRead(call: QueryCall): Promise<unknown> {
  const output = await track(call.reference.split("/")[0] ?? "", () =>
    executeFunction(call.reference, call.input, call.caller ?? "partage", call.examples === true, call.accounts ?? {}),
  );
  shareResult(call, true, output);
  return output;
}

/** Une écriture rend caduques les lectures du module et des modules qui en dépendent, pour les mêmes comptes. */
function invalidateAfterWrite(call: QueryCall) {
  sharedQueries.invalidate({
    modules: dependentModules(call.reference.split("/")[0] ?? ""),
    accounts: call.accounts,
    instance: inputInstance(call.input),
    examples: call.examples === true,
  });
}

/** Les autres fenêtres d’Alfred reçoivent la réponse (ou l’écriture) par le cœur : `functions:result`. */
function shareResult(call: QueryCall, read: boolean, output: unknown) {
  void invoke("functions.shareResult", {
    origin: ORIGIN,
    function: call.reference,
    input: call.input ?? {},
    accounts: call.accounts ?? {},
    examples: call.examples === true,
    ...(read ? { output } : {}),
    at: Date.now(),
  }).catch(() => undefined);
}

/**
 * Point d’entrée des réponses venues d’ailleurs : une autre fenêtre, ou une automatisation que le cœur a lancée
 * lui-même (`function_results::publish` en Rust). Une lecture est publiée aux abonnés ; une écriture rend caduques
 * les lectures qu’elle touche.
 */
export function receiveSharedResult(payload: unknown) {
  const result = payload as {
    origin?: string;
    function?: string;
    input?: unknown;
    accounts?: Record<string, string>;
    examples?: boolean;
    output?: unknown;
    at?: number;
  } | null;
  if (!result?.function || result.origin === ORIGIN) return;
  const declared = useShell.getState().snapshot?.functions.find((fn) => fn.reference === result.function);
  if (!declared) return;
  const call: QueryCall = {
    reference: result.function,
    input: result.input ?? {},
    accounts: result.accounts ?? {},
    examples: result.examples === true,
  };
  if (declared.effect === "read") {
    if ("output" in result) sharedQueries.publish(call, result.output ?? null, result.at);
  } else invalidateAfterWrite(call);
}

/** Appels de fonctions en cours dans cette coquille, par module. */
const runningByModule = new Map<string, number>();

function track<T>(module: string, run: () => Promise<T>): Promise<T> {
  runningByModule.set(module, (runningByModule.get(module) ?? 0) + 1);
  return run().finally(() => {
    const left = (runningByModule.get(module) ?? 1) - 1;
    if (left > 0) runningByModule.set(module, left);
    else runningByModule.delete(module);
  });
}

/**
 * Une fonction a écrit chez un service (le cœur l’a vu passer, `clients:changed`) : les lectures du module et des
 * modules qui en dépendent se relisent. Cela couvre les scripts lancés par le cœur lui-même (automatisation,
 * webhook) : le cœur nomme la fonction et ne prévient jamais pour une lecture. Sans nom de fonction, l’écriture vient
 * d’une fonction TypeScript, donc d’une coquille, qui invalide elle-même à la fin de l’écriture et prévient les
 * autres fenêtres (`functions:result`) : rien à faire ici, et surtout pas pour le `POST` d’une lecture (une
 * recherche), qui relancerait les lectures sans fin. Ignoré aussi tant qu’une fonction du module tourne ici.
 */
export function receiveClientChange(payload: unknown) {
  const change = payload as { module?: string; function?: string } | null;
  if (!change?.module || !change.function || runningByModule.has(change.module)) return;
  sharedQueries.invalidate({ modules: dependentModules(change.module), examples: false });
}

/**
 * Appelle `module/fonction` avec `input`. Une lecture (`effect: "read"`) passe par le magasin partagé : un appel
 * identique déjà en cours est rejoint, et la réponse est publiée à toutes les pages qui la montrent. Une écriture
 * rend ensuite caduques les lectures de son module.
 */
export async function callFunction(
  reference: string,
  input: unknown,
  caller: string,
  examples = false,
  /** Comptes de la page qui appelle, par besoin du module de la fonction. */
  accounts: Record<string, string> = {},
): Promise<unknown> {
  const [module] = reference.split("/");
  const { snapshot } = useShell.getState();
  const declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  const sample = examples || (module ? inExampleMode(snapshot, module) : false);
  const call: QueryCall = { reference, input, accounts, examples: sample, caller };
  if (declared?.effect === "read") return sharedQueries.run(call);
  try {
    return await track(module ?? "", () => executeFunction(reference, input, caller, examples, accounts));
  } finally {
    // Réussie ou non, l’écriture a pu changer le service : ses lectures se relisent.
    if (declared && !declared.missing) {
      invalidateAfterWrite(call);
      shareResult(call, false, undefined);
    }
  }
}

/**
 * Exécute `module/fonction` avec `input`. `caller` dit qui appelle (page, agent, webhook, planification) : il est
 * noté au journal avec la durée et l’erreur éventuelle. `examples` : l’appelant montre des données d’exemple ;
 * l’appel les suit aussi quand le module de la fonction est réglé en mode exemple.
 */
async function executeFunction(
  reference: string,
  input: unknown,
  caller: string,
  examples: boolean,
  accounts: Record<string, string>,
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
  const host = hostFor(module, sample, accounts);
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

// Le code d’un module a changé : ses lectures gardées sont caduques (les abonnées se relisent).
useShell.subscribe((state, previous) => {
  if (state.revision !== previous.revision) sharedQueries.invalidate();
});

frameServices.watchFunction = (identity, reference, input, options, listener) => {
  const [module = ""] = reference.split("/");
  const { snapshot } = useShell.getState();
  const declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  if (!declared) throw new AlfredError({ message: `La fonction « ${reference} » n’existe pas.` });
  if (declared.effect !== "read")
    throw new AlfredError({
      message: `useQuery suit une lecture : « ${reference} » n’est pas déclarée \`effect: "read"\`. Pour une écriture, functions.call.`,
    });
  const call: QueryCall = {
    reference,
    input,
    accounts: accountsFor(module, identity.module, identity.accounts),
    examples: identity.examples === true || inExampleMode(snapshot, module),
    caller: identity.reference,
  };
  return {
    unsubscribe: sharedQueries.subscribe(call, listener, options),
    refresh: () => sharedQueries.refresh(call),
  };
};

frameServices.callFunction = (identity, reference, input) =>
  callFunction(
    reference,
    input,
    identity.reference,
    identity.examples === true,
    accountsFor(reference.split("/")[0] ?? "", identity.module, identity.accounts),
  );

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
