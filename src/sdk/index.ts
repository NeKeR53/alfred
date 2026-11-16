/**
 * Pont entre une page (ou une fonction) et Alfred. Le cadre isolé n’a ni réseau ni accès au disque : tout passe
 * par ces appels, que la coquille autorise ou refuse selon les accès accordés par l’utilisateur.
 *
 * La référence d’usage est `docs/alfred/SDK.md` dans l’espace.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ALFRED_MESSAGE, type FrameEvent, type FrameRequest, isFrameMessage } from "./protocol";

export class AlfredSdkError extends Error {
  detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "AlfredSdkError";
    this.detail = detail;
  }
}

type Settle = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const pending = new Map<string, Settle>();
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
let sequence = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isFrameMessage(event.data)) return;
    const message = event.data;
    if (message.kind === "response") {
      const settle = pending.get(message.id);
      if (!settle) return;
      pending.delete(message.id);
      if (message.error) settle.reject(new AlfredSdkError(message.error.message, message.error.detail));
      else settle.resolve(message.result);
    } else if (message.kind === "event") {
      for (const handler of eventHandlers.get(message.name) ?? []) handler(message.payload);
    }
  });
}

/** Appel bas niveau ; préférer les fonctions nommées ci-dessous. */
export function request<Result = unknown>(method: string, params: unknown = {}): Promise<Result> {
  listen();
  sequence += 1;
  const id = `r${sequence}`;
  const message: FrameRequest = { alfred: ALFRED_MESSAGE, kind: "request", id, method, params };
  return new Promise<Result>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    window.parent.postMessage(message, "*");
  });
}

/** Signale un événement à la coquille (réservé à l’hôte du cadre). */
export function emitToShell(name: string, payload: unknown = null) {
  const message: FrameEvent = { alfred: ALFRED_MESSAGE, kind: "event", name, payload };
  window.parent.postMessage(message, "*");
}

/** Écoute un événement de la coquille ; renvoie la fonction de désabonnement. */
export function onShellEvent(name: string, handler: (payload: unknown) => void): () => void {
  listen();
  const handlers = eventHandlers.get(name) ?? new Set();
  handlers.add(handler);
  eventHandlers.set(name, handlers);
  return () => {
    handlers.delete(handler);
  };
}

// --- Base de données de l’espace -------------------------------------------------------------------------------

export type SqlValue = string | number | boolean | null;

export const db = {
  /** Exécute une requête de lecture et renvoie les lignes, chacune sous forme d’objet colonne → valeur. */
  query<Row = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<Row[]> {
    return request<Row[]>("db.query", { sql, params });
  },
  /** Exécute une écriture ; renvoie le nombre de lignes touchées et l’identifiant de la dernière insertion. */
  execute(sql: string, params: SqlValue[] = []): Promise<{ changes: number; lastInsertId: number }> {
    return request("db.execute", { sql, params });
  },
};

// --- Fichiers du module ---------------------------------------------------------------------------------------

/** Fichier rangé par Alfred pour le module (pièce jointe, PDF, image, document généré). */
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  /** Taille en octets. */
  size: number;
  sha256: string;
  createdAt: string;
}

/**
 * Fichiers du module, rangés par Alfred hors de l’espace versionné et copiés avec les sauvegardes. Chaque module
 * ne voit que les siens ; 50 Mo par fichier.
 */
export const files = {
  /** Range un contenu : `data` en base64 (une adresse `data:` est acceptée) ou `text`. */
  save(options: { name: string; data?: string; text?: string; mime?: string }): Promise<FileInfo> {
    return request("files.save", options);
  },
  /** Fichiers du module, du plus récent au plus ancien ; `prefix` filtre sur le nom. */
  list(options: { prefix?: string; limit?: number } = {}): Promise<FileInfo[]> {
    return request("files.list", options);
  },
  get(id: string): Promise<FileInfo> {
    return request("files.get", { id });
  },
  /** Contenu en base64. */
  read(id: string): Promise<{ info: FileInfo; data: string }> {
    return request("files.read", { id });
  },
  /** Contenu lu comme du texte UTF-8. */
  readText(id: string): Promise<string> {
    return request("files.readText", { id });
  },
  remove(id: string): Promise<void> {
    return request<void>("files.remove", { id });
  },
  /** Ouvre le fichier avec l’application du système (page ou panneau seulement). */
  open(id: string): Promise<void> {
    return request<void>("files.open", { id });
  },
  /** Fait choisir des fichiers à l’utilisateur sur son disque et les copie dans le module ; `[]` s’il annule. */
  pick(options: { accept?: string[]; multiple?: boolean } = {}): Promise<FileInfo[]> {
    return request("files.pick", options);
  },
  /** « Enregistrer sous… » : l’utilisateur choisit où copier le fichier ; `false` s’il annule. */
  export(id: string): Promise<boolean> {
    return request("files.export", { id });
  },
  /** Adresse `data:` d’une image du module (5 Mo au plus), pour `<Image src>`. */
  dataUrl(id: string): Promise<string> {
    return request("files.dataUrl", { id });
  },
};

