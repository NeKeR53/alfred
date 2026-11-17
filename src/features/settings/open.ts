import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";

/** Clé de `activeTab` qui demande d’ouvrir la fiche d’un module (voir `openModuleSettings`). */
export const MODULE_FOCUS = "réglages:module";

/** Ouvre les Réglages sur une rubrique. */
export function openSettings(tab: string) {
  const shell = useShell.getState();
  shell.setView({ kind: "settings" });
  shell.setActiveTab(SETTINGS_SECTION, tab);
}

/** Ouvre la fiche d’un module dans la rubrique Modules. */
export function openModuleSettings(module: string) {
  openSettings("modules");
  useShell.getState().setActiveTab(MODULE_FOCUS, module);
}
