/** Commande `modules.setup` du backend (voir `src-tauri/src/setup.rs`) : ce qu’il reste à configurer par module. */
import { invoke } from "../../lib/native";

/** Clé de l’onglet actif qui ouvre, dans Réglages → Modules, le parcours de configuration d’un module. */
export const SETUP_FOCUS = "réglages:configuration";

/**
 * Où en est un service dont le module a besoin :
 * - `missing` : aucun service n’y répond ;
 * - `incomplete` : le service existe, mais aucun compte n’est prêt (clé, approbation, connexion…) ;
 * - `untested` : un compte est prêt mais n’a pas été testé depuis sa dernière modification ;
 * - `failed` : les comptes prêts ont échoué à leur dernier test ;
 * - `ready` : un compte est prêt et son dernier test a réussi.
 */
export type SetupStepState = "missing" | "incomplete" | "untested" | "failed" | "ready";

export interface SetupStep {
  /** `module/besoin` : le module qui déclare le besoin (celui-ci ou l’une de ses dépendances). */
  key: string;
  module: string;
  moduleName: string;
  need: string;
  label: string;
  /** Aide du module : où trouver la clé, quel compte utiliser. */
  help: string;
  optional: boolean;
  /** Le module fournit le modèle du service (`clients[].client`) : il se crée en un clic. */
  hasTemplate: boolean;
  /** Service de l’espace qui répond au besoin, ou `null`. */
  client: string | null;
  state: SetupStepState;
}

export interface ModuleSetup {
  module: string;
  name: string;
  description: string;
  /** Texte d’accueil du module (`setup.welcome`), ou vide. */
  welcome: string;
  /** Installé depuis un marketplace (lecture seule). */
  installed: boolean;
  /** Tout l’essentiel est renseigné et testé : les services non facultatifs sont prêts. */
  ready: boolean;
  steps: SetupStep[];
}

export const getSetup = (module?: string) =>
  invoke<{ modules: ModuleSetup[] }>("modules.setup", module ? { module } : {}).then((result) => result.modules);

/** Ce qu’il reste à faire, en mots simples, pour la fiche d’un module. */
export function remainingSummary(setup: ModuleSetup): string {
  const left = setup.steps.filter((step) => !step.optional && step.state !== "ready");
  if (left.length === 0) return "Tout est prêt.";
  return `Reste à configurer : ${left.map((step) => step.label).join(", ")}.`;
}