// --- Clients déclarés ------------------------------------------------------------------------------------------

export interface ClientRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Chemin relatif à l’adresse de base du client, par exemple « /rest/api/2/issue/ABC-1 ». */
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  /** Objet envoyé en JSON, ou chaîne envoyée telle quelle. */
  body?: unknown;
}

export interface ClientResponse<Body = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** JSON décodé quand la réponse en est, sinon le texte. */
  body: Body;
}

/** Instance d’un client : un compte ou une installation du service, ajoutée par l’utilisateur dans les Réglages. */
export interface ClientInstance {
  id: string;
  label: string;
  /** Instance utilisée quand une requête n’en nomme pas. */
  default: boolean;
}

export interface ClientOptions {
  /** Instance à appeler ; à défaut, celle par défaut. */
  instance?: string;
}

/**
 * Client déclaré dans l’espace. Alfred exécute la requête et y ajoute l’authentification : la page ne voit jamais
 * le secret et ne peut joindre que l’adresse de base de l’instance appelée.
 */
export function client(id: string, options: ClientOptions = {}) {
  const instance = options.instance;
  const send = <Body>(call: ClientRequest) =>
    request<ClientResponse<Body>>("clients.request", { client: id, ...call, ...(instance ? { instance } : {}) });
  return {
    request: send,
    get: <Body = unknown>(path: string, query?: ClientRequest["query"]) => send<Body>({ method: "GET", path, query }),
    post: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "POST", path, body }),
    put: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "PUT", path, body }),
    patch: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "PATCH", path, body }),
    delete: <Body = unknown>(path: string) => send<Body>({ method: "DELETE", path }),
    /** Instances du client, la première étant celle par défaut. */
    instances: () => request<ClientInstance[]>("clients.instances", { client: id }),
  };
}

// --- Fonctions -------------------------------------------------------------------------------------------------

export const functions = {
  /** Appelle une fonction de l’espace : « fonction » pour le module courant, « module/fonction » sinon. */
  call<Output = unknown>(reference: string, input: unknown = {}): Promise<Output> {
    return request<Output>("functions.call", { function: reference, input });
  },
};

// --- IA --------------------------------------------------------------------------------------------------------

export interface OneShotOptions {
  /** Ce que le modèle doit produire. */
  instruction: string;
  /** Données de la page utiles à la réponse (objet sérialisable ou texte). */
  context?: unknown;
  /** Schéma JSON de la réponse attendue ; Alfred valide la réponse et relance une fois si elle est invalide. */
  schema: Record<string, unknown>;
}

export interface AgentStartOptions {
  /** Consigne de départ de l’agent. */
  instruction: string;
  /** Contexte de la page transmis à l’agent. */
  context?: unknown;
  /** Titre de la conversation. */
  title?: string;
  /** Fonctions que l’agent peut appeler comme outils, en plus de celles déjà proposées aux agents. */
  functions?: string[];
  /** Schéma JSON du résultat attendu en fin de conversation. */
  resultSchema?: Record<string, unknown>;
}

export const ai = {
  /** Appel unique : une consigne et un contexte entrent, un objet conforme au schéma sort. Sans outil. */
  oneShot<Output = unknown>(options: OneShotOptions): Promise<Output> {
    return request<Output>("ai.oneShot", options);
  },
  /**
   * Lance une conversation d’agent, affichée dans le panneau de droite de la page. La promesse se résout à la fin
   * du premier tour, avec le dernier message de l’agent et, si un schéma est fourni, son résultat structuré.
   */
  startAgent<Result = unknown>(
    options: AgentStartOptions,
  ): Promise<{ conversationId: string; message: string; result?: Result }> {
    return request("ai.startAgent", options);
  },
};

// --- Voix ------------------------------------------------------------------------------------------------------

export const voice = {
  /**
   * Lit `text` à voix haute avec la voix d’Alfred (Réglages › Voix) et se résout à la fin de la lecture.
   * Une nouvelle lecture coupe la précédente ; `interrupted` dit si celle-ci a été coupée avant la fin.
   */
  speak(text: string): Promise<{ interrupted: boolean }> {
    return request("voice.speak", { text });
  },
  /** Coupe la lecture en cours, quelle qu’en soit l’origine. */
  stopSpeaking(): Promise<void> {
    return request<void>("voice.stopSpeaking", {});
  },
  /**
   * Ouvre le micro (page ou panneau seulement). La première fois, l’utilisateur l’accorde à la page. La promesse se
   * résout quand l’écoute a commencé, après le chargement du modèle de transcription au premier usage.
   */
  startListening(): Promise<void> {
    return request<void>("voice.startListening", {});
  },
  /** Ferme le micro et rend la transcription (vide si rien de net n’a été entendu). */
  stopListening(): Promise<{ text: string }> {
    return request("voice.stopListening", {});
  },
  /** Ferme le micro sans rien transcrire. */
  cancelListening(): Promise<void> {
    return request<void>("voice.cancelListening", {});
  },
};

// --- Coquille --------------------------------------------------------------------------------------------------

