import { useEffect, useRef } from "react";
import { type Action, useRunAction } from "./actions";
import { useFrameServices } from "./services";

/** Description sans fonction d’une action pour la barre du haut (même forme que le SDK). */
export interface TopBarActionDescriptor {
  id: string;
  label: string;
  icon?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  running?: boolean;
  group?: string;
  selected?: boolean;
}

const iconName = (icon: Action["icon"]) => {
  const named = icon as { displayName?: string; name?: string } | undefined;
  return named?.displayName ?? (named?.name && named.name !== "Object" ? named.name : undefined);
};

export function describeActions(actions: ReadonlyArray<Action>, running: string | null): TopBarActionDescriptor[] {
  return actions
    .filter((action) => !action.hidden)
    .map((action, index) => {
      const id = `${index}:${action.label}`;
      const icon = iconName(action.icon);
      return {
        id,
        label: action.label,
        ...(icon ? { icon } : {}),
        ...(action.primary ? { primary: true } : {}),
        ...(action.danger ? { danger: true } : {}),
        ...(action.disabled ? { disabled: true } : {}),
        ...(running === action.label ? { running: true } : {}),
        ...(action.group ? { group: action.group, selected: action.selected === true } : {}),
      };
    });
}

/**
 * Place les actions d’une page dans la barre du haut d’Alfred quand la page tourne dans son cadre (`enabled`) : la
 * coquille ne reçoit que leur description, et un clic revient ici, où l’action s’exécute comme dans une barre
 * (confirmation d’une action `danger` ou `confirm`, attente, notification). Rend `true` quand la barre du haut les
 * porte ; `false` hors d’un cadre de page (panneau, capture, tests), où la page garde sa propre barre.
 */
export function useTopBarActionsField(actions: ReadonlyArray<Action> | undefined, enabled: boolean): boolean {
  const declare = useFrameServices().topBarActions;
  const active = Boolean(declare && enabled && actions?.length);
  const { run, running } = useRunAction();
  const latest = useRef({ actions: actions ?? [], run });
  latest.current = { actions: actions ?? [], run };
  const handle = useRef<{ update(list: TopBarActionDescriptor[]): void; dispose(): void } | null>(null);
  const key = active ? JSON.stringify(describeActions(actions ?? [], running)) : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: la déclaration vit tant que la page est dans la barre ; `key` passe par `update`.
  useEffect(() => {
    if (!active || !declare) return;
    const declared = declare(JSON.parse(key), (id) => {
      const visible = latest.current.actions.filter((action) => !action.hidden);
      const action = visible.find((item, index) => `${index}:${item.label}` === id);
      if (action && !action.disabled) void latest.current.run(action);
    });
    handle.current = declared;
    return () => {
      declared.dispose();
      if (handle.current === declared) handle.current = null;
    };
  }, [active, declare]);

  useEffect(() => {
    if (key) handle.current?.update(JSON.parse(key));
  }, [key]);

  return active;
}
