/**
 * Pages de l’utilisateur : les entrées du menu qu’il crée à partir des modèles d’un module, leurs onglets et leurs
 * comptes. Chaque appel enregistre l’espace (un commit) et rend la vue à jour, que la coquille affiche aussitôt.
 */
import { invoke } from "../../lib/native";
import type { NewTab, ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
import { baseReference } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";

type MenuResult = Snapshot & { created?: string };

async function run(command: string, args: Record<string, unknown>): Promise<string | undefined> {
  // L’espace affiché : Alfred refuse d’écrire si un autre a été ouvert entre-temps.
  const space = useShell.getState().snapshot?.path;
  const next = await invoke<MenuResult>(command, space ? { ...args, space } : args);
  const { created, ...snapshot } = next;
  useShell.setState({ snapshot });
  return created;
}

export const userPages = {
  /** Nouvelle page : l’apparence de la section `section`, et ses onglets. Rend son identifiant. */
  addPage: (section: string, tabs: NewTab[], label?: string, icon?: string) =>
    run("space.menu.addPage", { section, tabs, ...(label ? { label } : {}), ...(icon ? { icon } : {}) }),
  /** Nouvel onglet dans la page `page`. Rend sa référence. */
  addTab: (page: string, tab: NewTab) => run("space.menu.addTab", { page, tab }),
  /** Nom, icône (vides : ceux du modèle) ou, pour un onglet, comptes. */
  configure: (target: string, changes: { label?: string; icon?: string; accounts?: Record<string, string> }) =>
    run("space.menu.configure", { target, ...changes }),
  remove: (target: string) => run("space.menu.remove", { target }),
  move: (target: string, delta: number) => run("space.menu.move", { target, delta }),
};

/** Modèle d’un onglet : la page déclarée dont il est la copie. */
export const templateOfPage = (page: ResolvedPage) => page.template ?? baseReference(page.reference);

/** Section déclarée d’une page de l’utilisateur. */
export const templateOfSection = (section: ResolvedSection) => section.instanceOf ?? baseReference(section.id);

/** Pages du menu qui viennent du module : sa section, ou l’un de ses modèles en onglet. */
export function userPagesOf(snapshot: Snapshot, module: string): ResolvedSection[] {
  return snapshot.sections.filter(
    (section) =>
      section.module === module || section.pages.some((page) => templateOfPage(page).split("/")[0] === module),
  );
}
