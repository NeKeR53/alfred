/**
 * Actions qu’une page place dans la barre du haut (`useTopBarActions` du SDK). Le cadre n’envoie que leur description
 * (identifiant, libellé, nom d’icône Lucide, état) ; un clic revient au cadre par son identifiant, et c’est lui qui
 * exécute l’action (confirmation comprise). La coquille les dessine avec `ActionBar` zone `topbar` (`frameActions`).
 */
import { icons } from "lucide-react";
import { create } from "zustand";

export interface TopBarActionDescriptor {
  id: string;
  label: string;
  icon?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  running?: boolean;
  /** Bascule de vue : boutons accolés d’un même groupe, `selected` sur la vue affichée. */
  group?: string;
  selected?: boolean;
}

const MAX_ACTIONS = 12;

export const useTopBarActionStore = create<{ actions: Record<string, TopBarActionDescriptor[]> }>(() => ({
  actions: {},
}));
const listeners = new Map<string, Set<(id: string) => void>>();

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Valide et range les actions d’une page (une liste vide les retire). */
export function setTopBarActions(reference: string, value: unknown) {
  const list = (Array.isArray(value) ? value : []).slice(0, MAX_ACTIONS).flatMap((item): TopBarActionDescriptor[] => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const id = text(raw.id, 120);
    const label = text(raw.label, 120);
    if (!id || !label) return [];
    const icon = text(raw.icon, 60);
    return [
      {
        id,
        label,
        ...(icon && icon in icons ? { icon } : {}),
        ...(raw.primary === true ? { primary: true } : {}),
        ...(raw.danger === true ? { danger: true } : {}),
        ...(raw.disabled === true ? { disabled: true } : {}),
        ...(raw.running === true ? { running: true } : {}),
        ...(text(raw.group, 40) && icon in icons
          ? { group: text(raw.group, 40), selected: raw.selected === true }
          : {}),
      },
    ];
  });
  const { actions } = useTopBarActionStore.getState();
  const { [reference]: _, ...rest } = actions;
  useTopBarActionStore.setState({ actions: list.length ? { ...rest, [reference]: list } : rest });
}

/** Le cadre de la page reçoit l’action choisie dans la barre ; renvoie le désabonnement. */
export function onTopBarAction(reference: string, listener: (id: string) => void): () => void {
  const set = listeners.get(reference) ?? new Set();
  set.add(listener);
  listeners.set(reference, set);
  return () => {
    set.delete(listener);
  };
}

export function activateTopBarAction(reference: string, id: string) {
  for (const listener of listeners.get(reference) ?? []) listener(id);
}
