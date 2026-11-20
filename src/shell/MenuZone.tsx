import { IconButton } from "@alfred/ui";
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { badgeText } from "./badges";
import { NamedIcon } from "./icons";
import type { MenuEntryStatus } from "./menuZones";
import { useShell } from "./store";
import "./menu-zone.css";

/** Ligne d’une zone du menu, telle que la coquille l’affiche (entrées d’une page, conversations de l’agent). */
export interface ZoneRow {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  status?: MenuEntryStatus;
  badge?: number;
  /** Précision lue avec le libellé et en infobulle (« Codex · Au travail »). */
  details?: string;
  actions?: Array<{ id: string; label: string; icon: string }>;
}

export const STATUS_LABEL: Record<MenuEntryStatus, string> = {
  ok: "Bon",
  warning: "À surveiller",
  error: "En échec",
  running: "Au travail",
  waiting: "Réponse attendue",
};

/** Pastille d’état, reprise de celle des agents dans la navigation de OneApp. */
export function StatusGlyph({ status }: { status?: MenuEntryStatus }) {
  return (
    <span className={`menu-zone-state menu-zone-state--${status ?? "none"}`} aria-hidden="true">
      {status === "waiting" ? (
        <span className="menu-zone-state__mark">?</span>
      ) : status === "running" ? (
        <LoaderCircle className="is-spinning" size={14} />
      ) : status === "error" ? (
        <CircleAlert size={14} />
      ) : status === "warning" ? (
        <TriangleAlert size={14} />
      ) : status === "ok" ? (
        <CircleCheck size={14} />
      ) : (
        <Circle size={8} />
      )}
    </span>
  );
}

function RowGlyph({ row }: { row: ZoneRow }) {
  if (!row.icon) return <StatusGlyph status={row.status} />;
  return (
    <span className={`menu-zone-glyph product-color--${row.color ?? "steel"}`} aria-hidden="true">
      <NamedIcon name={row.icon} size={14} />
      {row.status ? <span className={`menu-zone-dot menu-zone-dot--${row.status}`} /> : null}
    </span>
  );
}

/** Repli et « Afficher plus » d’une zone, retenus sur le poste. */
function useRemembered(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  return [
    value,
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Sans stockage, le choix vaut jusqu’à la fermeture.
      }
    },
  ];
}

/**
 * Zone du menu de gauche : un petit séparateur, un titre facultatif qui replie la zone, puis une ligne par entrée,
 * avec sa pastille d’état, son compteur et ses actions au survol ou au focus. Au clavier : Entrée ouvre l’entrée, F2
 * la renomme (si l’entrée le permet), Alt+↑ et Alt+↓ la déplacent (ordre de l’utilisateur). Menu replié : seul le
 * glyphe reste, le libellé passe en infobulle.
 */
