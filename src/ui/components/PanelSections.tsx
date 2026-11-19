import { ChevronDown, GripVertical } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo } from "react";
import { usePageState } from "../templates/pageState";
import { useDragReorder } from "./useDragReorder";
import "./panel-sections.css";

/**
 * Sections d’un panneau de droite, reprises de OneApp (`InfoPanel`, `useInfoPanelLayout`) : chacune se replie d’un
 * clic sur son titre et se déplace par sa poignée (glisser, ou Alt+↑/↓). L’ordre et les sections repliées sont
 * retenus pour la page, sur le poste.
 */
export interface PanelSection {
  /** Identifiant stable : il retient la place et le repli de la section. */
  id: string;
  title: string;
  /** État court dans l’en-tête, lisible même section repliée : « 3 ouverts », « Échec ». */
  summary?: string;
  summaryTone?: "neutral" | "success" | "warning" | "danger";
  /** Action de la section, à droite de son en-tête, hors du bouton qui la replie. */
  action?: ReactNode;
  /** Repliée tant que l’utilisateur ne l’a pas ouverte. */
  defaultCollapsed?: boolean;
  content: ReactNode;
}

/** Disposition retenue : l’ordre de toutes les sections vues, les sections repliées et celles ouvertes à la main. */
export interface PanelSectionsLayout {
  order: string[];
  collapsed: string[];
  /** Sections `defaultCollapsed` que l’utilisateur a ouvertes. */
  opened: string[];
}

const emptyLayout: PanelSectionsLayout = { order: [], collapsed: [], opened: [] };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readLayout(value: unknown): PanelSectionsLayout {
  if (!value || typeof value !== "object") return emptyLayout;
  const layout = value as Partial<Record<keyof PanelSectionsLayout, unknown>>;
  return { order: strings(layout.order), collapsed: strings(layout.collapsed), opened: strings(layout.opened) };
}

/**
 * Ordre complet : l’ordre retenu, où chaque section jamais vue prend sa place déclarée (avant la première section
 * retenue qui la suit dans `ids`, sinon à la fin). Les sections absentes de cet objet gardent leur place retenue.
 */
export function orderSections(stored: readonly string[], ids: readonly string[]): string[] {
  const order = stored.filter((id, index) => stored.indexOf(id) === index);
  ids.forEach((id, index) => {
    if (order.includes(id)) return;
    const next = ids.slice(index + 1).find((later) => order.includes(later));
    order.splice(next ? order.indexOf(next) : order.length, 0, id);
  });
  return order;
}

/** Place les sections visibles dans leur nouvel ordre, aux places qu’elles occupaient dans l’ordre complet. */
export function reorderSections(full: readonly string[], visible: readonly string[]): string[] {
  const shown = new Set(visible);
  let next = 0;
  return full.map((id) => (shown.has(id) ? (visible[next++] ?? id) : id));
}

/**
 * Colonne de sections repliables et déplaçables. `name` distingue deux listes de sections dans le même panneau ;
 * la disposition est retenue sous la clé réservée `alfred.sections.<name>` de la page.
 */
export function PanelSections({ sections, name = "panel" }: { sections: ReadonlyArray<PanelSection>; name?: string }) {
  const [stored, setStored] = usePageState<unknown>(`alfred.sections.${name}`, emptyLayout);
  const layout = readLayout(stored);
  const ids = sections.map((section) => section.id);
  const idsKey = ids.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsKey` résume `ids`, recréé à chaque rendu.
  const full = useMemo(() => orderSections(layout.order, ids), [layout.order, idsKey]);
  const ordered = useMemo(() => {
    const byId = new Map(sections.map((section) => [section.id, section]));
    return full.flatMap((id) => {
      const section = byId.get(id);
      return section ? [section] : [];
    });
  }, [full, sections]);

  const { scopeId, orderedItems, draggedId, dropTarget, startDrag, moveItem } = useDragReorder(
    ordered,
    async (visible) => {
      setStored((current: unknown) => {
        const previous = readLayout(current);
        return { ...previous, order: reorderSections(orderSections(previous.order, ids), visible) };
      });
    },
  );

  const isOpen = (section: PanelSection) =>
    section.defaultCollapsed ? layout.opened.includes(section.id) : !layout.collapsed.includes(section.id);
  const toggle = (section: PanelSection) =>
    setStored((current: unknown) => {
      const previous = readLayout(current);
      const key = section.defaultCollapsed ? "opened" : "collapsed";
      const list = previous[key];
      return {
        ...previous,
        [key]: list.includes(section.id) ? list.filter((id) => id !== section.id) : [...list, section.id],
      };
    });

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveItem(id, event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    <div className="panel-sections">
      {orderedItems.map((section, index) => {
        const open = isOpen(section);
        const bodyId = `${scopeId}-${section.id}`;
        return (
          <section
            key={section.id}
            className={[
              "panel-sections__section",
              draggedId === section.id ? "is-dragging" : "",
              dropTarget?.id === section.id ? `is-drop-${dropTarget.placement}` : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={section.title}
            data-sortable-id={section.id}
            data-sortable-scope={scopeId}
          >
            <div className="panel-sections__header">
              {orderedItems.length > 1 ? (
                <button
                  type="button"
                  className="panel-sections__handle"
                  aria-label={`Déplacer ${section.title}, position ${index + 1} sur ${orderedItems.length}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title="Glisser, ou Alt+↑/↓, pour déplacer"
                  onPointerDown={(event) => {
                    const row = event.currentTarget.closest<HTMLElement>(".panel-sections__section");
                    if (row) startDrag(event, section.id, row);
                  }}
                  onKeyDown={(event) => onHandleKeyDown(event, section.id)}
                >
                  <GripVertical size={14} aria-hidden="true" />
                </button>
              ) : (
                <span className="panel-sections__handle" aria-hidden="true" />
              )}
              <button
                type="button"
                className="panel-sections__toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => toggle(section)}
              >
                <span className="panel-sections__title">{section.title}</span>
                <ChevronDown
                  size={12}
                  aria-hidden="true"
                  className={`panel-sections__chevron${open ? "" : " is-folded"}`}
                />
                {section.summary ? (
                  <span
                    className={`panel-sections__summary panel-sections__summary--${section.summaryTone ?? "neutral"}`}
                  >
                    {section.summary}
                  </span>
                ) : null}
              </button>
              {section.action ? <span className="panel-sections__action">{section.action}</span> : null}
            </div>
            <div className="panel-sections__body" id={bodyId} hidden={!open}>
              {section.content}
            </div>
          </section>
        );
      })}
    </div>
  );
}
