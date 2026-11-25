/**
 * Pont entre une page (ou une fonction) et Alfred. Le cadre isolé n’a ni réseau ni accès au disque : tout passe
 * par ces appels, que la coquille autorise ou refuse selon les accès accordés par l’utilisateur.
 *
 * La référence d’usage est `docs/alfred/SDK.md` dans l’espace.
 */
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALFRED_MESSAGE, type FrameEvent, type FrameRequest, isFrameMessage } from "./protocol";
import { matchesSearch, searchTerms } from "./textSearch";

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

// --- Historique des données ----------------------------------------------------------------------------------

/** Un changement d’une ligne, gardé pour une table nommée dans `history` du module. */
export interface Change<Row = Record<string, unknown>> {
  id: number;
  table: string;
  /** Clé de la ligne (sa clé primaire, en texte), ou son rowid si la clé n’est pas une seule colonne. */
  key: string | null;
  op: "insert" | "update" | "delete";
  /** La ligne avant le changement (`null` pour une insertion) ; un BLOB s’écrit `{ $blob: "<hex>" }`. */
  before: Row | null;
  /** La ligne après le changement (`null` pour une suppression). */
  after: Row | null;
  /** Qui : « page:module/page », « function:module/fonction », « agent », « alfred », suivi de « (annulation) ». */
  actor: string;
  at: string;
}

/** Historique des tables déclarées dans `history` de `module.json` : qui a changé quoi, et retour en arrière. */
export const history = {
  /** Changements, les plus récents d’abord ; `table` et `key` les limitent à une table et à une ligne. */
  list<Row = Record<string, unknown>>(
    options: { table?: string; key?: string | number; limit?: number } = {},
  ): Promise<Change<Row>[]> {
    return request("history.list", options);
  },
  /** Remet la ligne dans l’état d’avant ce changement ; rend le changement annulé. */
  revert(id: number): Promise<Change> {
    return request("history.revert", { id });
  },
};

// --- Événements entre modules ---------------------------------------------------------------------------------

/** Ce que reçoit la fonction abonnée à un événement. */
export interface ModuleEvent<Payload = unknown> {
  /** « module/événement ». */
  event: string;
  /** Module qui l’a publié. */
  from: string;
  payload: Payload;
  publishedAt: string;
}

/**
 * Événements du module : il publie ceux qu’il déclare dans `events.publishes` ; les fonctions des modules abonnés
 * (`events.subscribes`) les reçoivent, sans que le module qui publie les connaisse.
 */
export const events = {
  /** Publie l’événement `event` (identifiant local) ; rend le nombre d’abonnés qui le recevront. */
  publish(
    event: string,
    payload: unknown = null,
    options: { occurrence?: string } = {},
  ): Promise<{ event: string; subscribers: number; duplicate?: boolean }> {
    return request("events.publish", {
      event,
      payload,
      ...(options.occurrence ? { occurrence: options.occurrence } : {}),
    });
  },
};

// --- Recherche plein texte ------------------------------------------------------------------------------------

export interface SearchResult<Key = string | number> {
  /** Valeur de la colonne `key` de l’index : l’identifiant de la ligne trouvée. */
  key: Key;
  /** Pertinence : plus grand = meilleur. */
  score: number;
  /** Extrait du texte autour des mots trouvés. */
  snippet: string;
  /** Le même extrait en morceaux, `match` pour les mots trouvés (à mettre en gras). */
  parts: { text: string; match: boolean }[];
}

export interface SearchOptions {
  /** 20 par défaut, 200 au plus. */
  limit?: number;
  offset?: number;
  /** Chaque mot peut n’être qu’un début de mot (vrai par défaut : recherche pendant la frappe). */
  prefix?: boolean;
  /** Le texte est une requête FTS5 (`"mot exact"`, `OR`, `NOT`, `NEAR`, `colonne:mot`) au lieu de mots libres. */
  raw?: boolean;
}

/** Recherche plein texte dans un index déclaré par le module (`search` de `module.json`). */
export const search = {
  query<Key = string | number>(
    index: string,
    text: string,
    options: SearchOptions = {},
  ): Promise<{ total: number; results: SearchResult<Key>[] }> {
    return request("search.query", { index, text, ...options });
  },
};

// --- Commandes du poste ---------------------------------------------------------------------------------------

export interface CommandResult {
  /** Code de sortie (`null` si le programme a été tué par un signal). */
  code: number | null;
  /** Vrai si le code vaut 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** La sortie standard dépassait 1 Mo : elle est coupée. */
  truncated: boolean;
}

/**
 * Programmes installés sur l’ordinateur (`git`, `ffmpeg`, `pandoc`…), lancés sans shell dans le dossier du module,
 * ou dans un dossier accordé (`cwd`). L’utilisateur accorde chaque programme une fois.
 */
export const commands = {
  /** Lance `program` (son nom seul) avec `args` tels quels ; un code non nul ne rejette pas la promesse. */
  run(
    program: string,
    args: string[] = [],
    options: { input?: string; timeout?: number; cwd?: { folder: string; path?: string } } = {},
  ): Promise<CommandResult> {
    return request("commands.run", { program, args, ...options });
  },
};

// --- Dossiers du poste et Git local ---------------------------------------------------------------------------

/** Dossier du poste accordé au module (ses pages, ses panneaux et ses fonctions). */
export interface Folder {
  /** Identifiant stable dans le module, à garder en base : c’est lui que nomment les appels. */
  id: string;
  /** Chemin absolu sur le poste. */
  path: string;
  label: string;
  grantedAt: string;
  grantedBy: "user" | "agent";
}

export interface FolderEntry {
  /** Relatif au dossier accordé, avec des `/`. */
  path: string;
  name: string;
  kind: "file" | "dir" | "link";
  size: number;
  modifiedAt: string | null;
}

/**
 * Dossiers du poste que l’utilisateur a accordés au module. Chaque `path` est relatif au dossier et n’en sort pas
 * (ni `..`, ni lien symbolique) ; rien ne s’écrit dans `.git`. 20 Mo par fichier.
 */
export const folders = {
  /** Fait choisir un dossier à l’utilisateur et l’accorde au module (page ou panneau) ; `null` s’il annule. */
  pick(options: { title?: string; label?: string } = {}): Promise<Folder | null> {
    return request("folders.pick", options);
  },
  list(): Promise<Folder[]> {
    return request("folders.list");
  },
  get(folder: string): Promise<Folder> {
    return request("folders.get", { folder });
  },
  /** Retire l’accord (les fichiers restent sur le disque). */
  forget(folder: string): Promise<void> {
    return request<void>("folders.forget", { folder });
  },
  /** Entrées de `path` (le dossier par défaut) ; `glob` (`*.md`, ou un chemin avec `**` et `/`) parcourt les sous-dossiers s’il contient `/`. */
  entries(
    folder: string,
    path = "",
    options: { recursive?: boolean; glob?: string } = {},
  ): Promise<{ entries: FolderEntry[]; truncated: boolean }> {
    return request("folders.entries", { folder, path, ...options });
  },
  /** L’entrée, ou `null` si elle n’existe pas. */
  stat(folder: string, path: string): Promise<FolderEntry | null> {
    return request("folders.stat", { folder, path });
  },
  readText(folder: string, path: string): Promise<string> {
    return request("folders.readText", { folder, path });
  },
  /** Contenu en base64. */
  readFile(folder: string, path: string): Promise<{ data: string }> {
    return request("folders.readFile", { folder, path });
  },
  /** Écriture atomique ; les dossiers parents sont créés. */
  writeText(folder: string, path: string, text: string): Promise<void> {
    return request<void>("folders.writeText", { folder, path, text });
  },
  writeFile(folder: string, path: string, data: string): Promise<void> {
    return request<void>("folders.writeFile", { folder, path, data });
  },
  /** Fichier JSON (une configuration partagée de l’équipe). */
  async readJson<Data = unknown>(folder: string, path: string): Promise<Data> {
    const text = await folders.readText(folder, path);
    try {
      return JSON.parse(text) as Data;
    } catch (error) {
      throw new AlfredSdkError(`« ${path} » n’est pas du JSON valide.`, String(error));
    }
  },
  /** Écrit du JSON indenté de deux espaces, terminé par un retour à la ligne : un diff lisible dans git. */
  writeJson(folder: string, path: string, data: unknown): Promise<void> {
    return folders.writeText(folder, path, `${JSON.stringify(data, null, 2)}\n`);
  },
  mkdir(folder: string, path: string): Promise<void> {
    return request<void>("folders.mkdir", { folder, path });
  },
  /** Vers la corbeille du système. */
  remove(folder: string, path: string): Promise<void> {
    return request<void>("folders.remove", { folder, path });
  },
  /** Renomme ou déplace dans le dossier, sans écraser. */
  rename(folder: string, path: string, to: string): Promise<void> {
    return request<void>("folders.rename", { folder, path, to });
  },
  /** Ouvre dans l’explorateur (défaut), l’éditeur de code ou un terminal du poste (page ou panneau). */
  open(folder: string, path = "", app: "explorer" | "editor" | "terminal" = "explorer"): Promise<{ opened: string }> {
    return request("folders.open", { folder, path, app });
  },
  /**
   * Prévient à chaque lot de changements dans le dossier : chemins relatifs, `.git` (ou `api/.git`) pour l’état
   * d’un dépôt (branche, index). Rend la fonction de désabonnement.
   */
  async watch(folder: string, handler: (paths: string[]) => void): Promise<() => void> {
    const stop = onShellEvent("folderChanged", (payload) => {
      const change = payload as { folder?: string; paths?: string[] } | null;
      if (change?.folder === folder) handler(change.paths ?? []);
    });
    try {
      await request<void>("folders.watch", { folder });
    } catch (error) {
      stop();
      throw error;
    }
    return stop;
  },
};

