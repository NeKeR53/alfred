/**
 * Abonnements des pages aux états partagés (`useAlfredState`). Le cœur tient la seule source de vérité
 * (`src-tauri/src/states.rs`) et le fournisseur de chaque état le rafraîchit dans le cœur (`state_refresh.rs`).
 * Ce hub ne relit jamais le service lui-même :
 *
 * - il abonne chaque page au cœur (`frame.states.subscribe`) et renouvelle ses abonnements tant qu’elle est ouverte ;
 *   quand elle se ferme, il les retire : le dernier abonné parti, le fournisseur s’arrête ;
 * - il lit la valeur courante et la pousse à la page tout de suite, sans attendre l’abonnement : la dernière valeur
 *   connue (gardée sur le disque par le cœur, même d’un lancement précédent) s’affiche avant toute lecture ;
 * - à chaque changement annoncé par le cœur (`states:changed`, avec les clés touchées), il relit seulement les
 *   abonnements qui dépendent de ces clés (l’état, les entités de sa liste) : une lecture locale, sans requête ;
 * - `refresh()` demande au fournisseur de relire maintenant, et se résout quand cette lecture est finie : l’action
 *   « Actualiser » montre son attente (socle-ui D-116) ;
 * - `revisit(page)` : la page revient à l’écran ; le cœur relit ses états périmés (âge maximal dépassé), seulement.
 */

/** Ce qu’une page demande : un état (ou une entité), ses paramètres, son compte. */
export interface StateRequest {
  /** `module/etat`, ou `etat` dans le module de la page. */
  name: string;
  /** Paramètres de l’état (`{ jql }`) ; normalisés par le cœur. */
  params?: Record<string, unknown>;
  /** Identifiant d’une entité, ou valeur du seul paramètre d’un état. */
  key?: string;
  instance?: string;
}

/** Dernier rafraîchissement par le fournisseur. */
export interface RefreshStatus {
  running?: boolean;
  lastRunAt?: number | null;
  lastOkAt?: number | null;
  lastError?: string | null;
  failures?: number;
  nextAt?: number | null;
  /** Lectures terminées : « Actualiser » attend la suivante. */
  runs?: number;
}

/** Réponse du cœur (`frame.states.get`). */
export interface StateRead {
  value: unknown;
  empty: boolean;
  updatedAt?: number | null;
  /** Dernière lecture réussie : l’âge de la valeur. */
  checkedAt?: number | null;
  deps: string[];
  refresh?: RefreshStatus | null;
  instance?: string;
}

/** État poussé à la page. */
export interface StatePush {
  data: unknown;
  error: { message: string } | undefined;
  /** Aucune valeur encore : la première lecture est en cours. */
  loading: boolean;
  /** Le fournisseur relit l’état en ce moment. */
  refreshing: boolean;
  updatedAt: number | undefined;
  /** Dernière lecture réussie : l’âge de la valeur. */
  checkedAt: number | undefined;
  /** Dernier rafraîchissement : heure, erreur, prochain passage. */
  status: RefreshStatus | undefined;
}

export interface HubServices<Owner> {
  get(owner: Owner, request: StateRequest): Promise<StateRead>;
  /** Abonne la page au cœur ; rend l’identifiant de l’abonnement. */
  subscribe(owner: Owner, request: StateRequest): Promise<string>;
  unsubscribe(id: string): Promise<unknown>;
  renew(ids: string[]): Promise<unknown>;
  /**
   * Demande au fournisseur de relire l’état maintenant : rend le nombre de lectures déjà faites (`runs`) et si une
   * lecture part (`reading`).
   */
  refresh(owner: Owner, request: StateRequest): Promise<unknown>;
  /** Une page revient à l’écran : le cœur relit ceux de ses états qui sont périmés. */
  revisit?(ids: string[]): Promise<unknown>;
}

/** « Actualiser » attend la fin de sa lecture au plus ce temps. */
export const REFRESH_WAIT_MS = 60_000;

interface Watch<Owner> {
  id: string;
  owner: Owner;
  request: StateRequest;
  push: (state: StatePush) => void;
  deps: Set<string>;
  last: StatePush;
  subscription: Promise<string | undefined>;
  /** « Actualiser » en attente : chacun attend que le nombre de lectures dépasse `runs`. */
  waiters: { runs: number; done: () => void }[];
}

export interface StateHub<Owner> {
  watch(owner: Owner, request: StateRequest, push: (state: StatePush) => void): string;
  unwatch(id: string): void;
  release(owner: Owner): void;
  refresh(id: string): Promise<void>;
  /** La page `owner` revient à l’écran : ses états périmés se relisent. */
  revisit(owner: Owner): Promise<void>;
  changed(keys: readonly string[]): void;
  /** Renouvelle les abonnements des pages ouvertes (appelé par un minuteur). */
  renew(): Promise<void>;
  size(): number;
  clear(): void;
}

