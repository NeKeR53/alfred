/**
 * Magasin partagé des lectures : la dernière réponse de chaque fonction de lecture (`effect: "read"`) d’un
 * connecteur, gardée en mémoire par la coquille et servie à toutes les pages qui la montrent.
 *
 * - Clé : fonction (`module/fonction`), entrée normalisée (ordre des champs indifférent), comptes de l’appel (par
 *   besoin du module de la fonction) et mode « données d’exemple ». Deux comptes différents ne partagent jamais
 *   une réponse.
 * - Toute lecture passe par ici (`run`), quel que soit l’appelant : page, agent, webhook, planification. Deux
 *   appels identiques en vol partagent une seule exécution, et chaque réponse est publiée à tous les abonnés.
 * - Une page s’abonne (`subscribe`, `useQuery` du SDK) : elle reçoit tout de suite la dernière valeur, sans
 *   requête tant qu’elle a moins de `staleAfter` ; plus vieille, elle s’affiche et se relit en fond.
 * - Une écriture du même module (fonction `write`, ou sans `effect`) rend caduques ses lectures et celles des
 *   modules qui en dépendent, pour les mêmes comptes : celles qui ont des abonnés se relisent, une fois chacune.
 * - Le magasin vit en mémoire, par fenêtre et par espace ; il se vide quand l’espace change. Une réponse sans
 *   abonné est oubliée après `FORGET_AFTER_MS`.
 */

export interface QueryCall {
  /** `module/fonction`. */
  reference: string;
  input: unknown;
  /** Comptes passés à la fonction, par besoin de son module (`jira` → `acme`). */
  accounts?: Record<string, string>;
  /** Données d’exemple : jamais mêlées aux vraies. */
  examples?: boolean;
  /** Qui lit (page, agent…), pour le journal ; hors de la clé. */
  caller?: string;
}

export interface QueryError {
  message: string;
  detail?: unknown;
}

/** État d’une lecture, tel que le reçoit une page abonnée. */
export interface QueryState<Data = unknown> {
  data: Data | undefined;
  error: QueryError | undefined;
  /** Aucune donnée encore : premier chargement. */
  loading: boolean;
  /** Une lecture est en cours (premier chargement ou relecture en fond). */
  fetching: boolean;
  /** Heure de la dernière réponse (ms depuis 1970), ou `undefined`. */
  updatedAt: number | undefined;
}

export interface SubscribeOptions {
  /** Âge (s) au-delà duquel la valeur se relit à l’abonnement. Par défaut 30 s ; 0 relit toujours. */
  staleAfter?: number;
  /** Relit la valeur toutes les `refreshEvery` secondes tant qu’il reste un abonné (5 s au moins). */
  refreshEvery?: number;
}

type Listener = (state: QueryState) => void;
type Execute = (call: QueryCall) => Promise<unknown>;

interface Subscriber {
  listener: Listener;
  refreshEvery?: number;
}

interface Entry {
  key: string;
  call: QueryCall;
  module: string;
  data: unknown;
  hasData: boolean;
  error: QueryError | undefined;
  updatedAt: number | undefined;
  inflight: Promise<unknown> | undefined;
  /** Monte à chaque invalidation : une réponse partie avant ne s’affiche pas comme à jour. */
  generation: number;
  stale: boolean;
  subscribers: Set<Subscriber>;
  lastUsed: number;
  poll: ReturnType<typeof setInterval> | undefined;
  pollEvery: number | undefined;
}

export const DEFAULT_STALE_AFTER_S = 30;
export const MIN_REFRESH_S = 5;
export const FORGET_AFTER_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/** JSON stable : clés d’objet triées, si bien que `{ b, a }` et `{ a, b }` donnent la même clé. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, field]) => `${JSON.stringify(name)}:${stableJson(field)}`).join(",")}}`;
}

export function queryKey(call: QueryCall): string {
  return stableJson([call.reference, call.input ?? {}, call.accounts ?? {}, call.examples === true]);
}

function toError(error: unknown): QueryError {
  const known = error as { message?: unknown; detail?: unknown } | undefined;
  return {
    message: typeof known?.message === "string" ? known.message : String(error),
    ...(known?.detail !== undefined ? { detail: known.detail } : {}),
  };
}

/** Deux jeux de comptes se recouvrent s’ils ne se contredisent sur aucun besoin commun. */
function accountsOverlap(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  return Object.entries(a).every(([need, instance]) => b[need] === undefined || b[need] === instance);
}