export interface GitFileStatus {
  path: string;
  from?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  /** Dossier du dépôt, relatif au dossier accordé. */
  repo: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileStatus[];
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

export interface GitBranch {
  name: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  remote: string | null;
  date: string;
  subject: string;
}

export interface GitTag {
  name: string;
  commit: string;
  annotated: boolean;
  date: string;
  message: string;
}

export interface GitCommit {
  id: string;
  message: string;
  date: string;
  author: string;
  files: string[];
  lines: Array<{ added: number; removed: number } | null>;
}

/** `repo` : le dépôt, relatif au dossier accordé (le dossier lui-même par défaut). */
type InRepo = { repo?: string };

/**
 * Git dans un dossier accordé : sans crochet, avec les identifiants, le proxy et les certificats du poste. Les
 * chemins (`file`, `paths`) sont relatifs au dépôt.
 */
export const git = {
  /** Dépôts du dossier, sur trois niveaux (les composants d’un produit). */
  repositories(folder: string): Promise<Array<{ repo: string; name: string }>> {
    return request("git.repositories", { folder });
  },
  status(folder: string, options: InRepo = {}): Promise<GitStatus> {
    return request("git.status", { folder, ...options });
  },
  branches(
    folder: string,
    options: InRepo = {},
  ): Promise<{ current: string | null; local: GitBranch[]; remote: GitBranch[] }> {
    return request("git.branches", { folder, ...options });
  },
  /** Du plus récent au plus ancien. */
  tags(folder: string, options: InRepo = {}): Promise<GitTag[]> {
    return request("git.tags", { folder, ...options });
  },
  log(
    folder: string,
    options: InRepo & { ref?: string; file?: string; since?: string; limit?: number } = {},
  ): Promise<GitCommit[]> {
    return request("git.log", { folder, ...options });
  },
  /** Écart : commits de `head` (HEAD par défaut) absents de `base` (`ahead`, `commits`) et l’inverse (`behind`). */
  compare(
    folder: string,
    options: InRepo & { base: string; head?: string },
  ): Promise<{ base: string; head: string; ahead: number; behind: number; commits: GitCommit[] }> {
    return request("git.compare", { folder, ...options });
  },
  /** Sans `from` : les changements non indexés (`staged` : ceux indexés). 2 Mo de texte au plus. */
  diff(
    folder: string,
    options: InRepo & { from?: string; to?: string; file?: string; staged?: boolean } = {},
  ): Promise<{
    text: string;
    truncated: boolean;
    files: Array<{ path: string; added: number | null; removed: number | null }>;
  }> {
    return request("git.diff", { folder, ...options });
  },
  /** Contenu d’un fichier à une révision. */
  show(folder: string, ref: string, file: string, options: InRepo = {}): Promise<string> {
    return request("git.show", { folder, ref, file, ...options });
  },
  fetch(folder: string, options: InRepo & { remote?: string } = {}): Promise<GitStatus> {
    return request("git.fetch", { folder, ...options });
  },
  /** Avance rapide seulement ; `rebase: true` rejoue les commits locaux (annulé en cas de conflit). */
  pull(folder: string, options: InRepo & { rebase?: boolean } = {}): Promise<GitStatus> {
    return request("git.pull", { folder, ...options });
  },
  /** Branche courante (ou `branch`) vers son distant, suivie s’il le faut ; ou un `tag`. Jamais de force. */
  push(
    folder: string,
    options: InRepo & { remote?: string; branch?: string; tag?: string } = {},
  ): Promise<{ remote: string; branch?: string; tag?: string }> {
    return request("git.push", { folder, ...options });
  },
  /** `paths` : seulement ces chemins (nouveaux fichiers compris) ; sinon tout. `commit` vaut `null` si rien n’a changé. */
  commit(folder: string, options: InRepo & { message: string; paths?: string[] }): Promise<{ commit: string | null }> {
    return request("git.commit", { folder, ...options });
  },
  /** Change de branche ; `create` la crée (depuis `start`). Une branche distante seule devient locale. */
  switch(
    folder: string,
    branch: string,
    options: InRepo & { create?: boolean; start?: string } = {},
  ): Promise<GitStatus> {
    return request("git.switch", { folder, branch, ...options });
  },
  /** Tag annoté avec `message`, léger sinon ; `git.push(folder, { tag })` pour le partager. */
  createTag(folder: string, options: InRepo & { name: string; ref?: string; message?: string }): Promise<void> {
    return request<void>("git.createTag", { folder, ...options });
  },
  /** Clone `url` (https ou ssh) dans `path`, un sous-dossier neuf du dossier accordé. */
  clone(folder: string, url: string, path: string): Promise<void> {
    return request<void>("git.clone", { folder, url, path });
  },
};

// --- Recherche par le sens ------------------------------------------------------------------------------------

/**
 * Recherche sémantique dans un index déclaré par le module (`semantic` de `module.json`) : les lignes dont le sens
 * est le plus proche de la question, même sans mot en commun. Le modèle tourne sur l’ordinateur.
 */
export const semantic = {
  /** `score` : similarité de -1 à 1, plus grand = plus proche. `pending` : lignes pas encore calculées. */
  search<Key = string | number>(
    index: string,
    text: string,
    options: { limit?: number } = {},
  ): Promise<{ pending: number; results: { key: Key; score: number }[] }> {
    return request("semantic.search", { index, text, ...options });
  },
  /** Lignes calculées et en attente ; `model` : « ready », « missing » (pas téléchargé) ou « downloading ». */
  status(index: string): Promise<{ indexed: number; pending: number; model: "ready" | "missing" | "downloading" }> {
    return request("semantic.status", { index });
  },
};

// --- Tâches de fond -------------------------------------------------------------------------------------------

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job<Result = unknown> {
  id: string;
  module: string;
  function: string;
  title: string;
  input: unknown;
  /** Nombre d’étapes faites. */
  step: number;
  status: JobStatus;
  /** De 0 à 1, telle que la dernière étape l’a donnée. */
  progress: number | null;
  message: string | null;
  result: Result | null;
  error: string | null;
  attempts: number;
  cancelRequested: boolean;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Ce que reçoit la fonction d’une tâche de fond, à chaque étape. */
export interface JobStep<Input = unknown, State = unknown> {
  input: Input;
  /** État rendu par l’étape précédente ; `null` à la première. */
  state: State | null;
  /** Numéro de l’étape, à partir de 0. */
  step: number;
  job: { id: string; title: string };
}

/**
 * Travail long, découpé en étapes : Alfred rappelle la fonction du module tant qu’elle ne rend pas `done: true`,
 * en lui passant l’état laissé par l’étape précédente. Une tâche reprend après une fermeture d’Alfred, s’annule
 * entre deux étapes, et l’utilisateur la suit dans la fiche du module (Réglages → Modules).
 */
export const jobs = {
  /** Lance la fonction `fonction` du module en tâche de fond ; rend la tâche, qui attend son tour. */
  start(fonction: string, input: unknown = {}, options: { title?: string } = {}): Promise<Job> {
    return request("jobs.start", { function: fonction, input, ...options });
  },
  get<Result = unknown>(id: string): Promise<Job<Result>> {
    return request("jobs.get", { id });
  },
  /** Tâches du module, les plus récentes d’abord. */
  list(options: { status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    return request("jobs.list", options);
  },
  /** Annule tout de suite une tâche qui attend, après l’étape en cours une tâche qui tourne. */
  cancel(id: string): Promise<Job> {
    return request("jobs.cancel", { id });
  },
  /** Reprend une tâche en échec ou annulée, à l’étape où elle s’était arrêtée. */
  resume(id: string): Promise<Job> {
    return request("jobs.resume", { id });
  },
};

// --- Automatisations ------------------------------------------------------------------------------------------

/**
 * Automatisations de l’utilisateur (Réglages → Automatisations) : une fonction lancée par un planning, un appel
 * HTTP local ou un script. `trigger` lance celle qui se déclenche « par un script », validée et active, et rend la
 * sortie de sa fonction ; celle-ci reçoit `data` dans `input.event.data` et le demandeur dans `input.event.from`.
 */
export const automations = {
  trigger<Output = unknown>(id: string, data?: unknown): Promise<Output> {
    return request("automations.trigger", data === undefined ? { id } : { id, event: data });
  },
};

// --- Documents ------------------------------------------------------------------------------------------------

type CellValue = string | number | boolean | null;

/** Bloc d’un PDF produit par `documents.pdf`. */
export type DocumentBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[]; ordered?: boolean }
  | { type: "table"; columns: string[]; rows: CellValue[][]; widths?: number[] }
  | { type: "pageBreak" };

/** Produit des documents (rangés comme fichiers du module) et lit le texte de ceux qu’on reçoit. */
export const documents = {
  /** PDF A4 : titre facultatif, puis les blocs dans l’ordre ; pages numérotées. */
  pdf(options: { name: string; title?: string; blocks: DocumentBlock[] }): Promise<FileInfo> {
    return request("documents.pdf", options);
  },
  /** CSV en UTF-8, séparé par `;` par défaut (Excel en français l’ouvre tel quel). */
  csv(options: { name: string; columns?: string[]; rows: CellValue[][]; separator?: string }): Promise<FileInfo> {
    return request("documents.csv", options);
  },
  /** Classeur Excel (.xlsx) : une feuille par entrée, en-têtes en gras. */
  xlsx(options: {
    name: string;
    sheets: { name?: string; columns?: string[]; rows: CellValue[][] }[];
  }): Promise<FileInfo> {
    return request("documents.xlsx", options);
  },
  /** Texte d’un fichier du module : PDF (pages séparées par un saut de page `\f`), Word (.docx) ou texte. */
  extractText(id: string): Promise<{ text: string; pages: number | null; truncated: boolean }> {
    return request("documents.extractText", { id });
  },
};

// --- Clients déclarés ------------------------------------------------------------------------------------------

export interface ClientRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Chemin relatif à l’adresse de base du client, par exemple « /rest/api/2/issue/ABC-1 ». */
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  /** Objet envoyé en JSON, ou chaîne envoyée telle quelle. Un seul de `body`, `form`, `multipart` et `file`. */
  body?: unknown;
  /** Formulaire `application/x-www-form-urlencoded`. */
  form?: Record<string, string | number | boolean>;
  /** Formulaire `multipart/form-data` : champs texte et fichiers du module (pièces jointes), 2 Go au plus. */
  multipart?: MultipartPart[];
  /** Identifiant d’un fichier du module, envoyé tel quel avec son type (dépôt d’un artefact par `PUT`), 2 Go au plus. */
  file?: string;
  /**
   * Forme de `body` dans la réponse : `"auto"` (JSON décodé, sinon texte), `"text"`, ou `"base64"` pour un petit
   * binaire (5 Mo au plus ; au-delà, `download`).
   */
  responseType?: "auto" | "text" | "base64";
  /**
   * Lecture (`GET`, `HEAD`) : garder la réponse réussie ce nombre de secondes (un jour au plus) et la resservir
   * sans rappeler le service. À défaut, la durée `cache` du besoin dans `module.json`.
   */
  cache?: number;
  /**
   * Remplacer les références de secret du corps (`body`, `form`) par leurs valeurs, en natif. Admis seulement vers
   * un chemin que le client déclare scellé (`sealed`), avec des références lues par ce module sur le même service
   * (recopie d’une valeur d’un coffre vers un autre compte). Sans lui, une référence dans le corps est refusée.
   */
  sealed?: boolean;
}

/** Partie d’un envoi `multipart` : un champ texte, ou un fichier du module (`file` : son identifiant). */
export type MultipartPart =
  | { name: string; value: string | number | boolean }
  | { name: string; file: string; filename?: string; mime?: string };

/** Requête d’un téléchargement, d’un flux ou d’un WebSocket : comme `ClientRequest`, sans cache. */
export type ClientTransferRequest = Omit<ClientRequest, "path" | "cache" | "responseType">;

export interface ClientDownload {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Le fichier rangé dans les fichiers du module ; `null` si le service a répondu par une erreur. */
  file: FileInfo | null;
  /** Réponse du service quand `ok` est faux (JSON décodé, sinon texte). */
  body?: unknown;
}

export interface ClientChannel {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Identifiant du canal, à passer à la page ; `null` si le service a répondu par une erreur. */
  channel: string | null;
  /** Réponse du service quand `ok` est faux. */
  body?: unknown;
  /** Flux : découpage retenu. */
  format?: "lines" | "sse" | "docker" | "raw";
  /** WebSocket : sous-protocole accepté par le service. */
  protocol?: string | null;
}

export interface ClientResponse<Body = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** JSON décodé quand la réponse en est, sinon le texte. */
  body: Body;
  /** Réponse resservie par le cache d’Alfred, et son âge en secondes. */
  cached?: boolean;
  cacheAge?: number;
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

/** Paramètres non secrets du compte appelé (royaume, montage, endpoint), saisis par l’utilisateur avec le compte. */
export interface ClientParams {
  /** Compte dont viennent les paramètres. */
  instance: string;
  params: Record<string, string>;
}

/**
 * Client déclaré dans l’espace, **pour les fonctions du connecteur seulement** : une requête venue d’une page ou d’un
 * panneau est refusée (la page appelle la fonction avec `functions.call`). Alfred exécute la requête et y ajoute
 * l’authentification : la fonction ne voit jamais le secret et ne peut joindre que l’adresse de base de l’instance
 * appelée. `instances()` reste permis aux pages, pour proposer un choix de compte.
 */
export function client(id: string, options: ClientOptions = {}) {
  const instance = options.instance;
  const send = <Body>(call: ClientRequest) =>
    request<ClientResponse<Body>>("clients.request", { client: id, ...call, ...(instance ? { instance } : {}) });
  return {
    request: send,
    get: <Body = unknown>(path: string, query?: ClientRequest["query"], options: { cache?: number } = {}) =>
      send<Body>({ method: "GET", path, query, ...options }),
    post: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "POST", path, body }),
    put: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "PUT", path, body }),
    patch: <Body = unknown>(path: string, body?: unknown) => send<Body>({ method: "PATCH", path, body }),
    delete: <Body = unknown>(path: string) => send<Body>({ method: "DELETE", path }),
    /**
     * Télécharge en flux dans les fichiers du module (2 Go au plus), avec son SHA-256, sans passer par la fonction.
     * `name` : nom du fichier ; à défaut, celui que donne le service, puis le dernier segment du chemin.
     */
    download: (path: string, options: ClientTransferRequest & { name?: string } = {}) =>
      request<ClientDownload>("clients.download", { client: id, path, ...options, ...(instance ? { instance } : {}) }),
    /**
     * Ouvre une réponse en continu (SSE, journal suivi, journaux Docker) et rend l’identifiant de son canal, que la
     * page lit par `channels.read` ou `useChannel`. `format` : `"auto"` (d’après le type de la réponse), `"lines"`,
     * `"sse"`, `"docker"` ou `"raw"` (morceaux en base64).
     */
    stream: (
      path: string,
      options: ClientTransferRequest & { format?: "auto" | "lines" | "sse" | "docker" | "raw" } = {},
    ) => request<ClientChannel>("clients.stream", { client: id, path, ...options, ...(instance ? { instance } : {}) }),
    /**
     * Ouvre un WebSocket vers le compte (`wss://` pour une adresse `https://`) et rend l’identifiant de son canal,
     * que la page lit et écrit (`channels.write`). `headers` peut porter `Sec-WebSocket-Protocol`.
     */
    socket: (path: string, options: Pick<ClientTransferRequest, "query" | "headers"> = {}) =>
      request<ClientChannel>("clients.socket", { client: id, path, ...options, ...(instance ? { instance } : {}) }),
    /** Oublie les réponses de ce client gardées pour le module (après une écriture, pour relire à jour). */
    clearCache: () => request<{ cleared: number }>("clients.clearCache", { client: id }),
    /** Instances du client, la première étant celle par défaut. */
    instances: () => request<ClientInstance[]>("clients.instances", { client: id }),
    /**
     * Paramètres non secrets du compte que viserait une requête (`realm`, `mount`…), déclarés par sa méthode
     * (`methods[].params`). `{realm}` dans un chemin de requête est d’ailleurs remplacé d’office.
     */
    params: () => request<ClientParams>("clients.params", { client: id, ...(instance ? { instance } : {}) }),
  };
}