export interface PageContext {
  /** Référence de la page : « module/page ». */
  reference: string;
  module: string;
  page: string;
  /** « page » ou « panel ». */
  kind: "page" | "panel";
  /** Où la page est affichée : une section du menu, ou les Réglages (qui ont leur propre style de lignes). */
  surface: "section" | "settings";
  theme: "light" | "dark";
  /** Pour un panneau : la sélection publiée par la page hôte (`shell.publish`). */
  selection: unknown;
  /**
   * Dans une section par instance (`perInstance`) : l’instance du client que montre la page. `client()` l’appelle
   * alors sans qu’on la nomme. `null` ailleurs.
   */
  instance: string | null;
}

export const shell = {
  /**
   * Affiche une notification dans Alfred (surimpression et centre de notifications). Quand aucune fenêtre d’Alfred
   * n’est au premier plan, elle part aussi au centre de notifications du système.
   */
  notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }) {
    return request<void>("shell.notify", options);
  },
  /** Ouvre une autre page de l’espace (« module/page », ou « module/page@instance » dans une section par instance). */
  navigate(reference: string) {
    return request<void>("shell.navigate", { reference });
  },
  /**
   * Ouvre une page de l’espace seule dans sa propre fenêtre (sans argument : la page elle-même), ou ramène au
   * premier plan la fenêtre qui l’affiche déjà.
   */
  openWindow(reference?: string) {
    return request<void>("shell.openWindow", reference ? { reference } : {});
  },
  /** Affiche ou masque le panneau de droite de la page. */
  setPanelVisible(visible: boolean) {
    return request<void>("shell.setPanelVisible", { visible });
  },
  /** Publie la sélection courante de la page ; son panneau de droite la reçoit dans son contexte. */
  publish(selection: unknown) {
    return request<void>("shell.publish", { selection });
  },
  /** Ouvre une adresse web dans le navigateur du système. */
  openExternal(url: string) {
    return request<void>("shell.openExternal", { url });
  },
  /**
   * Envoie un message à l’autre cadre de la page : de la page vers son panneau de droite, ou du panneau vers sa
   * page. L’autre côté le reçoit avec `usePeerMessage`.
   */
  send(message: unknown) {
    return request<void>("shell.send", { message });
  },
};

// --- Compteur de la page ---------------------------------------------------------------------------------------

export interface BadgeOptions {
  /**
   * Autre page du même module dont régler le compteur (« boite », ou « boite@instance »). Sans elle, la page
   * elle-même (un panneau règle celui de sa page). Obligatoire depuis une fonction.
   */
  page?: string;
}

/**
 * Compteur affiché en pastille sur l’entrée de la page dans le menu de gauche (somme des pages de la section) et
 * sur son onglet, tant qu’il est supérieur à zéro. Il est conservé d’un lancement à l’autre, jusqu’à ce que la page
 * ou une fonction de son module le change. Chaque appel rend la nouvelle valeur.
 */
export const badge = {
  /** Fixe le compteur (0 l’efface). */
  set(count: number, options: BadgeOptions = {}): Promise<{ count: number }> {
    return request("badge.update", { op: "set", value: count, ...options });
  },
  /** Ajoute `by` (1 par défaut, négatif pour retirer) ; le compteur ne descend pas sous zéro. */
  increment(by = 1, options: BadgeOptions = {}): Promise<{ count: number }> {
    return request("badge.update", { op: "increment", value: by, ...options });
  },
  /** Remet le compteur à zéro : la pastille disparaît. */
  clear(options: BadgeOptions = {}): Promise<{ count: number }> {
    return request("badge.update", { op: "set", value: 0, ...options });
  },
};

/** Reçoit les messages envoyés par l’autre cadre de la page (`shell.send`). */
export function usePeerMessage(handler: (message: unknown) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => onShellEvent("peer", (message) => latest.current(message)), []);
}

let currentContext: PageContext | undefined;

/** Contexte de la page, tenu à jour (thème, sélection reçue par un panneau). */
export function usePageContext(): PageContext | undefined {
  const [context, setContext] = useState(currentContext);
  useEffect(() => {
    let active = true;
    void request<PageContext>("shell.context").then((value) => {
      currentContext = value;
      if (active) setContext(value);
    });
    const stop = onShellEvent("context", (payload) => {
      currentContext = payload as PageContext;
      setContext(currentContext);
    });
    return () => {
      active = false;
      stop();
    };
  }, []);
  return context;
}

export interface AsyncState<Data> {
  data: Data | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Relance le chargement. */
  reload: () => void;
}

/**
 * Charge une donnée asynchrone et expose son état. `deps` relance le chargement comme pour `useEffect`.
 * Exemple : `useAsync(() => db.query("SELECT * FROM suivi_taches"), [])`.
 */
export function useAsync<Data>(load: () => Promise<Data>, deps: ReadonlyArray<unknown>): AsyncState<Data> {
  const [state, setState] = useState<{ data?: Data; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: les dépendances sont celles de l’appelant.
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: undefined }));
    loader.current().then(
      (data) => active && setState({ data, loading: false }),
      (error: unknown) =>
        active && setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      active = false;
    };
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