/** Renouvellement des abonnements : bien avant leur expiration dans le cœur (90 s). */
export const RENEW_EVERY_MS = 30_000;

export function createStateHub<Owner>(services: HubServices<Owner>): StateHub<Owner> {
  const watches = new Map<string, Watch<Owner>>();
  let sequence = 0;

  const send = (watch: Watch<Owner>, next: Partial<StatePush>) => {
    watch.last = { ...watch.last, ...next };
    watch.push(watch.last);
  };

  const reread = async (watch: Watch<Owner>) => {
    try {
      const read = await services.get(watch.owner, watch.request);
      if (!watches.has(watch.id)) return;
      watch.deps = new Set(read.deps);
      const status = read.refresh ?? undefined;
      // « Actualiser » : sa lecture est finie quand le nombre de lectures a dépassé celui de la demande.
      const runs = status?.runs ?? 0;
      const finished = status?.running !== true ? watch.waiters.filter((waiter) => runs > waiter.runs) : [];
      watch.waiters = watch.waiters.filter((waiter) => !finished.includes(waiter));
      send(watch, {
        data: read.empty ? undefined : read.value,
        // Vide et pas encore lu (premier abonnement, lecture à venir ou en cours) : chargement. Une valeur connue,
        // même ancienne, n’est jamais un chargement.
        loading: read.empty && (status === undefined || status.running === true || !status.lastRunAt),
        refreshing: status?.running === true || watch.waiters.length > 0,
        updatedAt: read.updatedAt ?? undefined,
        checkedAt: read.checkedAt ?? undefined,
        error: status?.lastError ? { message: status.lastError } : undefined,
        status,
      });
      for (const waiter of finished) waiter.done();
    } catch (error) {
      send(watch, { error: { message: error instanceof Error ? error.message : String(error) }, loading: false });
    }
  };

  const drop = (watch: Watch<Owner>) => {
    watches.delete(watch.id);
    for (const waiter of watch.waiters) waiter.done();
    watch.waiters = [];
    void watch.subscription.then((id) => (id ? services.unsubscribe(id) : undefined)).catch(() => undefined);
  };

  return {
    watch(owner, request, push) {
      sequence += 1;
      const id = `s${sequence}`;
      const watch: Watch<Owner> = {
        id,
        owner,
        request,
        push,
        deps: new Set(),
        last: {
          data: undefined,
          error: undefined,
          loading: true,
          refreshing: false,
          updatedAt: undefined,
          checkedAt: undefined,
          status: undefined,
        },
        waiters: [],
        // L’abonnement au cœur : le fournisseur rafraîchit l’état tant qu’il a un abonné.
        subscription: services.subscribe(owner, request).catch((error: unknown) => {
          send(watch, { error: { message: error instanceof Error ? error.message : String(error) }, loading: false });
          return undefined;
        }),
      };
      watches.set(id, watch);
      // La valeur connue tout de suite, puis relue une fois l’abonnement pris (le fournisseur a pu partir).
      void reread(watch);
      void watch.subscription.then(() => reread(watch));
      return id;
    },
    unwatch(id) {
      const watch = watches.get(id);
      if (watch) drop(watch);
    },
    release(owner) {
      for (const watch of [...watches.values()]) if (watch.owner === owner) drop(watch);
    },
    async refresh(id) {
      const watch = watches.get(id);
      if (!watch) return;
      send(watch, { refreshing: true });
      const asked = (await services.refresh(watch.owner, watch.request).catch(() => undefined)) as
        | { runs?: number; reading?: boolean }
        | null
        | undefined;
      if (!asked?.reading || typeof asked.runs !== "number") {
        send(watch, { refreshing: watch.last.status?.running === true || watch.waiters.length > 0 });
        return;
      }
      const runs = asked.runs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          watch.waiters = watch.waiters.filter((waiter) => waiter !== entry);
          resolve();
        }, REFRESH_WAIT_MS);
        const entry = {
          runs,
          done: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        watch.waiters.push(entry);
        // La lecture a pu finir avant l’inscription : on relit une fois.
        void reread(watch);
      });
    },
    async revisit(owner) {
      if (!services.revisit) return;
      const mine = [...watches.values()].filter((watch) => watch.owner === owner);
      const ids = (await Promise.all(mine.map((watch) => watch.subscription))).filter((id): id is string =>
        Boolean(id),
      );
      if (ids.length > 0) await services.revisit(ids).catch(() => undefined);
    },
    changed(keys) {
      const touched = new Set(keys);
      for (const watch of watches.values()) if ([...watch.deps].some((dep) => touched.has(dep))) void reread(watch);
    },
    async renew() {
      const ids = (await Promise.all([...watches.values()].map((watch) => watch.subscription))).filter(
        (id): id is string => Boolean(id),
      );
      if (ids.length > 0) await services.renew(ids).catch(() => undefined);
    },
    size() {
      return watches.size;
    },
    clear() {
      for (const watch of [...watches.values()]) drop(watch);
    },
  };
}