// --- Secrets scellés -------------------------------------------------------------------------------------------

/** Préfixe des références de secret (`alfred-secret-ref:v1:<nonce>`). */
export const SECRET_REF_PREFIX = "alfred-secret-ref:v1:";

/** Ligne d’un fichier `.env` : une référence de secret (`ref`) ou une valeur ordinaire (`value`). */
export type EnvEntry = { name: string; ref: string } | { name: string; value: string | number | boolean | null };

/**
 * Valeurs scellées : un champ qu’un client déclare secret (`sealed`) arrive à la fonction, puis à la page, sous
 * forme de référence opaque, valable cinq minutes pour ce module. **Aucune page ne reçoit jamais la valeur** : elle
 * ne s’affiche que dans une boîte de la coquille, après un clic de l’utilisateur, et ne s’écrit que dans un `.env`
 * dont l’utilisateur choisit l’emplacement. Une fonction ne peut ni l’afficher ni l’écrire.
 */
export const secrets = {
  /** Le texte est-il une référence de secret ? */
  isRef(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX);
  },
  /**
   * Ouvre la boîte de la coquille qui affiche la valeur (« Afficher », « Copier ») : `label` dit ce que c’est
   * (« DB_PASSWORD »). Rend `{ shown }` (vrai si l’utilisateur l’a affichée ou copiée), jamais la valeur.
   */
  reveal(ref: string, options: { label?: string } = {}): Promise<{ shown: boolean }> {
    return request("secrets.reveal", { ref, ...options });
  },
  /**
   * Fait choisir à l’utilisateur où enregistrer un `.env`, puis l’écrit en natif (valeurs entre guillemets,
   * échappées). `name` : nom proposé (`.env`). Rend `{ saved: false }` si l’utilisateur annule.
   */
  writeEnvFile(options: { name?: string; entries: EnvEntry[] }): Promise<{ saved: boolean; written?: number }> {
    return request("secrets.writeEnvFile", options);
  },
};

// --- Canaux (flux et WebSocket ouverts par un connecteur) ------------------------------------------------------

export interface ChannelEvent {
  /** Rang de l’événement, croissant ; à passer en `after` pour lire la suite. */
  seq: number;
  /** `data` : un message ; `close` : fin normale (`data` dit pourquoi) ; `error` : fin sur une erreur. */
  type: "data" | "close" | "error";
  /** Texte, ou base64 si `base64` est vrai. */
  data?: string;
  base64?: boolean;
  /** SSE : nom et identifiant de l’événement. */
  event?: string;
  id?: string;
  /** Journaux Docker : `stdout` ou `stderr`. */
  stream?: "stdout" | "stderr" | "stdin";
}

export interface ChannelRead {
  events: ChannelEvent[];
  /** Dernier rang lu, à repasser en `after`. */
  next: number;
  closed: boolean;
  reason: string | null;
  /** Événements oubliés faute de lecture (au-delà de 5 000 ou 4 Mo gardés). */
  dropped: number;
  /** `progress` : canal ouvert par le code du module (`alfred.channels.open` en Python). */
  kind: "stream" | "socket" | "progress";
}

/**
 * Canal ouvert par une fonction du connecteur (`client(id).stream` ou `client(id).socket`), lu et écrit par la page
 * sans jamais joindre le service. Seul le module qui l’a ouvert le lit.
 */
export const channels = {
  /** Événements après `after` ; `wait` : attendre jusqu’à ce nombre de secondes (25 au plus) qu’il en arrive. */
  read(channel: string, options: { after?: number; wait?: number } = {}): Promise<ChannelRead> {
    return request("channels.read", { channel, ...options });
  },
  /** Envoie un message par le WebSocket du canal : du texte, ou `{ data }` en base64 ; 64 Kio au plus. */
  write(channel: string, message: string | { data: string }): Promise<void> {
    return request<void>("channels.write", {
      channel,
      ...(typeof message === "string" ? { text: message } : { data: message.data }),
    });
  },
  close(channel: string): Promise<void> {
    return request<void>("channels.close", { channel });
  },
};

