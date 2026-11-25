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
import { createStateHub, RENEW_EVERY_MS, type StateRead } from "./sharedStates";
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
  stateHub.clear();
  runningByModule.clear();
  inflightReads.clear();
  for (const host of hosts.values()) {
    for (const settle of host.pending.values())
      settle.reject(new AlfredError({ message: "L’espace de travail a été fermé." }));
    host.frame.remove();
  }
  hosts.clear();
}

/**
 * États partagés : la page s’abonne (`useAlfredState`) au cœur, qui tient la valeur et dont le fournisseur rafraîchit
 * l’état ; voir `sharedStates.ts`, `src-tauri/src/states.rs` et `state_refresh.rs`.
 */
export const stateHub = createStateHub<FrameIdentity>({
  get: (identity, request) => handleFrameRequest(identity, "states.get", { ...request }) as Promise<StateRead>,
  subscribe: async (identity, request) =>
    ((await handleFrameRequest(identity, "states.subscribe", { ...request })) as { id: string }).id,
  unsubscribe: (id) => invoke("states.unsubscribe", { id }),
  renew: (ids) => invoke("states.renew", { ids }),
  refresh: (identity, request) => handleFrameRequest(identity, "states.reload", { ...request }),
});

// Les abonnements des pages ouvertes sont renouvelés : une coquille fermée laisse expirer les siens.
setInterval(() => void stateHub.renew(), RENEW_EVERY_MS);

/** Le cœur annonce des clés d’état ou d’entité changées : seuls les abonnements qui en dépendent se relisent. */
export function receiveStatesChanged(payload: unknown) {
  const keys = (payload as { keys?: unknown } | null)?.keys;
  if (Array.isArray(keys)) stateHub.changed(keys.filter((key): key is string => typeof key === "string"));
}

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