export function MenuZoneView({
  zoneKey,
  label,
  title,
  rows,
  activeId,
  visible,
  onOpen,
  onAction,
  onMove,
}: {
  /** Clé du repli retenu sur le poste. */
  zoneKey: string;
  /** Nom accessible de la liste (« Produits de Catalogue »). */
  label: string;
  title?: string;
  rows: readonly ZoneRow[];
  activeId?: string;
  visible?: number;
  onOpen: (id: string) => void;
  onAction?: (id: string, action: string, value?: string) => void;
  /** Ordre de l’utilisateur : déplace l’entrée d’un cran, faux si elle est au bord. */
  onMove?: (id: string, step: -1 | 1) => boolean;
}) {
  const collapsedNav = useShell((state) => state.sidebarCollapsed);
  const [folded, setFolded] = useRemembered(`alfred.menuZone.folded:${zoneKey}`, false);
  const [expanded, setExpanded] = useRemembered(`alfred.menuZone.expanded:${zoneKey}`, false);
  const [renaming, setRenaming] = useState<string>();
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (renaming || !refocus.current) return;
    const id = refocus.current;
    refocus.current = undefined;
    list.current?.querySelector<HTMLElement>(`[data-zone-entry="${CSS.escape(id)}"] .menu-zone-row__nav`)?.focus();
  });
  if (!rows.length) return null;
  const limit = visible && visible < rows.length && !expanded ? visible : rows.length;
  // L’entrée ouverte reste visible même au-delà de la limite.
  const shown = rows.filter((row, index) => index < limit || row.id === activeId);
  const hidden = rows.length - shown.length;
  const open = !folded || collapsedNav;

  const keyDown = (event: KeyboardEvent, row: ZoneRow) => {
    if (event.key === "F2" && row.actions?.some((action) => action.id === "rename") && !collapsedNav) {
      event.preventDefault();
      setRenaming(row.id);
    } else if (onMove && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      onMove(row.id, event.key === "ArrowUp" ? -1 : 1);
      requestAnimationFrame(() => {
        list.current
          ?.querySelector<HTMLElement>(`[data-zone-entry="${CSS.escape(row.id)}"] .menu-zone-row__nav`)
          ?.focus();
      });
    }
  };

  return (
    <div className="menu-zone">
      <hr className="menu-zone__separator" />
      {title && !collapsedNav ? (
        <button
          type="button"
          className="menu-zone__title"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setFolded(!folded)}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <span>{title}</span>
        </button>
      ) : null}
      {open ? (
        <ul ref={list} id={listId} aria-label={label} className="menu-zone__list">
          {shown.map((row) => {
            const status = row.status ? STATUS_LABEL[row.status] : undefined;
            const accessible = [row.label, row.details, status && !row.details?.includes(status) ? status : ""]
              .concat(row.badge ? [`${row.badge} nouveauté${row.badge > 1 ? "s" : ""}`] : [])
              .filter(Boolean)
              .join(" · ");
            const active = row.id === activeId;
            return (
              <li
                key={row.id}
                data-zone-entry={row.id}
                className={`menu-zone-row${active ? " is-active" : ""}${row.badge ? " has-count" : ""}${renaming === row.id ? " is-editing" : ""}`}
              >
                {renaming === row.id && !collapsedNav ? (
                  <div className="menu-zone-row__editor">
                    <RowGlyph row={row} />
                    <RenameInput
                      label={`Nom de ${row.label}`}
                      value={row.label}
                      onDone={(value) => {
                        refocus.current = row.id;
                        setRenaming(undefined);
                        if (value?.trim() && value.trim() !== row.label) onAction?.(row.id, "rename", value.trim());
                      }}
                    />
                  </div>
                ) : (
                  <IconButton
                    appearance="navigation"
                    className={`menu-zone-row__nav${active ? " is-active" : ""}`}
                    label={accessible}
                    tooltip={collapsedNav ? [row.label, row.details ?? status].filter(Boolean).join("\n") : false}
                    tooltipPlacement="right"
                    aria-current={active ? "page" : undefined}
                    aria-keyshortcuts={
                      [
                        row.actions?.some((action) => action.id === "rename") ? "F2" : "",
                        onMove ? "Alt+ArrowUp Alt+ArrowDown" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onClick={() => onOpen(row.id)}
                    onKeyDown={(event) => keyDown(event, row)}
                  >
                    <RowGlyph row={row} />
                    <span className="sidebar__label" aria-hidden="true">
                      {row.label}
                    </span>
                    {row.badge ? (
                      <span className={`menu-zone-row__count${collapsedNav ? " is-collapsed" : ""}`} aria-hidden="true">
                        {badgeText(row.badge)}
                      </span>
                    ) : null}
                  </IconButton>
                )}
                {row.actions?.length && !collapsedNav && renaming !== row.id ? (
                  <span className="menu-zone-row__actions">
                    {row.actions.map((action) => (
                      <IconButton
                        key={action.id}
                        size="compact"
                        label={`${action.label} ${row.label}`}
                        tooltip={action.label}
                        aria-keyshortcuts={action.id === "rename" ? "F2" : undefined}
                        onClick={() => (action.id === "rename" ? setRenaming(row.id) : onAction?.(row.id, action.id))}
                      >
                        <NamedIcon name={action.icon} size={14} />
                      </IconButton>
                    ))}
                  </span>
                ) : null}
              </li>
            );
          })}
          {visible && visible < rows.length && !collapsedNav ? (
            <li className="menu-zone__more-row">
              <button
                type="button"
                className="menu-zone__more"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Afficher moins" : `Afficher plus (${hidden})`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Saisie du nouveau libellé, dans la ligne : Entrée valide, Échap annule, quitter le champ valide. */
function RenameInput({
  label,
  value,
  onDone,
}: {
  label: string;
  value: string;
  onDone: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (result: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      className="menu-zone-row__input"
      aria-label={label}
      value={text}
      maxLength={120}
      // biome-ignore lint/a11y/noAutofocus: la saisie s’ouvre sur un geste explicite (Renommer, F2).
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(text);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(undefined);
        }
      }}
    />
  );
}