/** Instance nommée dans l’entrée (`{ instance: "acme" }`), si la fonction la reçoit ainsi. */
export function inputInstance(input: unknown): string | undefined {
  const instance = (input as { instance?: unknown } | null | undefined)?.instance;
  return typeof instance === "string" && instance ? instance : undefined;
}

/** Lectures que rend caduques une écriture. */
export interface InvalidateScope {
  /** Modules visés : celui de l’écriture et ceux qui en dépendent. Absent : tous. */
  modules?: readonly string[];
  /** Comptes de l’écriture : une lecture sur un autre compte du même besoin reste valable. */
  accounts?: Record<string, string>;
  /** Instance nommée dans l’entrée de l’écriture (`{ instance: "acme" }`). */
  instance?: string;
  /** Écriture en données d’exemple : seules les lectures d’exemple sont visées. */
  examples?: boolean;
}

export interface QueryStore {
  /** Exécute une lecture (ou rejoint celle en vol) et publie sa réponse à tous les abonnés. */
  run(call: QueryCall, execute?: Execute): Promise<unknown>;
  /** S’abonne à une lecture : l’écouteur reçoit l’état tout de suite, puis à chaque changement. */
  subscribe(call: QueryCall, listener: Listener, options?: SubscribeOptions): () => void;
  /** Relit maintenant une lecture (bouton « Actualiser »), même fraîche. */
  refresh(call: QueryCall): Promise<unknown>;
  /** Publie une réponse obtenue ailleurs (autre fenêtre, automatisation lancée par le cœur). */
  publish(call: QueryCall, output: unknown, at?: number): void;
  /**
   * Rend caduques les lectures visées (après une écriture) : celles qui ont des abonnés se relisent. Sans portée :
   * toutes (code des modules changé).
   */
  invalidate(scope?: InvalidateScope): void;
  /** État courant d’une lecture. */
  peek(call: QueryCall): QueryState;
  /** Oublie tout (changement d’espace). */
  clear(): void;
  /** Nombre de lectures gardées (tests). */
  size(): number;
}

