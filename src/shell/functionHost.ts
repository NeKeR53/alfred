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
import { createStateHub, type StateRead, type StateRequest } from "./sharedStates";
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

/** Identifiant de cette coquille : le cœur lui attribue une relecture périodique (`states.lease`). */
const ORIGIN = `shell-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/** Module qui déclare un état : « module/etat », ou « etat » dans le module du demandeur. */
function ownerOf(identity: FrameIdentity, name: string): string {
  return name.includes("/") ? (name.split("/")[0] ?? "") : identity.module;
}

/**
 * Lit ce qui alimente un état : la fonction de lecture du module déclarant qui porte `state` (ou `entity` avec
 * `param`, pour une entité lue seule), avec les comptes du demandeur. Sa sortie alimente le cœur, qui annonce le
 * changement à toutes les coquilles (`states:changed`).
 */
async function loadState(identity: FrameIdentity, request: StateRequest): Promise<void> {
  const owner = ownerOf(identity, request.name);
  const id = request.name.includes("/") ? request.name.slice(owner.length + 1) : request.name;
  const functions = useShell.getState().snapshot?.functions ?? [];
  const reads = functions.filter((fn) => fn.module === owner && fn.effect === "read");
  const source =
    reads.find((fn) => fn.state === id && (!request.key || fn.param)) ??
    reads.find((fn) => fn.entity === id && fn.param && request.key);
  if (!source)
    throw new AlfredError({
      message: `Aucune fonction de lecture n’alimente « ${owner}/${id} » (\`state\` ou \`entity\`).`,
    });
  const input: Record<string, unknown> = {};
  if (source.param && request.key) input[source.param] = request.key;
  if (request.instance) input.instance = request.instance;
  await callFunction(
    source.reference,
    input,
    identity.reference,
    identity.examples === true,
    accountsFor(owner, identity.module, identity.accounts),
  );
}

/**
 * États partagés : la page s’abonne (`useAlfredState`), le cœur tient la valeur ; voir `sharedStates.ts` et
 * `src-tauri/src/states.rs`.
 */
export const stateHub = createStateHub<FrameIdentity>({
  get: (identity, request) => handleFrameRequest(identity, "states.get", { ...request }) as Promise<StateRead>,
  load: loadState,
  lease: (key, seconds) => invoke<boolean>("states.lease", { key, origin: ORIGIN, seconds }),
  moduleOf: (identity, request) => ownerOf(identity, request.name),
});

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
 * Une fonction a écrit chez un service (le cœur l’a vu passer, `clients:changed`) : les états affichés du module se
 * relisent. Cela couvre les scripts lancés par le cœur (automatisation, webhook) : le cœur nomme la fonction et ne
 * prévient jamais pour une lecture. Sans nom de fonction, l’écriture vient d’une fonction TypeScript, que la
 * coquille qui l’a lancée traite elle-même à la fin de l’appel (et le `POST` d’une recherche ne relance rien).
 */
export function receiveClientChange(payload: unknown) {
  const change = payload as { module?: string; function?: string } | null;
  if (!change?.module || !change.function || runningByModule.has(change.module)) return;
  stateHub.refreshModules([change.module]);
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
    // Réussie ou non, l’écriture a pu changer le service : les états affichés du module se relisent.
    if (declared && !declared.missing && !declared.entity) stateHub.refreshModules([module]);
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
