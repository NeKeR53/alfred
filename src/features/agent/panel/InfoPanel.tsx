import { ChevronDown, GripVertical } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { useDragReorder } from "../../../shell/useDragReorder";
import "./info-panel.css";

/**
 * Panneau de droite en cartes repliables et réordonnables, repris de OneApp (`components/shared/InfoPanel.tsx`) :
 * mêmes en-têtes, mêmes lignes à pictogramme d’état dans la marge, même disposition retenue sur le poste.
 */
export type InfoPanelCard = {
  id: string;
  title: string;
  /** État court affiché dans l’en-tête, lisible même carte repliée. */
  summary?: string;
  summaryTone?: InfoPanelTone;
  /** Action de la carte (par exemple « + »), à droite de son en-tête, hors du bouton qui la replie. */
  action?: ReactNode;
  content: ReactNode;
};

type InfoPanelTone = "neutral" | "success" | "warning" | "danger";

/** Ligne d’une section : pictogramme d’état dans la marge, texte aligné sur le titre, détail court à droite. */
export type InfoPanelRow = {
  key: string;
  glyph: ReactNode;
  tone?: InfoPanelTone;
  text: string;
  meta?: string;
  onSelect?: () => void;
  selected?: boolean;
  /** Infobulle native et précision lue par les lecteurs d’écran. */
  title?: string;
  description?: string;
  /** État lu seulement par les lecteurs d’écran, quand le pictogramme est le seul à le montrer. */
  announcement?: string;
  /** Action révélée au survol, à droite de la ligne. */
  action?: ReactNode;
};

export function InfoPanelNote({ children }: { children: ReactNode }) {
  return <p className="info-panel__note">{children}</p>;
}

/**
 * Lignes d’une carte, mêmes alignements partout. `detailed`, comme dans OneApp, affiche la précision de chaque ligne
 * sous son texte, en petit (suivi des conversations) ; sinon, elle n’est lue que par les lecteurs d’écran.
 */
