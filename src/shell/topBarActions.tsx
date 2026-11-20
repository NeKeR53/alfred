/**
 * Actions qu’une page place dans la barre du haut (`useTopBarActions` du SDK, ou `Page actions` de `@alfred/ui`).
 * Le cadre n’envoie que leur description (identifiant, libellé, nom d’icône Lucide, état) ; un clic revient au cadre
 * par son identifiant, et c’est lui qui exécute l’action (confirmation comprise). Comme dans OneApp : icônes avec
 * infobulle, menu « ⋯ » pour les actions sans icône et les actions destructrices, action principale en dernier ; une
 * fenêtre étroite range tout dans « ⋯ ».
 */
import { Button, ChoiceButton, ChoiceGroup, IconButton, MenuGroup, MenuItem, OverflowMenu } from "@alfred/ui";
import { icons } from "lucide-react";
import { useSyncExternalStore } from "react";
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
/** Au-dessous de cette largeur de fenêtre, les actions passent toutes dans « ⋯ » (une seule rangée). */
export const NARROW_WIDTH = 1100;
/** Icônes visibles au plus ; les suivantes vont dans « ⋯ ». */
const VISIBLE_ICONS = 4;

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

function subscribeWidth(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** Vrai quand la fenêtre est étroite : les actions passent dans « ⋯ ». */
export function useNarrowWindow() {
  return useSyncExternalStore(subscribeWidth, () => window.innerWidth < NARROW_WIDTH);
}

/**
 * Répartit les actions : bascules de vue (boutons accolés, toujours visibles), icônes visibles, menu « ⋯ » (dont les
 * destructrices à part), action principale.
 */
export function arrangeTopBarActions(list: ReadonlyArray<TopBarActionDescriptor>, narrow: boolean) {
  const toggles: TopBarActionDescriptor[][] = [];
  for (const action of list.filter((item) => item.group && !item.danger)) {
    const same = toggles.find((group) => group[0].group === action.group);
    if (same) same.push(action);
    else toggles.push([action]);
  }
  const grouped = new Set(toggles.flat());
  const others = list.filter((action) => !grouped.has(action));
  const primary = narrow ? undefined : others.find((action) => action.primary && !action.danger);
  const rest = others.filter((action) => action !== primary);
  const icons = narrow ? [] : rest.filter((action) => action.icon && !action.danger).slice(0, VISIBLE_ICONS);
  const menu = rest.filter((action) => !icons.includes(action));
  return { toggles, primary, icons, menu: menu.filter((a) => !a.danger), dangerous: menu.filter((a) => a.danger) };
}

function Icon({ name }: { name?: string }) {
  const Component = name ? icons[name as keyof typeof icons] : undefined;
  return Component ? <Component size={16} aria-hidden="true" /> : null;
}

export function TopBarActions({ reference }: { reference: string }) {
  const list = useTopBarActionStore((state) => state.actions[reference]);
  const narrow = useNarrowWindow();
  if (!list?.length) return null;
  const { toggles, primary, icons: shown, menu, dangerous } = arrangeTopBarActions(list, narrow);
  const run = (action: TopBarActionDescriptor) => activateTopBarAction(reference, action.id);
  return (
    <span className="shell-topbar__actions">
      {toggles.map((group) => (
        <ChoiceGroup key={group[0].group} label={group[0].group ?? "Vue"} appearance="segmented">
          {group.map((action) => (
            <ChoiceButton
              key={action.id}
              label={action.label}
              size="compact"
              selected={action.selected === true}
              disabled={action.disabled}
              onClick={() => run(action)}
            >
              <Icon name={action.icon} />
            </ChoiceButton>
          ))}
        </ChoiceGroup>
      ))}
      {shown.map((action) => (
        <IconButton
          key={action.id}
          label={action.label}
          tooltip={action.label}
          disabled={action.disabled}
          loading={action.running}
          loadingLabel={`${action.label}…`}
          onClick={() => run(action)}
        >
          <Icon name={action.icon} />
        </IconButton>
      ))}
      {menu.length + dangerous.length > 0 ? (
        <OverflowMenu label="Autres actions de la page">
          {menu.map((action) => (
            <MenuItem key={action.id} disabled={action.disabled} onClick={() => run(action)}>
              <Icon name={action.icon} />
              {action.label}
            </MenuItem>
          ))}
          {dangerous.length ? (
            <MenuGroup label="Actions définitives">
              {dangerous.map((action) => (
                <MenuItem key={action.id} tone="danger" disabled={action.disabled} onClick={() => run(action)}>
                  <Icon name={action.icon} />
                  {action.label}
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null}
        </OverflowMenu>
      ) : null}
      {primary ? (
        <Button variant="primary" disabled={primary.disabled} loading={primary.running} onClick={() => run(primary)}>
          {primary.label}
        </Button>
      ) : null}
    </span>
  );
}
