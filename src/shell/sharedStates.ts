/**
 * Abonnements des pages aux états partagés (`useAlfredState`). Le cœur tient la seule source de vérité
 * (`src-tauri/src/states.rs`) et le fournisseur de chaque état le rafraîchit dans le cœur (`state_refresh.rs`).
 * Ce hub ne relit jamais le service lui-même :
 *
 * - il abonne chaque page au cœur (`frame.states.subscribe`) et renouvelle ses abonnements tant qu’elle est ouverte ;
 *   quand elle se ferme, il les retire : le dernier abonné parti, le fournisseur s’arrête ;
 * - il lit la valeur courante et la pousse à la page tout de suite ;
 * - à chaque changement annoncé par le cœur (`states:changed`, avec les clés touchées), il relit seulement les
 *   abonnements qui dépendent de ces clés (l’état, les entités de sa liste) : une lecture locale, sans requête ;
 * - `refresh()` demande au fournisseur de relire maintenant.
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
}

/** Réponse du cœur (`frame.states.get`). */
export interface StateRead {
  value: unknown;
  empty: boolean;
  updatedAt?: number | null;
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
  /** Dernier rafraîchissement : heure, erreur, prochain passage. */
  status: RefreshStatus | undefined;
}

export interface HubServices<Owner> {
  get(owner: Owner, request: StateRequest): Promise<StateRead>;
  /** Abonne la page au cœur ; rend l’identifiant de l’abonnement. */
  subscribe(owner: Owner, request: StateRequest): Promise<string>;
  unsubscribe(id: string): Promise<unknown>;
  renew(ids: string[]): Promise<unknown>;
  /** Demande au fournisseur de relire l’état maintenant. */
  refresh(owner: Owner, request: StateRequest): Promise<unknown>;
}

interface Watch<Owner> {
  id: string;
  owner: Owner;
  request: StateRequest;
  push: (state: StatePush) => void;
  deps: Set<string>;
  last: StatePush;
  subscription: Promise<string | undefined>;
}

export interface StateHub<Owner> {
  watch(owner: Owner, request: StateRequest, push: (state: StatePush) => void): string;
  unwatch(id: string): void;
  release(owner: Owner): void;
  refresh(id: string): Promise<void>;
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
      send(watch, {
        data: read.empty ? undefined : read.value,
        // Vide et pas encore lu (premier abonnement, lecture à venir ou en cours) : chargement.
        loading: read.empty && (status === undefined || status.running === true || !status.lastRunAt),
        refreshing: status?.running === true,
        updatedAt: read.updatedAt ?? undefined,
        error: status?.lastError ? { message: status.lastError } : undefined,
        status,
      });
    } catch (error) {
      send(watch, { error: { message: error instanceof Error ? error.message : String(error) }, loading: false });
    }
  };

  const drop = (watch: Watch<Owner>) => {
    watches.delete(watch.id);
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
          status: undefined,
        },
        // L’abonnement au cœur : le fournisseur rafraîchit l’état tant qu’il a un abonné.
        subscription: services.subscribe(owner, request).catch((error: unknown) => {
          send(watch, { error: { message: error instanceof Error ? error.message : String(error) }, loading: false });
          return undefined;
        }),
      };
      watches.set(id, watch);
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
      await services.refresh(watch.owner, watch.request).catch(() => undefined);
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
