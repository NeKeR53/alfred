/**
 * Scripts de Code Mode, côté coquille : les exécutions gardées sept jours (`alfred run`), leur détail, et les
 * scripts gardés comme fonctions (voir src-tauri/src/kept_scripts.rs).
 */
import { invoke } from "../../lib/native";

export interface ScriptRun {
  id: string;
  at: string;
  conversation: string;
  ok: boolean;
  /** Fonctions et états appelés, dans l’ordre (« module/fonction », « état nom »). */
  calls: string[];
  /** Durée en millisecondes ; absente des exécutions gardées avant qu’elle ne soit notée. */
  ms: number | null;
}

export interface ScriptRunDetail extends ScriptRun {
  code: string;
  input: unknown;
  output: unknown;
  /** Module d’accueil proposé : le module majoritaire, sinon « mes-scripts ». */
  home: string;
  /** Modules où l’utilisateur peut garder le script. */
  modules: Array<{ id: string; name: string }>;
}

export interface KeptScript {
  reference: string;
  module: string;
  moduleName: string;
  id: string;
  description: string;
  effect: "read" | "write";
  status: "toValidate" | "accepted";
  conversation: string;
  createdAt: string;
  /** Entrée de son premier test : celle de l’exécution d’origine. */
  input: Record<string, unknown>;
}

export interface ScriptsList {
  runs: ScriptRun[];
  kept: KeptScript[];
  keepDays: number;
}

export const listScripts = () => invoke<ScriptsList>("scripts.list", { limit: 100 });
export const loadRun = (id: string) => invoke<ScriptRunDetail>("scripts.run", { id });
export const keepRun = (draft: { id: string; module: string; name: string; description?: string }) =>
  invoke<{ function: string; status: string }>("scripts.keep", { ...draft });
export const removeKept = (reference: string) => invoke<null>("scripts.remove", { reference });
export const acceptKept = (reference: string) => invoke("functions.acceptKept", { reference });
export const runKept = (reference: string, input: unknown) =>
  invoke<unknown>("functions.call", { function: reference, input });

/** Identifiant de fonction valide : minuscules, chiffres et tirets, comme `alfred run --save`. */
export const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** « notes/lister, crm/clients et 2 autres » ; les doublons ne comptent qu’une fois. */
export function callsLabel(calls: string[]): string {
  const unique = [...new Set(calls)];
  if (unique.length === 0) return "Aucun appel";
  if (unique.length <= 3) return unique.join(", ");
  return `${unique.slice(0, 2).join(", ")} et ${unique.length - 2} autres`;
}

/** « 840 ms », « 1,2 s », « 2 min 5 s ». */
export function duration(ms: number | null): string | undefined {
  if (ms === null || ms === undefined) return undefined;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Nom proposé pour la fonction : tiré du premier appel (« lister » → « lister-script »), sinon « script ». */
export function suggestedName(calls: string[]): string {
  const first = calls.find((call) => call.includes("/"));
  const base = first ? (first.split("/")[1] ?? "script") : "script";
  return `${base}-script`.replace(/[^a-z0-9-]/g, "-");
}

/** Texte court d’une valeur, pour un message : JSON sur une ligne, coupé à `max` caractères. */
export function shortJson(value: unknown, max = 160): string {
  const text = value === undefined ? "(aucune sortie)" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
