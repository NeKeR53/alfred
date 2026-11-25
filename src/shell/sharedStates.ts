/**
 * Abonnements des pages aux états partagés (`useAlfredState`). Le cœur tient la seule source de vérité
 * (`src-tauri/src/states.rs`) : états nommés et entités normalisées, par compte et par mode exemple. Ce hub :
 *
 * - lit la valeur courante pour chaque abonnement et la pousse à la page tout de suite ;
 * - à chaque changement annoncé par le cœur (`states:changed`, avec les clés touchées), relit seulement les
 *   abonnements qui dépendent de ces clés (l’état, et les entités de sa liste) : une lecture locale, sans requête ;
 * - quand un état est vide (personne ne l’a encore lu), lance sa lecture une fois (la fonction qui l’alimente) ;
 * - `refresh()` relance cette lecture ; une écriture du module relance celles des états affichés ;
 * - une relecture périodique n’a lieu que si l’état la déclare (`refreshEvery`), une seule pour toutes les fenêtres
 *   (le cœur attribue la relecture à une seule coquille).
 *
 * Sans lecture, un état ne change pas : pas de revalidation en fond.
 */

/** Ce qu’une page demande : un état ou une entité, sa sous-clé, son compte. */
export interface StateRequest {
  /** `module/etat`, ou `etat` dans le module de la page. */
  name: string;
  key?: string;
  instance?: string;
}

/** Réponse du cœur (`frame.states.get`). */
export interface StateRead {
  value: unknown;
  empty: boolean;
  updatedAt?: number | null;
  deps: string[];
  refreshEvery?: number | null;
  instance?: string;
}

/** État poussé à la page. */
export interface StatePush {
  data: unknown;
  error: { message: string } | undefined;
  /** Aucune valeur encore : la première lecture est en cours. */
  loading: boolean;
  /** Une lecture de l’état est en cours. */
  refreshing: boolean;
  updatedAt: number | undefined;
}

export interface HubServices<Owner> {
  /** Lit l’état pour ce demandeur (accord, comptes et mode exemple vérifiés par le cœur). */
  get(owner: Owner, request: StateRequest): Promise<StateRead>;
  /** Lance la lecture qui alimente l’état (la fonction qui le déclare). */
  load(owner: Owner, request: StateRequest): Promise<void>;
  /** Le cœur confie la relecture périodique de cette clé à cette coquille. */
  lease?(key: string, seconds: number): Promise<boolean>;
  /** Module qui déclare l’état (pour relire après une écriture). */
  moduleOf(owner: Owner, request: StateRequest): string;
}

interface Watch<Owner> {
  id: string;
  owner: Owner;
  request: StateRequest;
  push: (state: StatePush) => void;
  deps: Set<string>;
  last: StatePush;
  /** Clé de l’état lui-même (première dépendance) : sert aux lectures et à la relecture périodique. */
  stateKey: string | undefined;
  refreshEvery: number | undefined;
}

export interface StateHub<Owner> {
  watch(owner: Owner, request: StateRequest, push: (state: StatePush) => void): string;
  unwatch(id: string): void;
  /** Ferme les abonnements d’un cadre qui disparaît. */
  release(owner: Owner): void;
  refresh(id: string): Promise<void>;
  /** Le cœur annonce des clés changées. */
  changed(keys: readonly string[]): void;
  /** Une écriture du module : ses états affichés se relisent (une lecture par état). */
  refreshModules(modules: readonly string[]): void;
  /** Abonnements en cours (tests). */
  size(): number;
  clear(): void;
}

const MIN_REFRESH_S = 5;

function stable(request: StateRequest): string {
  return JSON.stringify([request.name, request.key ?? "", request.instance ?? ""]);
}

