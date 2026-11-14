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
}

export interface ResolvedSection {
  /** `module/section`, ou `module/section@instance` pour la copie d’une section par instance. */
  id: string;
  module: string;
  label: string;
  icon: string | null;
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