/** JSON stable : clés d’objet triées. */
function stableJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, field]) => `${JSON.stringify(name)}:${stableJson(field)}`)
    .join(",")}}`;
}

/** Lectures identiques en cours (fonction, entrée, comptes, mode exemple) : une seule exécution. */
const inflightReads = new Map<string, Promise<unknown>>();

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
 * Appelle `module/fonction` avec `input`. Une lecture identique déjà en cours est rejointe. La sortie d’une fonction
 * TypeScript qui déclare un état ou une entité l’alimente (`states.feed`) ; le cœur alimente lui-même pour un script
 * et pour une fonction qu’il a demandée (`fed`). Une écriture fait ensuite relire les états affichés de son module,
 * sauf si elle rend elle-même l’objet modifié (`entity`).
 */
export async function callFunction(
  reference: string,
  input: unknown,
  caller: string,
  examples = false,
  /** Comptes de la page qui appelle, par besoin du module de la fonction. */
  accounts: Record<string, string> = {},
  options: { fed?: boolean } = {},
): Promise<unknown> {
  const [module = ""] = reference.split("/");
  const { snapshot } = useShell.getState();
  const declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  const sample = examples || inExampleMode(snapshot, module);
  const typescript = (declared?.runtime ?? "ts") === "ts";
  const run = async () => {
    const output = await track(module, () => executeFunction(reference, input, caller, examples, accounts));
    if (declared && typescript && !options.fed && (declared.state || declared.entity))
      await invoke("states.feed", {
        function: reference,
        input: input ?? {},
        accounts,
        examples: sample,
        output,
      }).catch(() => undefined);
    return output;
  };
  if (declared?.effect === "read") {
    const key = stableJson([reference, input ?? {}, accounts, sample]);
    const running = inflightReads.get(key);
    if (running) return running;
    const started = run().finally(() => inflightReads.delete(key));
    inflightReads.set(key, started);
    return started;
  }
  try {
    return await run();
  } finally {
    // Réussie ou non, l’écriture a pu changer le service : le fournisseur relit ses états suivis.
    if (declared && !declared.missing && !declared.entity && typescript)
      void invoke("states.written", { module }).catch(() => undefined);
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
  let { snapshot } = useShell.getState();
  let declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  // Une fonction déclarée à l’instant (un script gardé, la déclaration d’un agent) : l’espace est relu une fois.
  if (!declared && module && name) {
    await useShell
      .getState()
      .refresh()
      .catch(() => undefined);
    snapshot = useShell.getState().snapshot;
    declared = snapshot?.functions.find((candidate) => candidate.reference === reference);
  }
  if (!module || !name || !declared) throw new AlfredError({ message: `La fonction « ${reference} » n’existe pas.` });
  const sample = examples || inExampleMode(snapshot, module);
  // Une fonction de connecteur en mode exemple n’est pas lancée : Alfred rend l’exemple le plus proche de l’entrée.
  if (sample && (declared.uses.clients ?? []).length > 0)
    return invoke("functions.example", { function: reference, input, caller });
  if (declared.missing) throw new AlfredError({ message: `La fonction « ${reference} » n’est pas encore écrite.` });
  // Un script gardé par l’agent ne tourne qu’accepté ; la vérification (`check`) le lance avant.
  if (declared.kept === "toValidate" && caller !== "vérification")
    throw new AlfredError({
      message: `La fonction « ${reference} » est un script gardé par l’agent : elle attend votre accord (Réglages → Modules).`,
    });
  // Un script (bash, PowerShell, Python) est lancé par Alfred lui-même, qui le note au journal.
  if (declared.runtime && declared.runtime !== "ts")
    return invoke("functions.call", {
      function: reference,
      input,
      caller,
      ...(sample ? { examples: true } : {}),
    });
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

frameServices.watchState = (identity, request, listener) => {
  const id = stateHub.watch(identity, request, listener);
  return { unsubscribe: () => stateHub.unwatch(id), refresh: () => stateHub.refresh(id) };
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

/** Résultat d’une exécution de Code Mode, rendu au cœur tel quel. */
export interface AgentCodeResult {
  output?: unknown;
  logs: { level: string; text: string }[];
  error?: { message: string; stack?: unknown };
}

/** Requêtes que le code d’un agent peut faire : appeler une fonction, lire un état. Le cœur vérifie chacune. */
const AGENT_CODE_METHODS = new Set(["agentCode.call", "agentCode.state"]);

/**
 * Code Mode (`alfred run`) : un cadre neuf, isolé comme celui des fonctions, charge le code de l’exécution `run` et
 * le lance. Ses seules requêtes passent au cœur avec l’identifiant de l’exécution ; le cadre est retiré à la fin.
 */
export function runAgentCode(request: { run: string; key: string; input: unknown; timeoutMs: number }) {
  const { info, theme } = useShell.getState();
  if (!info) return Promise.reject(new AlfredError({ message: "Alfred n’a pas fini de démarrer." }));
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.display = "none";
  frame.src = `${frameBase(info.pageBase)}/host/functions?${new URLSearchParams({ code: request.key, theme })}`;
  const post = (message: FrameMessage) => frame.contentWindow?.postMessage(message, "*");
  return new Promise<AgentCodeResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: AgentCodeResult) => {
      clearTimeout(timer);
      window.removeEventListener("message", listen);
      frame.remove();
      resolve(result);
    };
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !isFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "event") {
        if (message.name === "ready")
          post({ alfred: ALFRED_MESSAGE, kind: "event", name: "run", payload: { run: request.run, input: request.input } });
        if (message.name === "result") finish(message.payload as AgentCodeResult);
        return;
      }
      if (message.kind !== "request") return;
      const answer = AGENT_CODE_METHODS.has(message.method)
        ? invoke(message.method, { ...((message.params ?? {}) as Record<string, unknown>), run: request.run })
        : Promise.reject(new Error("Code Mode : seulement api.module.fonction(…), api.call(…) et api.states.get(…)."));
      answer.then(
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
    };
    window.addEventListener("message", listen);
    timer = setTimeout(
      () => finish({ logs: [], error: { message: `Durée maximale dépassée (${request.timeoutMs / 1000} s).` } }),
      request.timeoutMs,
    );
    document.body.append(frame);
  });
}