export interface ChannelState {
  /** Événements `data` reçus, les plus anciens oubliés au-delà de `keep`. */
  events: ChannelEvent[];
  closed: boolean;
  /** Raison de la fin, ou erreur de lecture. */
  reason: string | null;
  error: Error | undefined;
  write: (message: string | { data: string }) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Lit un canal tant que la page est affichée : `useChannel(id)` rend ses événements au fil de l’eau et se ferme avec
 * la page. `id` nul : rien n’est lu (canal pas encore ouvert).
 */
export function useChannel(channel: string | null | undefined, options: { keep?: number } = {}): ChannelState {
  const keep = options.keep ?? 2000;
  type Seen = { events: ChannelEvent[]; closed: boolean; reason: string | null; error?: Error };
  const [state, setState] = useState<Seen>({ events: [], closed: false, reason: null });
  useEffect(() => {
    setState({ events: [], closed: false, reason: null });
    if (!channel) return;
    let active = true;
    void (async () => {
      let after = 0;
      while (active) {
        try {
          const read = await channels.read(channel, { after, wait: 20 });
          if (!active) return;
          after = read.next;
          const data = read.events.filter((event) => event.type === "data");
          setState((current) => ({
            events: data.length ? [...current.events, ...data].slice(-keep) : current.events,
            closed: read.closed,
            reason: read.reason,
          }));
          if (read.closed) return;
        } catch (error) {
          if (active)
            setState((current) => ({
              ...current,
              closed: true,
              error: error instanceof Error ? error : new Error(String(error)),
            }));
          return;
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [channel, keep]);
  const write = useCallback(
    (message: string | { data: string }) =>
      channel ? channels.write(channel, message) : Promise.reject(new Error("Aucun canal ouvert.")),
    [channel],
  );
  const close = useCallback(() => (channel ? channels.close(channel) : Promise.resolve()), [channel]);
  return { events: state.events, closed: state.closed, reason: state.reason, error: state.error, write, close };
}

// --- Fonctions -------------------------------------------------------------------------------------------------

/** Branchement de `<Terminal>` de `socle-ui` sur un canal (`useTerminalConnection`). */
export interface TerminalLink {
  /** À passer à `<Terminal connection>`. */
  connection: {
    send(data: string): unknown;
    subscribe(write: (data: string | Uint8Array) => void): () => void;
  };
  /** À passer à `<Terminal state>`. */
  state: "connecting" | "open" | "closed" | "error";
  /** À passer à `<Terminal reason>`. */
  reason: string | undefined;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Relie `<Terminal engine={loadTerminal} {...useTerminalConnection(id)} />` de `socle-ui` au WebSocket ouvert par une
 * fonction du connecteur (`client(id).socket`) : ce que le programme écrit s’affiche, ce que l’utilisateur tape
 * part par `channels.write`. `id` nul : en attente d’ouverture.
 */
export function useTerminalConnection(channel: string | null | undefined): TerminalLink {
  const read = useChannel(channel);
  const writers = useRef(new Set<(data: string | Uint8Array) => void>());
  const backlog = useRef<{ channel: string | null | undefined; seq: number; chunks: (string | Uint8Array)[] }>({
    channel,
    seq: 0,
    chunks: [],
  });
  if (backlog.current.channel !== channel) backlog.current = { channel, seq: 0, chunks: [] };
  useEffect(() => {
    const kept = backlog.current;
    for (const event of read.events) {
      if (event.seq <= kept.seq || event.type !== "data" || event.data === undefined) continue;
      kept.seq = event.seq;
      const chunk = event.base64 ? decodeBase64(event.data) : event.data;
      kept.chunks.push(chunk);
      if (kept.chunks.length > 2000) kept.chunks.shift();
      for (const write of writers.current) write(chunk);
    }
  }, [read.events]);
  const connection = useMemo(
    () => ({
      send: (data: string) => {
        if (channel) void channels.write(channel, data).catch(() => undefined);
      },
      subscribe: (write: (data: string | Uint8Array) => void) => {
        for (const chunk of backlog.current.chunks) write(chunk);
        writers.current.add(write);
        return () => {
          writers.current.delete(write);
        };
      },
    }),
    [channel],
  );
  const state = !channel ? "connecting" : read.error ? "error" : read.closed ? "closed" : "open";
  return { connection, state, reason: read.reason ?? read.error?.message ?? undefined };
}

export const functions = {
  /** Appelle une fonction de l’espace : « fonction » pour le module courant, « module/fonction » sinon. */
  call<Output = unknown>(reference: string, input: unknown = {}): Promise<Output> {
    return request<Output>("functions.call", { function: reference, input });
  },
};

// --- Python (noyau du module) ---------------------------------------------------------------------------------

/** Options d’un appel au noyau Python. */
export interface PythonCallOptions {
  /** Délai en secondes (120 par défaut, une heure au plus). Dépassé, le noyau est arrêté et ses objets perdus. */
  timeout?: number;
  /** Canal d’avancement (`python.channel()`), qui reçoit `progress`, `emit` et chaque `yield` de l’appel. */
  channel?: string;
}

/** Un appel lancé avec son canal d’avancement : lire `channel` par `usePythonChannel`, attendre `result`. */
export interface PythonRun<Result = unknown> {
  channel: string;
  result: Promise<Result>;
}

/** Objet Python créé dans le noyau du module ; libéré par `dispose()` ou à la fermeture de la page. */
export interface PythonObject {
  readonly handle: string;
  /** `fichier.Classe` (`analyse.Graphe`). */
  readonly class: string;
  /** Appelle une méthode : un objet devient des arguments nommés, une liste des arguments positionnels. */
  call<Result = unknown>(method: string, args?: unknown, options?: PythonCallOptions): Promise<Result>;
  /** Comme `call`, avec un canal d’avancement ouvert pour l’occasion. */
  start<Result = unknown>(
    method: string,
    args?: unknown,
    options?: Omit<PythonCallOptions, "channel">,
  ): Promise<PythonRun<Result>>;
  dispose(): Promise<void>;
}

export interface PythonStatus {
  running: boolean;
  python?: string;
  pid?: number;
  interpreter?: string;
  uptimeSeconds?: number;
  idleSeconds?: number;
  /** Appels en cours. */
  busy?: number;
  objects?: { handle: string; class: string; holder: string }[];
  /** Sans appel pendant ce temps, le noyau s’arrête (600 s). */
  idleLimitSeconds: number;
}

function callArgs(args: unknown): unknown {
  return args === undefined ? null : args;
}

function pythonObject(handle: string, className: string): PythonObject {
  const object: PythonObject = {
    handle,
    class: className,
    call: <Result>(method: string, args?: unknown, options: PythonCallOptions = {}) =>
      request<Result>("python.call", { handle, method, args: callArgs(args), ...options }),
    start: async <Result>(method: string, args?: unknown, options: Omit<PythonCallOptions, "channel"> = {}) => {
      const channel = await python.channel();
      return { channel, result: object.call<Result>(method, args, { ...options, channel }) };
    },
    dispose: async () => {
      await request("python.dispose", { handle });
    },
  };
  return object;
}

/**
 * Noyau Python du module : un processus qui garde ses objets entre deux appels. Les classes et fonctions sont dans
 * `python/` du module (`python/analyse.py` → `analyse.Graphe`). Arguments : un objet devient des arguments nommés,
 * une liste des arguments positionnels. Une erreur Python rejette la promesse (`detail.python.trace`).
 */
export const python = {
  /** Crée un objet d’une classe de `python/` et rend sa poignée. */
  async create(
    className: string,
    args?: unknown,
    options: Omit<PythonCallOptions, "channel"> = {},
  ): Promise<PythonObject> {
    const created = await request<{ handle: string; class: string }>("python.create", {
      class: className,
      args: callArgs(args),
      ...options,
    });
    return pythonObject(created.handle, created.class);
  },
  /** Appelle une fonction libre de `python/` (`analyse.resumer`). */
  run<Result = unknown>(functionName: string, args?: unknown, options: PythonCallOptions = {}): Promise<Result> {
    return request<Result>("python.run", { function: functionName, args: callArgs(args), ...options });
  },
  /** Comme `run`, avec un canal d’avancement ouvert pour l’occasion. */
  async start<Result = unknown>(
    functionName: string,
    args?: unknown,
    options: Omit<PythonCallOptions, "channel"> = {},
  ): Promise<PythonRun<Result>> {
    const channel = await python.channel();
    return { channel, result: python.run<Result>(functionName, args, { ...options, channel }) };
  },
  /** Ouvre un canal d’avancement pour un appel ; il se ferme à la fin de cet appel. */
  async channel(): Promise<string> {
    return (await request<{ channel: string }>("python.channel")).channel;
  },
  status(): Promise<PythonStatus> {
    return request("python.status");
  },
};

/** Erreur d’un objet perdu (noyau redémarré : fichier changé, inactivité, délai dépassé) : le recréer. */
export function isPythonObjectLost(error: unknown): boolean {
  return (
    error instanceof AlfredSdkError &&
    typeof error.detail === "object" &&
    error.detail !== null &&
    (error.detail as { code?: unknown }).code === "objectLost"
  );
}

export interface PythonObjectState {
  object: PythonObject | null;
  loading: boolean;
  error: Error | undefined;
  /** Recrée l’objet (après un `isPythonObjectLost`, par exemple). */
  recreate: () => void;
}

/**
 * Crée un objet Python pour la page et le libère quand la page se ferme ou que `deps` changent :
 * `const { object } = usePythonObject("analyse.Graphe", { source }, [source])`.
 */
export function usePythonObject(
  className: string,
  args: unknown,
  deps: ReadonlyArray<unknown> = [],
): PythonObjectState {
  const [state, setState] = useState<{ object: PythonObject | null; loading: boolean; error?: Error }>({
    object: null,
    loading: true,
  });
  const [round, setRound] = useState(0);
  const argsRef = useRef(args);
  argsRef.current = args;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` décide de la recréation, comme `useAsync`.
  useEffect(() => {
    let active = true;
    let created: PythonObject | null = null;
    setState({ object: null, loading: true });
    python.create(className, argsRef.current).then(
      (object) => {
        created = object;
        if (active) setState({ object, loading: false });
        else void object.dispose().catch(() => undefined);
      },
      (error: unknown) => {
        if (active)
          setState({ object: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      active = false;
      if (created) void created.dispose().catch(() => undefined);
    };
  }, [className, round, ...deps]);
  const recreate = useCallback(() => setRound((value) => value + 1), []);
  return { object: state.object, loading: state.loading, error: state.error, recreate };
}

export interface PythonProgress {
  /** Entre 0 et 1, si le code l’a donné. */
  fraction?: number;
  message?: string;
  [key: string]: unknown;
}

export interface PythonChannelState {
  /** Dernier avancement annoncé (`progress`). */
  progress: PythonProgress | null;
  /** Valeurs envoyées par `emit` ou `yield`, dans l’ordre. */
  data: unknown[];
  /** L’appel est fini (avec succès ou non). */
  closed: boolean;
  error: Error | undefined;
}

function parsePythonData(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Lit le canal d’avancement d’un appel Python (`start`) : avancement et valeurs reçues, au fil de l’eau. */
export function usePythonChannel(
  channel: string | null | undefined,
  options: { keep?: number } = {},
): PythonChannelState {
  const read = useChannel(channel, options);
  return useMemo(() => {
    let progress: PythonProgress | null = null;
    const data: unknown[] = [];
    for (const event of read.events) {
      if (event.event === "progress") progress = parsePythonData(event.data) as PythonProgress;
      else data.push(parsePythonData(event.data));
    }
    return { progress, data, closed: read.closed, error: read.error };
  }, [read.events, read.closed, read.error]);
}

// --- IA --------------------------------------------------------------------------------------------------------

export interface OneShotOptions {
  /** Ce que le modèle doit produire. */
  instruction: string;
  /** Données de la page utiles à la réponse (objet sérialisable ou texte). */
  context?: unknown;
  /** Schéma JSON de la réponse attendue ; Alfred valide la réponse et relance une fois si elle est invalide. */
  schema: Record<string, unknown>;
}

/** Un choix : son libellé seul, ou un libellé et ce qu’il recouvre (aide le modèle à trancher). */
export type DecisionChoice = string | { label: string; description?: string };

/** Une question posée au modèle de décision local. */
export type DecisionQuestion =
  | {
      /** Un choix parmi des options (par défaut). */
      type?: "choice";
      question: string;
      /** Les choix, dans l’ordre, ou un objet libellé → description. Moins de 20 de préférence. */
      choices: DecisionChoice[] | Record<string, string>;
    }
  | {
      /** Un niveau sur une échelle ordonnée. */
      type: "score";
      question: string;
      /** Les niveaux, du plus bas au plus haut. */
      choices: string[];
    }
  | {
      /** Oui ou non. */
      type: "yesno";
      question: string;
      /** Ce que veut dire oui, ce que veut dire non (facultatif). */
      choices?: { yes?: string; no?: string };
    };

export type DecisionAnswer =
  | {
      type: "choice";
      /** Le libellé retenu. */
      choice: string;
      /** Probabilité du choix retenu, entre 0 et 1. */
      confidence: number;
      /** Probabilité de chaque choix. */
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      /** Niveau espéré (moyenne pondérée, 0 pour le premier niveau). */
      score: number;
      /** Niveau le plus probable (son indice). */
      level: number;
      confidence: number;
      /** Probabilité de chaque niveau, dans l’ordre. */
      probabilities: number[];
    }
  | {
      type: "yesno";
      answer: boolean;
      /** Probabilité du oui. */
      probability: number;
      confidence: number;
    };

/** Questions toutes prêtes (celles du modèle, en anglais ; le texte peut être en français). */
export type DecisionPreset = "triage" | "email" | "guard" | "moderation" | "router";

/** Texte à lire : une chaîne, un objet (ses champs), ou une liste de messages (les derniers comptent). */
export type DecisionText = string | Record<string, unknown> | unknown[];

export interface DecideOptions {
  text: DecisionText;
  question: string;
  choices: DecisionChoice[] | Record<string, string>;
}

export interface DecideManyOptions {
  text: DecisionText;
  /** Plusieurs questions, chacune sous son identifiant. */
  questions?: Record<string, DecisionQuestion>;
  /** Ou un jeu de questions tout prêt. */
  preset?: DecisionPreset;
}

export interface Decision {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  /** Le texte dépassait ce que le modèle lit (environ 1 000 jetons, question comprise) et a été coupé. */
  truncated: boolean;
}

export interface Decisions {
  answers: Record<string, DecisionAnswer>;
  truncated: boolean;
}

/** Les choix sous forme de liste, pour garder leur ordre jusqu’au modèle. */
function orderedChoices(choices: unknown): unknown {
  if (Array.isArray(choices) || choices === null || typeof choices !== "object") return choices;
  return Object.entries(choices as Record<string, unknown>);
}

export interface AgentStartOptions {
  /** Consigne de départ de l’agent. */
  instruction: string;
  /** Contexte de la page transmis à l’agent. */
  context?: unknown;
  /** Titre de la conversation. */
  title?: string;
  /**
   * Fonctions que l’agent peut appeler comme outils, en plus de celles déjà proposées aux agents : `"fonction"`,
   * `"module/fonction"`, ou `{ name, input }` dont les entrées sont imposées (le modèle ne peut pas les changer).
   */
  functions?: Array<string | { name: string; input: Record<string, unknown> }>;
  /**
   * Dossier de travail : un dossier accordé au module (`folders`) et un sous-dossier facultatif. Sans dossier, l’agent
   * travaille dans le dossier du module.
   */
  folder?: { id: string; path?: string };
  /**
   * `"espace-de-travail"` (par défaut) : l’agent n’agit que dans son dossier de travail, sans demande ; ce qui en
   * sortirait est refusé. `"complet"` : il fait ce qu’il veut, sans aucune demande d’autorisation.
   */
  mode?: "espace-de-travail" | "complet";
  /** Conversation qui répartit le travail entre d’autres agents (outils de délégation). */
  coordinator?: boolean;
  /** Schéma JSON du résultat attendu en fin de conversation. */
  resultSchema?: Record<string, unknown>;
}

/**
 * Décision locale : le modèle de décision d’Alfred lit `text` et choisit parmi `choices`, avec la probabilité de
 * chaque choix. Calculé sur cet ordinateur, en une fraction de seconde, sans service ni coût. Avec `questions` ou
 * `preset`, plusieurs questions typées en un appel. Rejette tant que le modèle n’est pas téléchargé (Réglages →
 * Général).
 */
function decide(options: DecideOptions): Promise<Decision>;
function decide(options: DecideManyOptions): Promise<Decisions>;
function decide(options: DecideOptions | DecideManyOptions): Promise<Decision | Decisions> {
  const params: Record<string, unknown> = { ...options };
  if ("choices" in options) params.choices = orderedChoices(options.choices);
  if ("questions" in options && options.questions)
    params.questions = Object.entries(options.questions).map(([id, question]) => [
      id,
      { ...question, choices: orderedChoices(question.choices) },
    ]);
  return request("ai.decide", params);
}

export const ai = {
  /** Appel unique : une consigne et un contexte entrent, un objet conforme au schéma sort. Sans outil. */
  oneShot<Output = unknown>(options: OneShotOptions): Promise<Output> {
    return request<Output>("ai.oneShot", options);
  },
  decide,
  /**
   * Lance une conversation d’agent, affichée dans le panneau de droite de la page. La promesse se résout à la fin
   * du premier tour, avec le dernier message de l’agent et, si un schéma est fourni, son résultat structuré.
   */
  startAgent<Result = unknown>(
    options: AgentStartOptions,
  ): Promise<{ conversationId: string; message: string; result?: Result }> {
    return request("ai.startAgent", options);
  },
  /** Envoie un message à une conversation que ce module a lancée ; la relance si elle était au repos. */
  sendToAgent(conversationId: string, message: string): Promise<void> {
    return request("ai.sendToAgent", { conversationId, message });
  },
  /**
   * Relance une conversation lancée par ce module quand l’événement `event` (« module/evenement ») arrive, ou à
   * l’échéance (60 minutes par défaut, 7 jours au plus). `match` filtre son contenu. Le suivi survit à un redémarrage.
   */
  watch(options: AgentWatchOptions): Promise<{ id: string }> {
    return request("ai.watch", options);
  },
  /** Annule un suivi posé par `ai.watch`. */
  cancelWatch(id: string): Promise<void> {
    return request("ai.cancelWatch", { id });
  },
};

export interface AgentWatchOptions {
  conversationId: string;
  event: string;
  match?: Record<string, unknown>;
  timeoutMinutes?: number;
  /** Ce qui est attendu, montré à l’utilisateur (« la CI de alpha »). */
  label?: string;
}

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
   * Compte que montre la page : celui choisi pour le besoin qu’elle suit (`perInstance`), ou son seul compte. Passez-le
   * aux fonctions dans leur `input` (`{ instance }`). `null` quand la page n’a pas de compte, ou en a plusieurs.
   */
  instance: string | null;
  /**
   * Compte choisi pour chaque besoin de la page (`{ jira: "acme", confluence: "wiki" }`). Une fonction appelée par la
   * page vise d’office ces comptes : `client("jira")` y appelle `acme`.
   */
  accounts: Record<string, string>;
  /**
   * Entrée du menu de gauche ouverte dans la page (`menu.setEntries`), par exemple le produit choisi ; `null` quand
   * la page est ouverte par l’entrée de sa section, ou pour une fonction. Un panneau reçoit celle de sa page.
   */
  entry: { id: string; label: string; section?: string } | null;
  /**
   * Paramètres de la fenêtre ouverte sur un élément précis (`shell.openWindow("journal", { params })`), pour la page
   * et son panneau ; `null` ailleurs.
   */
  params: Record<string, unknown> | null;
  /**
   * Onglet ouvert sur un élément (`views.open`) que montre la page : l’élément à afficher. `null` dans un onglet fixe
   * de la section. Un panneau reçoit celui de sa page.
   */
  view: OpenedView | null;
}

/** Élément porté par un onglet ouvert : ce que la page a passé à `views.open`. */
export interface OpenedView {
  id: string;
  label: string;
  params: Record<string, unknown> | null;
}

export interface ViewOptions {
  /** Identifiant de l’élément (`PROJ-42`) : rouvrir le même identifiant active l’onglet déjà ouvert. */
  id: string;
  /** Nom de l’élément, libellé de l’onglet (« PROJ-42 Paiement refusé »). */
  label: string;
  /** Objet JSON (16 Kio au plus), lu par la page dans `usePageContext().view.params`. */
  params?: Record<string, unknown>;
  /** Autre page du module à afficher dans l’onglet (« ticket ») ; par défaut, la page elle-même. */
  page?: string;
}

/**
 * Onglets ouverts sur un élément, dans la barre du haut (D-021) : après les onglets fixes de la section, fermables,
 * mémorisés d’un lancement à l’autre (dix par section au plus, le plus ancien se ferme). L’onglet rouvre la page sur
 * l’élément ; elle le lit dans `usePageContext().view`.
 */
export const views = {
  /** Ouvre un onglet pour un élément et l’affiche ; s’il est déjà ouvert, l’active (libellé et paramètres mis à jour). */
  open(options: ViewOptions): Promise<void> {
    return request<void>("views.open", { ...options });
  },
  /**
   * Ferme l’onglet de l’élément `id` ouvert par le module dans la section (sans argument : celui que montre la page).
   * L’onglet de gauche s’affiche s’il était actif. Rend faux si l’onglet n’était pas ouvert.
   */
  close(id?: string, options: { page?: string } = {}): Promise<boolean> {
    return request<boolean>("views.close", { ...(id !== undefined ? { id } : {}), ...options });
  },
};

/** Fenêtre ouverte sur un élément précis : ce que la page y lit, la clé qui ramène la même fenêtre, son titre. */
export interface WindowOptions {
  /** Objet JSON (16 Kio au plus), lu par la page dans `usePageContext().params`. */
  params?: Record<string, unknown>;
  /** La même clé ramène la fenêtre déjà ouverte ; par défaut, les paramètres eux-mêmes. */
  key?: string;
  /** Titre de l’élément, placé avant celui de la page : « Build #42 — Journal CI ». */
  title?: string;
}

/** Action d’une notification : une seule de `navigate`, `window` ou `function`. */
export interface NotificationAction {
  label: string;
  /** Page ouverte (« journal », ou « module/page ») ; `entry` l’ouvre sur une entrée de sa zone du menu. */
  navigate?: string;
  entry?: string;
  /** Page ouverte seule dans sa fenêtre, sur un élément précis. */
  window?: { page: string } & WindowOptions;
  /** Fonction du module appelée avec `input`. */
  function?: { id: string; input?: unknown };
}

export interface NotifyOptions {
  title: string;
  description?: string;
  tone?: "info" | "success" | "warning" | "error";
  /** Reste à l’écran jusqu’à ce que l’utilisateur la ferme ou choisisse une action. */
  persistent?: boolean;
  /** Deux au plus, en boutons dans la surimpression et dans la cloche. */
  actions?: NotificationAction[];
}

export const shell = {
  /**
   * Affiche une notification dans Alfred (surimpression et centre de notifications). Quand aucune fenêtre d’Alfred
   * n’est au premier plan, elle part aussi au centre de notifications du système.
   */
  notify(options: NotifyOptions) {
    return request<void>("shell.notify", options);
  },
  /** Ouvre une autre page de l’espace (« module/page », ou « module/page@suffixe » pour l’une de ses copies). */
  navigate(reference: string) {
    return request<void>("shell.navigate", { reference });
  },
  /**
   * Ouvre une page de l’espace seule dans sa propre fenêtre (sans argument : la page elle-même), ou ramène au
   * premier plan la fenêtre qui l’affiche déjà. Avec `params`, la fenêtre s’ouvre sur un élément précis : une
   * fenêtre par clé (par défaut, par jeu de paramètres).
   */
  openWindow(reference?: string, options: WindowOptions = {}) {
    return request<void>("shell.openWindow", { ...(reference ? { reference } : {}), ...options });
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

// --- Recherche de la barre du haut -----------------------------------------------------------------------------

export { matchesSearch, searchTerms } from "./textSearch";

export interface TopBarSearchOptions {
  /** Nom accessible du champ : « Rechercher un ticket ». Par défaut « Rechercher dans la page ». */
  label?: string;
  /** Texte grisé du champ vide. Par défaut « Rechercher… ». */
  placeholder?: string;
}

export interface TopBarSearchHandle {
  /** Change le texte du champ (vide pour l’effacer). */
  setQuery(query: string): void;
  /** Retire le champ de la barre du haut. */
  dispose(): void;
}

interface DeclaredSearch {
  options: TopBarSearchOptions;
  onQuery: (query: string) => void;
  onRefused?: (error: Error) => void;
  /** Texte propre à cette déclaration ; `null` tant qu’elle n’a pas reçu celui que la coquille a retenu. */
  query: string | null;
}

/** Recherches déclarées par le cadre : la plus récente (une sous-page par-dessus sa page) tient la barre du haut. */
const declaredSearches: DeclaredSearch[] = [];
let listeningSearch = false;

function showTopSearch() {
  const top = declaredSearches.at(-1);
  if (!top) {
    void request("shell.search.remove").catch(() => undefined);
    return;
  }
  const { label, placeholder } = top.options;
  void request<{ query: string }>("shell.search.declare", { label, placeholder }).then(
    (result) => {
      if (declaredSearches.at(-1) !== top) return;
      // La page a déjà son texte (elle l’a changé, ou elle revient au premier plan) : la barre le reprend.
      if (top.query !== null) {
        void request("shell.search.set", { query: top.query }).catch(() => undefined);
      } else if (typeof result?.query === "string") {
        top.query = result.query;
        top.onQuery(result.query);
      }
    },
    (error: Error) => {
      if (!top.onRefused) throw error;
      top.onRefused(error);
    },
  );
}

/**
 * Bas niveau de `useTopBarSearch` (gabarits) : déclare une recherche à la coquille, qui l’affiche dans la barre du
 * haut et rappelle `onQuery` à chaque frappe, et d’emblée avec le texte retenu de la page. Une recherche déclarée
 * ensuite (sous-page) prend la barre jusqu’à son `dispose`, puis la précédente revient avec son texte.
 */
export function declareTopBarSearch(
  options: TopBarSearchOptions,
  onQuery: (query: string) => void,
  /** Refus de la coquille (un panneau) ; sans lui, le refus remonte comme une erreur de la page. */
  onRefused?: (error: Error) => void,
): TopBarSearchHandle {
  if (!listeningSearch) {
    listeningSearch = true;
    onShellEvent("search", (payload) => {
      const query = (payload as { query?: unknown } | null)?.query;
      const top = declaredSearches.at(-1);
      if (!top || typeof query !== "string") return;
      top.query = query;
      top.onQuery(query);
    });
  }
  const entry: DeclaredSearch = { options, onQuery, onRefused, query: null };
  declaredSearches.push(entry);
  showTopSearch();
  return {
    setQuery(query) {
      if (!declaredSearches.includes(entry)) return;
      entry.query = query;
      onQuery(query);
      if (declaredSearches.at(-1) === entry) void request("shell.search.set", { query }).catch(() => undefined);
    },
    dispose() {
      const index = declaredSearches.indexOf(entry);
      if (index < 0) return;
      const wasTop = index === declaredSearches.length - 1;
      declaredSearches.splice(index, 1);
      if (wasTop) showTopSearch();
    },
  };
}

// --- Actions de la barre du haut ----------------------------------------------------------------------------------

/**
 * Ce que la coquille sait d’une action de la barre du haut : jamais la fonction, seulement de quoi la dessiner.
 * `icon` est le nom d’une icône Lucide (« Download ») ; sans icône, l’action va dans le menu « ⋯ ».
 */
export interface TopBarActionDescriptor {
  id: string;
  label: string;
  icon?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** L’action tourne (attente affichée sur son bouton). */
  running?: boolean;
  /** Bascule de vue : les actions d’un même groupe sont des boutons accolés ; `selected` marque la vue affichée. */
  group?: string;
  selected?: boolean;
}

/**
 * Une action de la barre du haut telle que la page l’écrit : une `Action` de `socle-ui` (`{ id, label, icon, onPress,
 * primary, danger, confirm, isDisabled, isHidden }`). Les anciens noms (`onClick`, `disabled`, `hidden`) restent lus.
 */
export interface TopBarAction {
  id?: string;
  label: string;
  /** Icône Lucide : l’élément (`<Download size={16} />`) ou le composant (`Download`), dont la coquille dessine l’icône de même nom. */
  icon?: unknown;
  primary?: boolean;
  danger?: boolean;
  isDisabled?: boolean;
  isHidden?: boolean;
  /** Bascule de vue : même `group` pour ses boutons, `selected` pour la vue affichée. */
  group?: string;
  selected?: boolean;
  /** Question posée avant d’agir ; une action `danger` est toujours confirmée. */
  confirm?: string | { title: string; message?: string; confirmLabel?: string };
  /** Notification après réussite : « Export terminé ». */
  success?: string;
  onPress?: () => unknown;
  /** @deprecated Ancien nom de `onPress`. */
  onClick?: () => unknown;
  /** @deprecated Ancien nom de `isDisabled`. */
  disabled?: boolean;
  /** @deprecated Ancien nom de `isHidden`. */
  hidden?: boolean;
  /** @deprecated Ancienne conséquence de `confirm` : passer `confirm: { title, message }`. */
  confirmMessage?: string;
}

const isHidden = (action: TopBarAction) => Boolean(action.isHidden ?? action.hidden);
const isDisabled = (action: TopBarAction) => Boolean(action.isDisabled ?? action.disabled);

/** Nom de l’icône Lucide : celui du composant, ou du composant d’un élément (`<Download />`). */
function iconName(icon: unknown): string | undefined {
  if (!icon || (typeof icon !== "object" && typeof icon !== "function")) return undefined;
  const element = icon as { type?: unknown; $$typeof?: unknown };
  const component = (element.$$typeof && element.type ? element.type : icon) as { displayName?: string; name?: string };
  if (typeof component !== "object" && typeof component !== "function") return undefined;
  return component.displayName ?? (component.name && component.name !== "Object" ? component.name : undefined);
}

/** Description sans fonction d’actions de page, avec un identifiant stable par position et libellé. */
export function describeTopBarActions(
  actions: ReadonlyArray<TopBarAction>,
  running?: string | null,
): TopBarActionDescriptor[] {
  return actions
    .filter((action) => !isHidden(action))
    .map((action, index) => {
      const id = `${index}:${action.label}`;
      const icon = iconName(action.icon);
      return {
        id,
        label: action.label,
        ...(icon ? { icon } : {}),
        ...(action.primary ? { primary: true } : {}),
        ...(action.danger ? { danger: true } : {}),
        ...(isDisabled(action) ? { disabled: true } : {}),
        ...(running === id ? { running: true } : {}),
        ...(action.group ? { group: action.group, selected: action.selected === true } : {}),
      };
    });
}

/** Confirmation que l’hôte du cadre branche sur `useConfirm` de `socle-ui` (une modale dans le cadre). */
export interface FrameConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  tone?: "danger" | "default";
}
let frameConfirm: ((options: FrameConfirmOptions) => Promise<boolean>) | null = null;

/** Réservé à l’hôte du cadre : la confirmation des actions de la barre du haut. */
export function setFrameConfirm(confirm: ((options: FrameConfirmOptions) => Promise<boolean>) | null) {
  frameConfirm = confirm;
}

function errorText(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}

/**
 * Notification d’échec d’une action, à passer aux gabarits de `socle-ui` : `onActionError={notifyActionError}`. Le
 * gabarit rend l’erreur ; Alfred l’affiche (toast et cloche) : « « Supprimer » n’a pas abouti ».
 */
export function notifyActionError(action: { label: string }, error?: unknown) {
  const description = errorText(error);
  void shell
    .notify({ title: `« ${action.label} » n’a pas abouti`, ...(description ? { description } : {}), tone: "error" })
    .catch(() => undefined);
}

/** Exécute une action comme une `ActionBar` : confirmation (`danger`, `confirm`), puis `success` ou l’échec notifié. */
export async function runTopBarAction(action: TopBarAction): Promise<void> {
  if (action.danger || action.confirm) {
    const asked =
      typeof action.confirm === "object"
        ? action.confirm
        : { title: action.confirm ?? `${action.label} ?`, message: action.confirmMessage };
    const ok = frameConfirm
      ? await frameConfirm({
          title: asked.title,
          ...(asked.message ? { message: asked.message } : {}),
          confirmLabel: ("confirmLabel" in asked && asked.confirmLabel) || action.label,
          tone: action.danger ? "danger" : "default",
        })
      : true;
    if (!ok) return;
  }
  try {
    await (action.onPress ?? action.onClick)?.();
    if (action.success) void shell.notify({ title: action.success, tone: "success" }).catch(() => undefined);
  } catch (error) {
    notifyActionError(action, error);
  }
}

let listeningActions = false;
let activateTopBarAction: ((id: string) => void) | null = null;

/**
 * Bas niveau de `useTopBarActions` : montre des actions dans la barre du haut d’Alfred et rappelle `onActivate(id)`
 * quand l’utilisateur en choisit une. Une seule série par page : la dernière déclarée.
 */
export function declareTopBarActions(
  descriptors: ReadonlyArray<TopBarActionDescriptor>,
  onActivate: (id: string) => void,
): { update(descriptors: ReadonlyArray<TopBarActionDescriptor>): void; dispose(): void } {
  if (!listeningActions) {
    listeningActions = true;
    onShellEvent("topBarAction", (payload) => {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id === "string") activateTopBarAction?.(id);
    });
  }
  const send = (list: ReadonlyArray<TopBarActionDescriptor>) =>
    void request("shell.actions.set", { actions: list }).catch(() => undefined);
  activateTopBarAction = onActivate;
  send(descriptors);
  return {
    update: (list) => {
      if (activateTopBarAction === onActivate) send(list);
    },
    dispose: () => {
      if (activateTopBarAction !== onActivate) return;
      activateTopBarAction = null;
      void request("shell.actions.set", { actions: [] }).catch(() => undefined);
    },
  };
}

/**
 * Actions de la page dans la barre du haut d’Alfred (zone `topbar` de Socle) : icônes avec infobulle, menu « … »
 * (actions sans icône, destructrices, ou fenêtre étroite) et action principale. La coquille ne reçoit que leur
 * description ; un clic revient à la page, qui exécute l’action comme une `ActionBar` : confirmation d’une action
 * `danger` ou `confirm` (modale de `socle-ui` dans le cadre), attente sur le bouton, notification de `success` ou de
 * l’échec. `options.run` remplace cette exécution. Réservé à une page : un panneau garde ses actions.
 */
export function useTopBarActions(
  actions: ReadonlyArray<TopBarAction>,
  options: { run?: (action: TopBarAction) => unknown } = {},
) {
  const latest = useRef({ actions, run: options.run });
  latest.current = { actions, run: options.run };
  const [running, setRunning] = useState<string | null>(null);
  const handle = useRef<ReturnType<typeof declareTopBarActions> | null>(null);
  const descriptors = describeTopBarActions(actions, running);
  const key = JSON.stringify(descriptors);
  // biome-ignore lint/correctness/useExhaustiveDependencies: la déclaration vit avec la page ; `key` passe ensuite par `update`.
  useEffect(() => {
    const declared = declareTopBarActions(JSON.parse(key), async (id) => {
      const visible = latest.current.actions.filter((action) => !isHidden(action));
      const action = visible.find((item, index) => `${index}:${item.label}` === id);
      if (!action || isDisabled(action)) return;
      setRunning(id);
      try {
        await (latest.current.run ? latest.current.run(action) : runTopBarAction(action));
      } finally {
        setRunning((current) => (current === id ? null : current));
      }
    });
    handle.current = declared;
    return () => {
      declared.dispose();
      if (handle.current === declared) handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.update(JSON.parse(key));
  }, [key]);
}

/**
 * Vrai quand la page est affichée avec les données d’exemple de son module (mode réglé par l’utilisateur : page
 * d’attente, Réglages → Modules, pastille « Exemple »). Une page qui lit aussi sa propre base y montre alors ses
 * données fictives, jamais mêlées aux vraies. Le cadre est rechargé quand le mode change.
 */
export function isExampleMode(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("examples") === "1";
  } catch {
    return false;
  }
}

/**
 * Retiré : la barre du haut n’a plus de résumé (socle-ui 0.4.0, D-253). Le hook reste pour les pages plus anciennes et
 * ne fait rien. Un chiffre clé va dans l’en-tête du gabarit ou dans le contenu de la page.
 * @deprecated
 */
export function useTopBarSummary(_text: string | null | undefined) {}

export interface TopBarSearch {
  /** Texte tapé, tel quel. */
  query: string;
  /** Ses mots, sans casse ni accents (`searchTerms`). */
  terms: string[];
  /** Vrai quand chaque mot apparaît dans un des champs : `items.filter((t) => search.matches(t.titre, t.client))`. */
  matches(...fields: unknown[]): boolean;
  setQuery(query: string): void;
  /** Vide la recherche (« Effacer la recherche » d’un état vide). */
  clear(): void;
}

/**
 * Recherche de la page, placée par Alfred dans la barre du haut (240 px, ⌘F ou Ctrl+F) au lieu d’un champ dans la
 * page. Le texte est retenu tant qu’Alfred est ouvert. Réservée à une page : un panneau de droite n’en a pas.
 */
export function useTopBarSearch(options: TopBarSearchOptions = {}): TopBarSearch {
  const [query, setLocal] = useState("");
  const handle = useRef<TopBarSearchHandle | null>(null);
  const { label, placeholder } = options;
  useEffect(() => {
    const declared = declareTopBarSearch({ label, placeholder }, setLocal);
    handle.current = declared;
    return () => {
      declared.dispose();
      if (handle.current === declared) handle.current = null;
    };
  }, [label, placeholder]);
  const terms = useMemo(() => searchTerms(query), [query]);
  const setQuery = useCallback((next: string) => {
    if (handle.current) handle.current.setQuery(next);
    else setLocal(next);
  }, []);
  return {
    query,
    terms,
    matches: (...fields) => matchesSearch(terms, fields),
    setQuery,
    clear: () => setQuery(""),
  };
}

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

// --- Zone du menu de gauche ------------------------------------------------------------------------------------

/** État d’une entrée du menu, rendu en pastille : au travail, attend l’utilisateur, en échec, à surveiller, bon. */
export type MenuEntryStatus = "ok" | "warning" | "error" | "running" | "waiting";
export type MenuEntryColor = "steel" | "blue" | "violet" | "pink" | "red" | "orange" | "green" | "teal";

export interface MenuEntryAction {
  /** Reçu par la page dans `useMenuEntryAction`. `rename` ouvre la saisie du libellé dans la ligne. */
  id: string;
  label: string;
  /** Nom d’icône Lucide (`pencil`, `archive`, `app-window`). */
  icon: string;
  /** Fonction du module appelée avec `{ entry, action, page, value? }`, à la place de la page. */
  function?: string;
}

export interface MenuEntry {
  /** Identifiant, propre à la zone (identifiant du produit, de la ligne…). */
  id: string;
  label: string;
  /** Nom d’icône Lucide ; sans icône, la pastille d’état ou un point. */
  icon?: string;
  color?: MenuEntryColor;
  status?: MenuEntryStatus;
  /** Compteur en pastille, comme `badge`. */
  badge?: number;
  /** Autre page du module ouverte au clic (« vue »), sinon la page de la zone. */
  page?: string;
  /** Au plus trois actions, en icônes au survol de la ligne. */
  actions?: MenuEntryAction[];
}

export interface MenuZoneOptions {
  /** Titre discret au-dessus des entrées (« Produits ») ; un clic replie la zone. */
  title?: string;
  /** `page` (défaut) : l’ordre de `setEntries` ; `user` : l’utilisateur déplace les entrées avec Alt+↑ et Alt+↓. */
  order?: "page" | "user";
  /** Entrées montrées avant « Afficher plus » ; par défaut toutes. */
  visible?: number;
}

/**
 * Une fonction nomme la page dont elle règle la zone ; une page règle la sienne. `section` vise les entrées d’une
 * section créée par le module (`menu.addSection`), à la place de `page`.
 */
export interface MenuTarget {
  page?: string;
  section?: string;
}

/** Section du menu créée par le module pour une notion de l’utilisateur (`menu.addSection`). */
export interface MenuSection {
  /** Identifiant propre au module : minuscules, chiffres et tirets (« atlas »). */
  id: string;
  /** Titre de la section, au-dessus de ses entrées (« Atlas »). */
  title: string;
  /** Page du module qu’ouvre une entrée sans `page` (« projet ») ; par défaut, la page qui crée la section. */
  page?: string;
}

/**
 * Zone de la page dans le menu de gauche : des entrées sous l’entrée de sa section, après un petit séparateur. Elles
 * durent d’un lancement à l’autre ; un clic ouvre la page avec l’entrée (`usePageContext().entry`).
 */
export const menu = {
  /** Titre, ordre et nombre d’entrées visibles de la zone. */
  setZone(options: MenuZoneOptions, target: MenuTarget = {}): Promise<void> {
    return request<void>("menu.update", { op: "setZone", ...options, ...target });
  },
  /** Remplace toutes les entrées de la zone (200 au plus) ; une liste vide la vide. */
  setEntries(entries: MenuEntry[], target: MenuTarget = {}): Promise<void> {
    return request<void>("menu.update", { op: "setEntries", entries, ...target });
  },
  /** Change quelques champs d’une entrée (`null` efface un champ). */
  updateEntry(id: string, patch: Partial<Omit<MenuEntry, "id">>, target: MenuTarget = {}): Promise<void> {
    return request<void>("menu.update", { op: "updateEntry", id, patch, ...target });
  },
  removeEntry(id: string, target: MenuTarget = {}): Promise<void> {
    return request<void>("menu.update", { op: "removeEntry", id, ...target });
  },
  /** Retire la zone entière. */
  clear(target: MenuTarget = {}): Promise<void> {
    return request<void>("menu.update", { op: "clear", ...target });
  },
  /**
   * Crée une section du menu de gauche (un titre repliable) pour y ranger des entrées, ou renomme celle qui a déjà cet
   * `id`. Ses entrées : `setEntries(entries, { section: id })`. Écrite dans l’espace (un commit) ; elle part avec le
   * module. Rend vrai si elle est nouvelle.
   */
  addSection(section: MenuSection): Promise<boolean> {
    return request<boolean>("menu.sections", { op: "add", ...section });
  },
  /** Retire une section créée et ses entrées ; les données du module restent. Faux si elle n’y était plus. */
  removeSection(id: string): Promise<boolean> {
    return request<boolean>("menu.sections", { op: "remove", id });
  },
  /** Sections créées par le module. */
  listSections(): Promise<Array<Required<MenuSection>>> {
    return request<Array<Required<MenuSection>>>("menu.sections", { op: "list" });
  },
};

/** Action choisie sur une entrée de la zone : `value` porte le nouveau libellé d’un `rename`. */
export interface MenuEntryActionEvent {
  entry: string;
  action: string;
  value?: string;
}

/**
 * Reçoit les actions des entrées de la zone de la page, y compris celles choisies avant que la page ne soit
 * affichée : Alfred ouvre la page avec l’entrée, puis lui remet l’action.
 */
export function useMenuEntryAction(handler: (event: MenuEntryActionEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const take = () =>
      void request<MenuEntryActionEvent[]>("menu.takeActions").then(
        (events) => {
          for (const event of events ?? []) latest.current(event);
        },
        () => undefined,
      );
    take();
    return onShellEvent("menuEntryAction", take);
  }, []);
}

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
  // Données du module changées ailleurs (reçues de l’équipe) : le chargement se relance de lui-même.
  useEffect(() => onShellEvent("dataChanged", reload), [reload]);
  // L’autre cadre de la page a écrit (`announceChange`) : la liste ou le détail se relit.
  useEffect(() => onShellEvent("peer", (message) => isChangeMessage(message) && reload()), [reload]);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

// --- États partagés --------------------------------------------------------------------------------------------

export interface AlfredStateOptions<Value, Selected> {
  /**
   * Paramètres de l’état (`useAlfredState("jira/tickets-du-filtre", { params: { jql } })`) : deux abonnés avec les
   * mêmes paramètres partagent le même état, et le fournisseur ne le rafraîchit qu’une fois.
   */
  params?: Record<string, unknown> | null;
  /** Identifiant d’une entité (`jira/ticket`), ou valeur du seul paramètre d’un état. */
  key?: string | number | null;
  /** Compte visé ; omis : celui de la page pour ce besoin, sinon celui par défaut. */
  instance?: string | null;
  /**
   * Partie de la valeur que la page montre (`(boite) => boite.filter((m) => !m.lu).length`). La page ne se redessine
   * que si cette partie change (comparaison structurelle).
   */
  select?: (value: Value) => Selected;
}

export interface AlfredState<Selected> {
  /** Valeur courante (la partie choisie par `select`) ; `undefined` tant que l’état est vide. */
  data: Selected | undefined;
  /** Aucune valeur encore : la première lecture est en cours. */
  loading: boolean;
  /** Une lecture de l’état est en cours (`refresh`, ouverture). */
  refreshing: boolean;
  /** La dernière lecture a échoué ; la valeur précédente reste dans `data`. */
  error: Error | undefined;
  updatedAt: Date | undefined;
  /** Dernier rafraîchissement par le fournisseur : heure, erreur, prochain passage. */
  status: { lastRunAt?: Date; lastError?: string; nextAt?: Date; failures: number } | undefined;
  /** Demande au fournisseur de relire l’état maintenant : toutes les pages abonnées suivent. */
  refresh: () => Promise<void>;
}

interface SharedStatePush {
  data?: unknown;
  error?: { message: string };
  loading: boolean;
  refreshing: boolean;
  updatedAt?: number;
  status?: { lastRunAt?: number | null; lastError?: string | null; nextAt?: number | null; failures?: number };
}

/** Égalité structurelle : mêmes valeurs, mêmes champs, quel que soit leur ordre. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  const left = Object.keys(a as Record<string, unknown>).filter(
    (key) => (a as Record<string, unknown>)[key] !== undefined,
  );
  const right = Object.keys(b as Record<string, unknown>).filter(
    (key) => (b as Record<string, unknown>)[key] !== undefined,
  );
  return (
    left.length === right.length &&
    left.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

/** JSON aux clés triées : deux objets de mêmes valeurs donnent la même chaîne. */
function stableInput(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableInput).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, field]) => `${JSON.stringify(name)}:${stableInput(field)}`)
    .join(",")}}`;
}

let stateSequence = 0;

/**
 * S’abonne à un état partagé d’Alfred : la seule source de vérité d’une donnée d’un service. La page reçoit la valeur
 * courante tout de suite, puis chaque changement, d’où qu’il vienne (une autre page, une fonction, une automatisation,
 * une autre fenêtre) ; aucune requête ne part pour cela. Une liste d’entités (`jira/mes-tickets`) arrive avec ses
 * objets, chacun rangé une seule fois : relire un ticket met à jour toutes les listes qui le montrent. Un état vide
 * est lu une fois à l’ouverture ; ensuite il change seulement quand quelqu’un le lit (`refresh`, une action, une
 * automatisation). `name` à `null` : rien n’est suivi.
 *
 * ```tsx
 * const nonLus = useAlfredState<Mail[], number>("mail/boite-de-reception", {
 *   select: (boite) => boite.filter((mail) => !mail.lu).length,
 * });
 * ```
 */
export function useAlfredState<Value = unknown, Selected = Value>(
  name: string | null | undefined,
  options: AlfredStateOptions<Value, Selected> = {},
): AlfredState<Selected> {
  const key = options.key === null || options.key === undefined ? undefined : String(options.key);
  const instance = options.instance ?? undefined;
  const paramsKey = options.params ? stableInput(options.params) : "";
  const select = useRef(options.select);
  select.current = options.select;
  const id = `${name ?? ""}|${key ?? ""}|${instance ?? ""}|${paramsKey}`;
  const [view, setView] = useState<{ id: string; data?: Selected; push: SharedStatePush }>({
    id,
    push: { loading: Boolean(name), refreshing: false },
  });
  const shown = useRef(view);
  const watch = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!name) {
      shown.current = { id, push: { loading: false, refreshing: false } };
      setView(shown.current);
      return;
    }
    stateSequence += 1;
    const current = `e${stateSequence}`;
    watch.current = current;
    const stop = onShellEvent("state", (payload) => {
      const message = payload as { watch?: string; state?: SharedStatePush } | null;
      if (message?.watch !== current || !message.state) return;
      const push = message.state;
      const choose = select.current;
      const data = (push.data === undefined || !choose ? push.data : choose(push.data as Value)) as
        | Selected
        | undefined;
      // La page ne se redessine que si ce qu’elle montre change : sa partie de la valeur, son chargement, son erreur.
      // La comparaison se fait avant `setView` : React n’est pas même appelé quand rien ne change.
      const previous = shown.current;
      const same =
        previous.id === id &&
        sameValue(previous.data, data) &&
        previous.push.loading === push.loading &&
        previous.push.error?.message === push.error?.message &&
        (choose !== undefined || previous.push.refreshing === push.refreshing);
      if (same) return;
      shown.current = { id, data, push };
      setView(shown.current);
    });
    const params = paramsKey ? (JSON.parse(paramsKey) as Record<string, unknown>) : undefined;
    request("states.watch", {
      watch: current,
      name,
      ...(key ? { key } : {}),
      ...(instance ? { instance } : {}),
      ...(params ? { params } : {}),
    }).catch((error: unknown) => {
      shown.current = {
        id,
        push: {
          loading: false,
          refreshing: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
      };
      setView(shown.current);
    });
    return () => {
      stop();
      if (watch.current === current) watch.current = undefined;
      void request("states.unwatch", { watch: current }).catch(() => undefined);
    };
  }, [id, name, key, instance, paramsKey]);
  const refresh = useCallback(async () => {
    if (watch.current) await request("states.refresh", { watch: watch.current }).catch(() => undefined);
  }, []);
  const current = view.id === id ? view : { id, data: undefined, push: { loading: Boolean(name), refreshing: false } };
  const errorMessage = current.push.error?.message;
  const error = useMemo(() => (errorMessage ? new AlfredSdkError(errorMessage) : undefined), [errorMessage]);
  return {
    data: current.data,
    loading: current.push.loading,
    refreshing: current.push.refreshing,
    error,
    updatedAt: current.push.updatedAt !== undefined ? new Date(current.push.updatedAt) : undefined,
    status: current.push.status
      ? {
          ...(current.push.status.lastRunAt ? { lastRunAt: new Date(current.push.status.lastRunAt) } : {}),
          ...(current.push.status.lastError ? { lastError: current.push.status.lastError } : {}),
          ...(current.push.status.nextAt ? { nextAt: new Date(current.push.status.nextAt) } : {}),
          failures: current.push.status.failures ?? 0,
        }
      : undefined,
    refresh,
  };
}

type StateTarget = { params?: Record<string, unknown>; key?: string | number; instance?: string };

/**
 * États partagés hors d’un composant (fonctions, et pages pour un geste) : lire une fois, s’abonner pour un temps,
 * publier (module déclarant seulement).
 */
export const states = {
  /** Valeur courante : `{ value, empty, updatedAt, refresh }` ; une liste d’entités rend ses objets. */
  get<Value = unknown>(
    name: string,
    options: StateTarget = {},
  ): Promise<{ value: Value | null; empty: boolean; updatedAt?: number | null; refresh?: unknown }> {
    return request("states.get", { name, ...options });
  },
  /**
   * Abonne la fonction à un état pour `seconds` secondes (10 minutes par défaut, un jour au plus) : le fournisseur
   * le rafraîchit pendant ce temps. Les changements arrivent par le bus d’événements (`events.subscribes` sur
   * `module/etat.<id>`). Rend `{ id }`, pour `states.unsubscribe(id)`.
   */
  subscribe(name: string, options: StateTarget & { seconds?: number } = {}) {
    return request<{ id: string; key: string }>("states.subscribe", { name, ...options });
  },
  unsubscribe(id: string) {
    return request<{ removed: boolean }>("states.unsubscribe", { id });
  },
  /** Publie un état ou une entité du module : chaque abonné se met à jour. */
  publish(name: string, value: unknown, options: StateTarget = {}) {
    return request<{ changed: number }>("states.publish", { name, value, ...options });
  },
};

// --- Entre la page et son panneau ------------------------------------------------------------------------------

const CHANGED = { alfred: "changed" } as const;

function isChangeMessage(message: unknown) {
  return typeof message === "object" && message !== null && (message as { alfred?: unknown }).alfred === "changed";
}

/**
 * Prévient l’autre cadre de la page qu’une donnée a changé (après une écriture dans le panneau, ou dans la liste) :
 * chaque `useAsync` de l’autre cadre se relance de lui-même.
 */
export function announceChange() {
  return shell.send(CHANGED).catch(() => undefined);
}

/**
 * Sélection publiée par la page (`shell.publish`), pour son panneau de droite : l’objet choisi dans la liste,
 * `undefined` tant que rien n’est reçu, `null` quand la page ne sélectionne rien.
 */
export function useSelection<T = unknown>(): T | null | undefined {
  const context = usePageContext();
  return context ? ((context.selection ?? null) as T | null) : undefined;
}

// --- État retenu de la page ------------------------------------------------------------------------------------

let keptState: Record<string, unknown> | null = null;

/** Réservé à l’hôte du cadre : l’état retenu par Alfred pour la page, reçu avant son premier affichage. */
export function initPageState(initial: Record<string, unknown>) {
  keptState = initial;
}

/**
 * Comme `useState`, mais Alfred retient la valeur quand on quitte la page et la rend quand on y revient (vue, onglet,
 * ligne ouverte, période choisie). La clé est propre à la page ; la valeur tient en JSON et reste petite. Hors d’un
 * cadre de page (tests), c’est un `useState`.
 */
export function usePageState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (keptState && key in keptState) return keptState[key] as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const first = useRef(true);
  useEffect(() => {
    // La valeur de départ est déjà connue d’Alfred (ou c’est la valeur par défaut) : rien à envoyer.
    if (first.current) {
      first.current = false;
      return;
    }
    if (!keptState) return;
    keptState[key] = value;
    void request("shell.state.set", { key, value }).catch(() => undefined);
  }, [key, value]);
  return [value, setValue];
}

export { loadPdf, loadTerminal } from "./engines";
