/** Modèles partagés avec le backend (voir `src-tauri/src/space.rs`). */

export interface Diagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface Uses {
  clients?: string[];
  functions?: string[];
}

export interface ResolvedPage {
  /** `module/page`, ou `module/page@instance` dans une section par instance. */
  reference: string;
  module: string;
  id: string;
  title: string;
  icon: string | null;
  description: string;
  hidden: boolean;
  readOnly: boolean;
  missing: boolean;
  errors: Diagnostic[];
  uses: Uses;
  panel: ResolvedPage | null;
  /** Instance du client que montre la page, dans une section par instance. */
  instance?: string | null;
  /** Besoin client dont la page suit les instances : le sien (`perInstance` de la page), sinon celui de sa section. */
  perInstance?: string | null;
}

/** Page qui est pour chaque compte d’un client : la fiche d’un compte propose de l’ajouter. */
export interface AccountPage {
  /** `module/page` ; la page d’un compte est `module/page@instance`. */
  reference: string;
  module: string;
  title: string;
  /** Nom de la section où elle se range. */
  section: string;
  need: string;
  /** Client de l’espace qui répond au besoin ; `null` s’il n’y en a pas encore. */
  client: string | null;
}

export interface ResolvedSection {
  /** `module/section`, ou `module/section@instance` pour la copie d’une section par instance. */
  id: string;
  module: string;
  label: string;
  /** Nom d’icône Lucide, ou chemin d’une image du module (`icons/jira.svg`). */
  icon: string | null;
  /** Adresse `data:` de l’icône image, quand elle est lisible ; absente pour une icône Lucide. */
  iconUrl?: string | null;
  color: string | null;
  hidden: boolean;
  pages: ResolvedPage[];
  /** Besoin client dont la section suit les instances. */
  perInstance?: string | null;
  /** Instance que montre cette copie de la section. */
  instance?: string | null;
  /** Section déclarée dont celle-ci est la copie. */
  instanceOf?: string | null;
  /** Section par instance sans instance à montrer : ce qu’il faut faire. */
  waiting?: string | null;
}

export interface ModuleOrigin {
  marketplace: string;
  version: string;
  commit: string;
  detached?: boolean;
  pinned?: boolean;
}

export interface ClientNeed {
  id: string;
  label: string;
  baseUrl?: string;
  auth?: string;
  /** Aide du parcours de configuration : où trouver la clé, quel compte utiliser. */
  help?: string;
  /** Le module fonctionne sans ce service. */
  optional?: boolean;
  /** Modèle du service (forme de `clients/<id>.json`, sans secret ni compte), créé tel quel par le parcours. */
  client?: Record<string, unknown>;
}

/** Module dont un autre utilise les fonctions et les clients (`requires` du manifeste). */
export interface Requirement {
  module: string;
  minVersion?: string;
}

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  readOnly: boolean;
  origin: ModuleOrigin | null;
  /** Publications d’un module développé ici : une par marketplace (adresse git), la dernière version envoyée. */
  published?: Array<{ marketplace: string; version: string; commit: string }>;
  /** Masqué du menu, avec toutes ses sections et ses pages (dépendance installée d’office, ou choix). */
  hidden: boolean;
  requires: Requirement[];
  /** Modules de l’espace qui dépendent de celui-ci. */
  requiredBy: string[];
  pages: number;
  functions: number;
  clients: ClientNeed[];
  webhooks: Array<{ id: string; description: string; function: string }>;
  schedules: Array<{ id: string; description: string; function: string; everyMinutes?: number; at?: string }>;
  /** Parcours de configuration : texte d’accueil (`setup` du manifeste). */
  setup?: { welcome?: string } | null;
  /** Tables partagées entre les membres d’une équipe par un dépôt git (`sync.tables` du manifeste). */
  sync?: string[];
}

export interface ResolvedFunction {
  reference: string;
  module: string;
  id: string;
  description: string;
  input: unknown;
  output: unknown;
  tool: boolean;
  missing: boolean;
  errors: Diagnostic[];
  uses: Uses;
  /** Langage : TypeScript (dans l’interface) ou script lancé par Alfred. */
  runtime: FunctionRuntime;
  /** Lecture ou écriture chez le service ; absent, la fonction compte comme une écriture. */
  effect?: FunctionEffect | null;
  /** Cas de test déclarés avec la fonction. */
  tests?: FunctionTestCase[];
  /** Nombre de réponses d’exemple déclarées (mode « données d’exemple »). */
  examples?: number;
}

export type FunctionRuntime = "ts" | "bash" | "pwsh" | "python";
export type FunctionEffect = "read" | "write";

export interface FunctionTestCase {
  name: string;
  input: unknown;
  /** Test d’écriture : cible que l’utilisateur choisit, placée à `input[field]`. */
  target?: { field: string; label: string; hint?: string };
  expect?: unknown;
}

export interface Snapshot {
  path: string;
  name: string;
  accent: string | null;
  sections: ResolvedSection[];
  settingsPages: ResolvedPage[];
  modules: ModuleSummary[];
  functions: ResolvedFunction[];
  bindings: Record<string, string>;
  problems: Array<{ module: string; message: string }>;
  /** Réorganisation enregistrée par l’utilisateur (`alfred.json`) ; l’interface la modifie puis la renvoie entière. */
  layout?: Layout;
  /** Modules affichés avec leurs données d’exemple (réglage du poste, hors de l’espace). */
  examples?: string[];
  /** Pages qui sont pour chaque compte d’un client, que l’utilisateur peut ajouter à un compte. */
  accountPages?: AccountPage[];
  /** Pages ajoutées à chaque compte : `client/instance` → `module/page`. */
  accounts?: Record<string, string[]>;
}

export interface Override {
  label?: string;
  icon?: string;
  color?: string;
  hidden?: boolean;
  placement?: Placement;
}

export interface Layout {
  sections: string[];
  tabs?: Record<string, string[]>;
  settings?: string[];
  overrides?: Record<string, Override>;
}

export type Placement = { kind: "tab"; section: string } | { kind: "panel"; page: string } | { kind: "settings" };

export type PlaceTarget =
  | { kind: "menu"; label: string; icon?: string; color?: string }
  | { kind: "tab"; section: string }
  | { kind: "panel"; page: string }
  | { kind: "settings" };

export interface AppInfo {
  version: string;
  serverPort: number;
  pageBase: string;
  platform: string;
  home: string | null;
}

export interface Commit {
  id: string;
  message: string;
  date: string;
  files: string[];
  /** Lignes ajoutées et retirées par fichier, dans l’ordre de `files` ; `null` pour un fichier binaire. */
  lines?: (FileLines | null)[];
}

export interface FileLines {
  added: number;
  removed: number;
}

export const SECTION_COLORS = ["steel", "blue", "violet", "pink", "red", "orange", "green", "teal"] as const;
export type SectionColor = (typeof SECTION_COLORS)[number];
