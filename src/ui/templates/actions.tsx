import { type ComponentType, useState } from "react";
import { Button, IconButton } from "../components/Button";
import { MenuGroup, MenuItem } from "../components/Menu";
import { OverflowMenu } from "../components/OverflowMenu";
import { confirmAction, isDialogPromise } from "./dialogs";
import { CHANGED, errorMessage, useFrameServices } from "./services";

/** Icône de `lucide-react`, passée sans l’instancier : `icon: Pencil`. */
export type ActionIcon = ComponentType<{ size?: number | string; "aria-hidden"?: boolean | "true" | "false" }>;

/**
 * Une action, décrite par ce qu’elle fait. Le gabarit qui la reçoit décide de son apparence et de sa place :
 * bouton principal en texte, icône avec infobulle, ou entrée du menu « ⋯ ». La page ne pose aucun bouton.
 */
export interface Action {
  /** Verbe à l’infinitif et objet : « Nouvelle tâche », « Modifier », « Exporter en CSV ». */
  label: string;
  /** Icône Lucide (`Pencil`, `Trash2`, `Copy`, `Download`…). Sans icône, l’action va dans le menu « ⋯ ». */
  icon?: ActionIcon;
  /** Ce que fait l’action ; une promesse rejetée est notifiée comme un échec. */
  onClick: () => unknown | Promise<unknown>;
  /** L’action principale de l’endroit : bouton plein en texte, en dernier. Une seule ; ignoré dans une ligne. */
  primary?: boolean;
  /** Supprimer, révoquer, vider : entrée rouge du menu « ⋯ », toujours confirmée. */
  danger?: boolean;
  /**
   * Question de confirmation qui nomme l’objet (« Supprimer la tâche « Relancer le client » ? »). Obligatoire en
   * pratique pour `danger` ; sans elle, la question est « {label} ? ».
   */
  confirm?: string;
  /** Conséquence affichée sous la question (« Cette action est définitive. »). */
  confirmMessage?: string;
  /** Notification après la réussite : « Tâche supprimée ». */
  success?: string;
  disabled?: boolean;
  /** L’action n’existe pas dans cet état (« Terminer » sur une tâche terminée). */
  hidden?: boolean;
}

/** Où se trouve la barre : chaque endroit a son nombre d’icônes visibles et son droit à un bouton principal. */
export type ActionPlace = "toolbar" | "header" | "section" | "row" | "empty";

const visibleIcons: Record<ActionPlace, number> = { toolbar: 3, header: 3, section: 2, row: 2, empty: 0 };

/** Exécute une action : confirmation, attente, notification d’échec ou de réussite, signal de changement. */
export function useRunAction(onDone?: () => void) {
  const services = useFrameServices();
  const [running, setRunning] = useState<string | null>(null);
  const run = async (action: Action) => {
    if (action.danger || action.confirm) {
      const accepted = await confirmAction({
        title: action.confirm ?? `${action.label} ?`,
        message: action.confirmMessage,
        confirmLabel: action.label,
        tone: action.danger ? "danger" : "default",
      });
      if (!accepted) return;
    }
    let result: unknown;
    try {
      result = action.onClick();
    } catch (error) {
      services.notify({ title: `« ${action.label} » n’a pas abouti`, description: errorMessage(error), tone: "error" });
      return;
    }
    // Un formulaire ouvert par l’action notifie et signale lui-même ; la liste se recharge s’il a enregistré.
    if (isDialogPromise(result)) {
      if (await result) onDone?.();
      return;
    }
    setRunning(action.label);
    try {
      // Une action synchrone (ouvrir un formulaire, naviguer) n’attend rien et n’annonce aucun changement.
      if (result instanceof Promise) {
        await result;
        if (action.success) services.notify({ title: action.success, tone: "success" });
        services.send(CHANGED);
        onDone?.();
      }
    } catch (error) {
      services.notify({ title: `« ${action.label} » n’a pas abouti`, description: errorMessage(error), tone: "error" });
    } finally {
      setRunning(null);
    }
  };
  return { run, running };
}

/** Répartit les actions selon les règles de l’endroit. */
export function arrangeActions(actions: ReadonlyArray<Action>, place: ActionPlace) {
  const shown = actions.filter((action) => !action.hidden);
  const primary = place === "row" ? undefined : shown.find((action) => action.primary && !action.danger);
  const rest = shown.filter((action) => action !== primary);
  const iconCandidates = rest.filter((action) => action.icon && !action.danger);
  const icons = iconCandidates.slice(0, visibleIcons[place]);
  const menu = rest.filter((action) => !icons.includes(action));
  return {
    primary,
    icons,
    menu: menu.filter((action) => !action.danger),
    dangerous: menu.filter((action) => action.danger),
  };
}

/**
 * Barre d’actions dessinée d’après des `Action` : icônes avec infobulle, menu « ⋯ » (actions sans icône, en trop,
 * et destructrices, séparées), puis l’action principale en texte. `subject` complète le nom accessible des icônes
 * (« Modifier la tâche « Relancer le client » »).
 */
export function ActionBar({
  actions,
  place,
  subject,
  onDone,
}: {
  actions: ReadonlyArray<Action>;
  place: ActionPlace;
  subject?: string;
  /** Appelé après la réussite d’une action asynchrone (recharger les données). */
  onDone?: () => void;
}) {
  const { run, running } = useRunAction(onDone);
  const { primary, icons, menu, dangerous } = arrangeActions(actions, place);
  const named = (label: string) => (subject ? `${label} : ${subject}` : label);
  if (place === "empty") {
    return primary ? (
      <Button variant="primary" disabled={primary.disabled} onClick={() => void run(primary)}>
        {primary.label}
      </Button>
    ) : null;
  }
  if (!primary && icons.length === 0 && menu.length === 0 && dangerous.length === 0) return null;
  const small = place === "row";
  return (
    <div className={`al-action-bar al-action-bar--${place}`}>
      {icons.map((action) => {
        const Icon = action.icon as ActionIcon;
        return (
          <IconButton
            key={action.label}
            label={named(action.label)}
            tooltip={action.label}
            size={small ? "small" : "default"}
            appearance={small ? "table" : "default"}
            disabled={action.disabled}
            loading={running === action.label}
            loadingLabel={`${action.label}…`}
            onClick={() => void run(action)}
          >
            <Icon size={16} aria-hidden="true" />
          </IconButton>
        );
      })}
      {menu.length + dangerous.length > 0 ? (
        <OverflowMenu label={named("Autres actions")} size={small ? "small" : "default"}>
          {menu.map((action) => {
            const Icon = action.icon;
            return (
              <MenuItem key={action.label} disabled={action.disabled} onClick={() => void run(action)}>
                {Icon ? <Icon size={16} aria-hidden="true" /> : null}
                {action.label}
              </MenuItem>
            );
          })}
          {dangerous.length > 0 ? (
            <MenuGroup label="Actions définitives">
              {dangerous.map((action) => {
                const Icon = action.icon;
                return (
                  <MenuItem
                    key={action.label}
                    tone="danger"
                    disabled={action.disabled}
                    onClick={() => void run(action)}
                  >
                    {Icon ? <Icon size={16} aria-hidden="true" /> : null}
                    {action.label}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          ) : null}
        </OverflowMenu>
      ) : null}
      {primary ? (
        <Button
          variant="primary"
          disabled={primary.disabled}
          loading={running === primary.label}
          onClick={() => void run(primary)}
        >
          {primary.label}
        </Button>
      ) : null}
    </div>
  );
}