export function InfoPanelRows({
  rows,
  empty,
  variant = "compact",
}: {
  rows: readonly InfoPanelRow[];
  empty: ReactNode;
  variant?: "compact" | "detailed";
}) {
  if (!rows.length) return <InfoPanelNote>{empty}</InfoPanelNote>;
  return (
    <ul className={`info-panel-rows${variant === "detailed" ? " info-panel-rows--detailed" : ""}`}>
      {rows.map((row) => {
        const tone = row.tone ?? "neutral";
        const content = (
          <>
            <span className={`info-panel-rows__glyph info-panel-rows__glyph--${tone}`} aria-hidden="true">
              {row.glyph}
            </span>
            {variant === "detailed" ? (
              <span className="info-panel-rows__label">
                <span className="info-panel-rows__text">{row.text}</span>
                {row.description ? <span className="info-panel-rows__description">{row.description}</span> : null}
              </span>
            ) : (
              <>
                <span className="info-panel-rows__text">{row.text}</span>
                {row.description ? <span className="sr-only"> · {row.description}</span> : null}
              </>
            )}
            {row.announcement ? <span className="sr-only"> · {row.announcement}</span> : null}
            {row.meta ? (
              <span className={`info-panel-rows__meta info-panel-rows__meta--${tone}`}>{row.meta}</span>
            ) : null}
          </>
        );
        return (
          <li key={row.key} className={row.action ? "has-action" : undefined}>
            {row.onSelect ? (
              <button
                type="button"
                className={`info-panel-rows__button${row.selected ? " is-selected" : ""}`}
                aria-current={row.selected ? "true" : undefined}
                title={row.title}
                onClick={row.onSelect}
              >
                {content}
              </button>
            ) : (
              content
            )}
            {row.action ? <span className="info-panel-rows__action">{row.action}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export type InfoPanelLayout = { order: string[]; collapsed: string[]; hidden: boolean };

function readLayout(key: string, ids: readonly string[]): InfoPanelLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<InfoPanelLayout> | null;
    const order = (saved?.order ?? []).filter((id) => ids.includes(id));
    return {
      order: [...order, ...ids.filter((id) => !order.includes(id))],
      collapsed: (saved?.collapsed ?? []).filter((id) => ids.includes(id)),
      hidden: Boolean(saved?.hidden),
    };
  } catch {
    return { order: [...ids], collapsed: [], hidden: false };
  }
}

/** Disposition du panneau (ordre, cartes repliées, panneau masqué), retenue sur le poste. */
export function useInfoPanelLayout(name: string, ids: readonly string[]) {
  const key = `alfred.infoPanel.${name}`;
  const [layout, setLayout] = useState(() => readLayout(key, ids));
  const save = useCallback(
    (update: (current: InfoPanelLayout) => InfoPanelLayout) =>
      setLayout((current) => {
        const next = update(current);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Stockage indisponible : la disposition vaut pour la session.
        }
        return next;
      }),
    [key],
  );
  return useMemo(
    () => ({
      layout,
      setHidden: (hidden: boolean) => save((current) => ({ ...current, hidden })),
      toggle: (id: string) =>
        save((current) => ({
          ...current,
          collapsed: current.collapsed.includes(id)
            ? current.collapsed.filter((item) => item !== id)
            : [...current.collapsed, id],
        })),
      reorder: async (order: string[]) => save((current) => ({ ...current, order })),
    }),
    [layout, save],
  );
}

export type InfoPanelState = ReturnType<typeof useInfoPanelLayout>;

/** Colonne de cartes repliables, réordonnables à la souris ou avec Alt+flèches. */
export function InfoPanel({
  label,
  cards,
  panel,
}: {
  label: string;
  cards: readonly InfoPanelCard[];
  panel: InfoPanelState;
}) {
  const ordered = useMemo(() => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return panel.layout.order.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    });
  }, [cards, panel.layout.order]);
  const { scopeId, orderedItems, draggedId, dropTarget, startDrag, moveItem } = useDragReorder(ordered, (order) =>
    panel.reorder(order),
  );

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveItem(id, event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    <aside className="info-panel" aria-label={label}>
      {orderedItems.map((card, index) => {
        const open = !panel.layout.collapsed.includes(card.id);
        const bodyId = `${scopeId}-${card.id}`;
        return (
          <section
            key={card.id}
            className={[
              "info-panel__card",
              draggedId === card.id ? "is-dragging" : "",
              dropTarget?.id === card.id ? `is-drop-${dropTarget.placement}` : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={card.title}
            data-sortable-id={card.id}
            data-sortable-scope={scopeId}
          >
            <div className="info-panel__header">
              <button
                type="button"
                className="info-panel__handle"
                aria-label={`Déplacer ${card.title}, position ${index + 1} sur ${orderedItems.length}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title="Glisser, ou Alt+↑/↓, pour déplacer"
                onPointerDown={(event) => {
                  const row = event.currentTarget.closest<HTMLElement>(".info-panel__card");
                  if (row) startDrag(event, card.id, row);
                }}
                onKeyDown={(event) => onHandleKeyDown(event, card.id)}
              >
                <GripVertical size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="info-panel__toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => panel.toggle(card.id)}
              >
                <span className="info-panel__title">{card.title}</span>
                <ChevronDown
                  size={12}
                  aria-hidden="true"
                  className={`info-panel__chevron${open ? "" : " is-folded"}`}
                />
                {card.summary ? (
                  <span className={`info-panel__summary info-panel__summary--${card.summaryTone ?? "neutral"}`}>
                    {card.summary}
                  </span>
                ) : null}
              </button>
              {card.action ? <span className="info-panel__action">{card.action}</span> : null}
            </div>
            <div className="info-panel__body" id={bodyId} hidden={!open}>
              {card.content}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