export function createStateHub<Owner>(services: HubServices<Owner>): StateHub<Owner> {
  const watches = new Map<string, Watch<Owner>>();
  /** Lectures en cours, par état visé (et par demandeur, pour ses comptes) : une seule à la fois. */
  const loading = new Map<string, Promise<void>>();
  const timers = new Map<string, { every: number; timer: ReturnType<typeof setInterval> }>();
  let sequence = 0;

  const send = (watch: Watch<Owner>, next: Partial<StatePush>) => {
    watch.last = { ...watch.last, ...next };
    watch.push(watch.last);
  };

  const loadKey = (watch: Watch<Owner>) => `${watch.stateKey ?? stable(watch.request)}`;

  const reread = async (watch: Watch<Owner>) => {
    try {
      const read = await services.get(watch.owner, watch.request);
      if (!watches.has(watch.id)) return read;
      watch.deps = new Set(read.deps);
      watch.stateKey = read.deps[0];
      watch.refreshEvery = read.refreshEvery ?? undefined;
      schedule();
      if (!read.empty || !loading.has(loadKey(watch)))
        send(watch, {
          data: read.empty ? undefined : read.value,
          loading: read.empty && loading.has(loadKey(watch)),
          updatedAt: read.updatedAt ?? undefined,
          error: undefined,
        });
      return read;
    } catch (error) {
      send(watch, { error: { message: error instanceof Error ? error.message : String(error) }, loading: false });
      return undefined;
    }
  };

  /** Lance la lecture qui alimente l’état, une seule par état visé ; son résultat arrive par `changed`. */
  const load = (watch: Watch<Owner>): Promise<void> => {
    const key = loadKey(watch);
    const running = loading.get(key);
    if (running) return running;
    const peers = () => [...watches.values()].filter((candidate) => loadKey(candidate) === key);
    for (const peer of peers()) send(peer, { refreshing: true, loading: peer.last.data === undefined });
    const run = services.load(watch.owner, watch.request).then(
      () => {
        loading.delete(key);
        for (const peer of peers()) send(peer, { refreshing: false, loading: false, error: undefined });
        // Une lecture qui ne change rien n’annonce rien : la valeur affichée est déjà la bonne. Un état encore vide
        // (la lecture n’a rien rangé) est relu pour sortir du chargement.
        for (const peer of peers()) if (peer.last.data === undefined) void reread(peer);
      },
      (error: unknown) => {
        loading.delete(key);
        const message = error instanceof Error ? error.message : String(error);
        for (const peer of peers()) send(peer, { refreshing: false, loading: false, error: { message } });
      },
    );
    loading.set(key, run);
    return run;
  };

  /** Relecture périodique déclarée par l’état : un minuteur par clé, tant qu’un abonnement la montre. */
  const schedule = () => {
    const wanted = new Map<string, { every: number; watch: Watch<Owner> }>();
    for (const watch of watches.values())
      if (watch.stateKey && watch.refreshEvery && watch.refreshEvery > 0)
        wanted.set(watch.stateKey, { every: Math.max(MIN_REFRESH_S, watch.refreshEvery), watch });
    for (const [key, timer] of timers)
      if (wanted.get(key)?.every !== timer.every) {
        clearInterval(timer.timer);
        timers.delete(key);
      }
    for (const [key, { every }] of wanted) {
      if (timers.has(key)) continue;
      const timer = setInterval(async () => {
        const watch = [...watches.values()].find((candidate) => candidate.stateKey === key);
        if (!watch) return;
        const granted = services.lease ? await services.lease(key, every).catch(() => false) : true;
        if (granted) void load(watch).catch(() => undefined);
      }, every * 1000);
      timers.set(key, { every, timer });
    }
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
        last: { data: undefined, error: undefined, loading: true, refreshing: false, updatedAt: undefined },
        stateKey: undefined,
        refreshEvery: undefined,
      };
      watches.set(id, watch);
      void reread(watch).then((read) => {
        // Personne n’a encore lu cet état : cette page qui s’ouvre le lit, une fois pour toutes les pages.
        if (read?.empty && watches.has(id)) void load(watch).catch(() => undefined);
      });
      return id;
    },
    unwatch(id) {
      watches.delete(id);
      schedule();
    },
    release(owner) {
      for (const [id, watch] of watches) if (watch.owner === owner) watches.delete(id);
      schedule();
    },
    refresh(id) {
      const watch = watches.get(id);
      return watch ? load(watch) : Promise.resolve();
    },
    changed(keys) {
      const touched = new Set(keys);
      for (const watch of watches.values())
        if ([...watch.deps].some((dep) => touched.has(dep)) || watch.deps.size === 0) void reread(watch);
    },
    refreshModules(modules) {
      const targets = new Set(modules);
      const done = new Set<string>();
      for (const watch of watches.values()) {
        const key = loadKey(watch);
        if (done.has(key) || !targets.has(services.moduleOf(watch.owner, watch.request))) continue;
        done.add(key);
        void load(watch).catch(() => undefined);
      }
    },
    size() {
      return watches.size;
    },
    clear() {
      watches.clear();
      loading.clear();
      for (const timer of timers.values()) clearInterval(timer.timer);
      timers.clear();
    },
  };
}