export function createQueryStore(options: { execute?: Execute; now?: () => number } = {}): QueryStore {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  const stateOf = (entry: Entry | undefined): QueryState => ({
    data: entry?.hasData ? entry.data : undefined,
    error: entry?.error,
    loading: !entry?.hasData && entry?.error === undefined,
    fetching: entry?.inflight !== undefined,
    updatedAt: entry?.updatedAt,
  });

  const notify = (entry: Entry) => {
    const state = stateOf(entry);
    for (const subscriber of [...entry.subscribers]) subscriber.listener(state);
  };

  const forgetUnused = () => {
    const limit = now() - FORGET_AFTER_MS;
    for (const [key, entry] of entries)
      if (entry.subscribers.size === 0 && !entry.inflight && entry.lastUsed < limit) entries.delete(key);
    if (entries.size <= MAX_ENTRIES) return;
    const idle = [...entries.values()]
      .filter((entry) => entry.subscribers.size === 0 && !entry.inflight)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle.slice(0, entries.size - MAX_ENTRIES)) entries.delete(entry.key);
  };

  const entryFor = (call: QueryCall): Entry => {
    const key = queryKey(call);
    let entry = entries.get(key);
    if (!entry) {
      forgetUnused();
      entry = {
        key,
        call: {
          reference: call.reference,
          input: call.input ?? {},
          accounts: call.accounts ?? {},
          examples: call.examples === true,
        },
        module: call.reference.split("/")[0] ?? "",
        data: undefined,
        hasData: false,
        error: undefined,
        updatedAt: undefined,
        inflight: undefined,
        generation: 0,
        stale: false,
        subscribers: new Set(),
        lastUsed: now(),
        poll: undefined,
        pollEvery: undefined,
      };
      entries.set(key, entry);
    }
    entry.lastUsed = now();
    if (call.caller) entry.call.caller = call.caller;
    return entry;
  };

  const start = (entry: Entry, execute: Execute | undefined): Promise<unknown> => {
    if (entry.inflight) return entry.inflight;
    const run = execute ?? options.execute;
    if (!run) return Promise.reject(new Error("Le magasin des lectures n’est pas prêt."));
    const generation = entry.generation;
    const inflight = (async () => run(entry.call))();
    entry.inflight = inflight;
    notify(entry);
    inflight.then(
      (output) => {
        entry.inflight = undefined;
        if (generation !== entry.generation) {
          // Une écriture est passée pendant la lecture : la réponse est peut-être d’avant, on relit.
          if (entry.subscribers.size > 0) void start(entry, undefined).catch(() => undefined);
          else notify(entry);
          return;
        }
        entry.data = output;
        entry.hasData = true;
        entry.error = undefined;
        entry.updatedAt = now();
        entry.stale = false;
        notify(entry);
      },
      (error: unknown) => {
        entry.inflight = undefined;
        // La dernière valeur reste montrée avec l’erreur : la page peut dire « Mise à jour impossible ».
        entry.error = toError(error);
        notify(entry);
      },
    );
    return inflight;
  };

  const fresh = (entry: Entry, staleAfter: number) =>
    entry.hasData && !entry.stale && entry.updatedAt !== undefined && now() - entry.updatedAt < staleAfter * 1000;

  const schedulePoll = (entry: Entry) => {
    const periods = [...entry.subscribers]
      .map((subscriber) => subscriber.refreshEvery)
      .filter((every): every is number => typeof every === "number" && every > 0);
    const every = periods.length > 0 ? Math.max(MIN_REFRESH_S, Math.min(...periods)) : undefined;
    if (every === entry.pollEvery) return;
    if (entry.poll) clearInterval(entry.poll);
    entry.poll = undefined;
    entry.pollEvery = every;
    // Une seule relecture par clé, quel que soit le nombre de pages qui la montrent.
    if (every !== undefined)
      entry.poll = setInterval(() => void start(entry, undefined).catch(() => undefined), every * 1000);
  };

  return {
    run(call, execute) {
      return start(entryFor(call), execute);
    },
    subscribe(call, listener, subscribeOptions = {}) {
      const entry = entryFor(call);
      const subscriber: Subscriber = { listener, refreshEvery: subscribeOptions.refreshEvery };
      entry.subscribers.add(subscriber);
      listener(stateOf(entry));
      const staleAfter = Math.max(0, subscribeOptions.staleAfter ?? DEFAULT_STALE_AFTER_S);
      if (!entry.inflight && !fresh(entry, staleAfter)) void start(entry, undefined).catch(() => undefined);
      schedulePoll(entry);
      return () => {
        entry.subscribers.delete(subscriber);
        entry.lastUsed = now();
        schedulePoll(entry);
      };
    },
    refresh(call) {
      const entry = entryFor(call);
      if (entry.inflight) return entry.inflight;
      return start(entry, undefined);
    },
    publish(call, output, at) {
      const entry = entryFor(call);
      const time = at ?? now();
      // Une réponse plus ancienne que celle gardée ne la remplace pas.
      if (entry.updatedAt !== undefined && time < entry.updatedAt) return;
      entry.data = output;
      entry.hasData = true;
      entry.error = undefined;
      entry.updatedAt = time;
      entry.stale = false;
      notify(entry);
    },
    invalidate(scope = {}) {
      const targets = scope.modules ? new Set(scope.modules) : undefined;
      for (const entry of entries.values()) {
        if (targets && !targets.has(entry.module)) continue;
        if (scope.examples !== undefined && scope.examples !== entry.call.examples) continue;
        if (!accountsOverlap(scope.accounts, entry.call.accounts)) continue;
        const own = inputInstance(entry.call.input);
        if (scope.instance && own && own !== scope.instance) continue;
        entry.generation += 1;
        entry.stale = true;
        if (entry.subscribers.size > 0) void start(entry, undefined).catch(() => undefined);
      }
    },
    peek(call) {
      return stateOf(entries.get(queryKey(call)));
    },
    clear() {
      for (const entry of entries.values()) if (entry.poll) clearInterval(entry.poll);
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
