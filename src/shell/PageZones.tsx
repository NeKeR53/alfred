import { openPageWindow } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { frameServices } from "./frameBridge";
import { MenuZoneView } from "./MenuZone";
import { deliverEntryAction, entryTarget, type MenuEntry, moveEntry, orderedEntries, useMenuZones } from "./menuZones";
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
    const module = zonePage.split("/")[0] ?? "";
    if (!frameServices.callFunction) return;
    void frameServices
      .callFunction({ kind: "page", module, reference: zonePage }, `${module}/${action.function}`, {
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
  deliverEntryAction(zonePage, event);
  // Renommer se fait dans la ligne : la page reçoit le nouveau libellé sans être ouverte.
  if (actionId !== "rename") openZoneEntry(zonePage, entry);
}

/** Zones des pages visibles d’une section, dans l’ordre de ses onglets, sous l’entrée de la section. */
export function SectionZones({ pages, sectionLabel }: { pages: ResolvedPage[]; sectionLabel: string }) {
  const zones = useMenuZones((state) => state.zones);
  const activeEntry = useShell((state) => state.activeEntry);
  const view = useShell((state) => state.view);
  const activeTab = useShell((state) => state.activeTab);
  return (
    <>
      {pages
        .filter((page) => !page.hidden && zones[page.reference]?.entries.length)
        .map((page) => {
          const zone = zones[page.reference];
          const entries = orderedEntries(zone);
          // L’entrée ouverte : celle de la page affichée, si elle vient de cette zone.
          const shownPage = view.kind === "section" ? activeTab[view.id] : undefined;
          const opened = shownPage ? activeEntry[shownPage] : undefined;
          const activeId = opened?.zone === page.reference ? opened.id : undefined;
          return (
            <MenuZoneView
              key={page.reference}
              zoneKey={page.reference}
              label={zone.title ? `${zone.title} · ${sectionLabel}` : `Entrées de ${page.title}`}
              title={zone.title}
              rows={entries}
              activeId={activeId}
              visible={zone.visible}
              onOpen={(id) => {
                const entry = entries.find((candidate) => candidate.id === id);
                if (entry) openZoneEntry(page.reference, entry);
              }}
              onAction={(id, action, value) => {
                const entry = entries.find((candidate) => candidate.id === id);
                if (entry) runZoneAction(page.reference, entry, action, value);
              }}
              onMove={zone.order === "user" ? (id, step) => moveEntry(page.reference, zone, id, step) : undefined}
            />
          );
        })}
    </>
  );
}
