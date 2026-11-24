import { openPageWindow } from "../lib/native";
import { frameServices } from "./frameBridge";
import { deliverEntryAction, entryTarget, type MenuEntry, SECTION_ZONE, zoneModule } from "./menuZones";
import { notify } from "./notifications";
import { useShell } from "./store";

/** Ouvre la page d’une entrée seule dans sa fenêtre, sur cette entrée : une fenêtre par entrée. */
export function openZoneEntryWindow(zonePage: string, entry: MenuEntry) {
  void openPageWindow(entryTarget(zonePage, entry), {
    params: { entry: { id: entry.id, label: entry.label, zone: zonePage } },
    key: `entry:${zonePage}:${entry.id}`,
    title: entry.label,
  }).catch((error: unknown) =>
    notify({
      title: "La fenêtre n’a pas pu s’ouvrir",
      description: error instanceof Error ? error.message : String(error),
      tone: "error",
    }),
  );
}

/** Ouvre la page d’une entrée avec cette entrée ; la page la lit dans `usePageContext().entry`. */
export function openZoneEntry(zonePage: string, entry: MenuEntry) {
  useShell.getState().openEntry(entryTarget(zonePage, entry), { id: entry.id, label: entry.label, zone: zonePage });
}

/**
 * Action choisie sur une entrée : la fonction du module qui la déclare, sinon la page de la zone, ouverte avec
 * l’entrée puis prévenue.
 */
export function runZoneAction(zonePage: string, entry: MenuEntry, actionId: string, value?: string) {
  const action = entry.actions?.find((candidate) => candidate.id === actionId);
  const event = { entry: entry.id, action: actionId, ...(value !== undefined ? { value } : {}) };
  if (action?.function) {
    const module = zoneModule(zonePage);
    const reference = zonePage.startsWith(SECTION_ZONE) ? entryTarget(zonePage, entry) : zonePage;
    if (!frameServices.callFunction) return;
    void frameServices
      .callFunction({ kind: "page", module, reference }, `${module}/${action.function}`, {
        ...event,
        page: zonePage,
      })
      .catch((error: unknown) =>
        notify({
          title: `« ${action.label} » n’a pas abouti`,
          description: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
    return;
  }
  // « Ouvrir dans une fenêtre » (`window`) : Alfred ouvre la page de l’entrée seule, sur cette entrée.
  if (actionId === "window") return openZoneEntryWindow(zonePage, entry);
  // Une section créée n’a pas de page à elle : l’action va à la page que l’entrée ouvre.
  deliverEntryAction(zonePage.startsWith(SECTION_ZONE) ? entryTarget(zonePage, entry) : zonePage, event);
  // Renommer se fait dans la ligne : la page reçoit le nouveau libellé sans être ouverte.
  if (actionId !== "rename") openZoneEntry(zonePage, entry);
}
