/**
 * « Ordre du menu » : toutes les sections et pages, masquées comprises, avec de quoi les
 * réafficher, les renommer et les réordonner sans glisser-déposer.
 */
import { EmptyState, IconButton, Page, Section, StatusBadge, Text } from "@alfred/ui";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, History, Pencil } from "lucide-react";
import { type PointerEvent, useMemo, useState } from "react";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { SectionIcon } from "../../shell/icons";
import { applyLayoutChange, RenameDialog } from "../../shell/navigationEditing";
import {
  isModuleHidden,
  pagesOf,
  renamePage,
  renameSection,
  reorderSections,
  reorderTabs,
  SETTINGS_SECTION,
  setModuleHidden,
  setPageHidden,
  setSectionHidden,
  shift,
} from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";
import { useDragReorder } from "../../shell/useDragReorder";
import { PageHistoryDialog } from "./PageHistory";
import "./navigation.css";

/** Module masqué qui emporte cette ligne : son bouton réaffiche le module plutôt que la ligne seule. */
function hiddenModuleOf(snapshot: Snapshot, module: string): ModuleSummary | undefined {
  return isModuleHidden(snapshot, module) ? snapshot.modules.find((candidate) => candidate.id === module) : undefined;
}

const moduleName = (module: ModuleSummary) => module.name || module.id;

type Renaming = { kind: "section"; id: string; label: string } | { kind: "page"; reference: string; label: string };

/** Classes de la ligne pendant un glissement : la ligne tirée s’estompe, la cible montre où elle tombera. */
function dragClasses(drag: { draggedId?: string; dropTarget?: { id: string; placement: string } }, id: string) {
  return `${drag.draggedId === id ? " is-dragging" : ""}${drag.dropTarget?.id === id ? ` is-drop-${drag.dropTarget.placement}` : ""}`;
}

/** Le bouton actionné reste sous le focus après le déplacement de sa ligne. */
function refocus(key: string, action: string) {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-nav-row="${CSS.escape(key)}"] [data-nav-action="${action}"]:not(:disabled)`)
      ?.focus(),
  );
}

function RowActions({
  subject,
  rowKey,
  hidden,
  first,
  last,
  onMove,
  onRename,
  onToggle,
  onHistory,
  toggleLabel,
}: {
  subject: string;
  rowKey: string;
  hidden: boolean;
  /** Libellé du bouton d’affichage quand il agit sur autre chose que la ligne (le module qui la masque). */
  toggleLabel?: string;
  first: boolean;
  last: boolean;
  onMove: (offset: -1 | 1) => void;
  onRename: () => void;
  onToggle: () => void;
  /** Pages seulement : ouvre l’historique des modifications de la page. */
  onHistory?: () => void;
}) {
  return (
    <span className="nav-settings__actions">
      {onHistory ? (
        <IconButton size="small" label={`Historique de ${subject}`} tooltip="Historique" onClick={onHistory}>
          <History size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
      <IconButton
        size="small"
        label={`Monter ${subject}`}
        tooltip="Monter"
        data-nav-action="up"
        disabled={first}
        onClick={() => {
          onMove(-1);
          refocus(rowKey, first ? "down" : "up");
        }}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="small"
        label={`Descendre ${subject}`}
        tooltip="Descendre"
        data-nav-action="down"
        disabled={last}
        onClick={() => {
          onMove(1);
          refocus(rowKey, "down");
        }}
      >
        <ArrowDown size={16} aria-hidden="true" />
      </IconButton>
      <IconButton size="small" label={`Renommer ${subject}`} tooltip="Renommer" onClick={onRename}>
        <Pencil size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="small"
        label={toggleLabel ?? `${hidden ? "Réafficher" : "Masquer"} ${subject}`}
        tooltip={hidden ? "Réafficher" : "Masquer"}
        data-nav-action="toggle"
        onClick={() => {
          onToggle();
          refocus(rowKey, "toggle");
        }}
      >
        {hidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
      </IconButton>
    </span>
  );
}

/** Poignée de glissement d’une ligne : un appui la fait glisser ; Alt+Flèche ou les flèches font de même au clavier. */
export function DragHandle({
  subject,
  onPointerDown,
}: {
  subject: string;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <span
      className="nav-settings__handle"
      title={`Glisser pour déplacer ${subject}`}
      onPointerDown={onPointerDown}
      aria-hidden="true"
    >
      <GripVertical size={14} />
    </span>
  );
}

function PageRows({
  place,
  pages,
  onRename,
  onHistory,
}: {
  place: string;
  pages: ResolvedPage[];
  onRename: (renaming: Renaming) => void;
  onHistory: (page: ResolvedPage) => void;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const items = useMemo(() => pages.map((page) => ({ id: page.reference, page })), [pages]);
  const drag = useDragReorder(items, (order, moved) =>
    applyLayoutChange((current) => reorderTabs(current, place, order, moved)),
  );
  if (pages.length === 0)
    return (
      <Text size="meta" tone="muted">
        Aucune page.
      </Text>
    );
  return (
    <ul className="nav-settings__list nav-settings__list--pages">
      {drag.orderedItems.map(({ page }, index) => {
        const key = `page:${page.reference}`;
        const owner = snapshot ? hiddenModuleOf(snapshot, page.module) : undefined;
        return (
          <li
            key={page.reference}
            className={`nav-settings__row sortable-row${dragClasses(drag, page.reference)}`}
            data-nav-row={key}
            data-sortable-scope={drag.scopeId}
            data-sortable-id={page.reference}
          >
            <span className="nav-settings__name">
              <DragHandle
                subject={`la page ${page.title}`}
                onPointerDown={(event) => {
                  const row = event.currentTarget.closest<HTMLElement>("li");
                  if (row) drag.startDrag(event, page.reference, row);
                }}
              />
              <Text as="span" tone={page.hidden ? "muted" : "default"}>
                {page.title}
              </Text>
              {owner ? (
                <StatusBadge size="compact">Module {moduleName(owner)} masqué</StatusBadge>
              ) : page.hidden ? (
                <StatusBadge size="compact">Masquée</StatusBadge>
              ) : null}
              {page.readOnly ? (
                <StatusBadge size="compact" title="Module installé : seule sa présentation se règle ici.">
                  Lecture seule
                </StatusBadge>
              ) : null}
            </span>
            <RowActions
              subject={`la page ${page.title}`}
              rowKey={key}
              hidden={page.hidden}
              first={index === 0}
              last={index === drag.orderedItems.length - 1}
              onMove={(offset) =>
                void applyLayoutChange((snapshot) => {
                  const order = shift(
                    pagesOf(snapshot, place).map((candidate) => candidate.reference),
                    page.reference,
                    offset,
                  );
                  return order ? reorderTabs(snapshot, place, order, page.reference) : null;
                })
              }
              onRename={() => onRename({ kind: "page", reference: page.reference, label: page.title })}
              onHistory={() => onHistory(page)}
              toggleLabel={owner ? `Réafficher le module ${moduleName(owner)}` : undefined}
              onToggle={() =>
                void applyLayoutChange((current) =>
                  owner
                    ? setModuleHidden(current, owner.id, false)
                    : setPageHidden(current, page.reference, !page.hidden),
                )
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export function NavigationSettings() {
  const snapshot = useShell((state) => state.snapshot);
  const [renaming, setRenaming] = useState<Renaming>();
  const [history, setHistory] = useState<ResolvedPage>();
  const items = useMemo(() => (snapshot?.sections ?? []).map((section) => ({ id: section.id, section })), [snapshot]);
  const drag = useDragReorder(items, (order, moved) =>
    applyLayoutChange((current) => reorderSections(current, order, moved)),
  );
  if (!snapshot) return null;
  const { sections, settingsPages } = snapshot;

  return (
    <Page width="text">
      <Section
        title="Ordre du menu"
        description="L’ordre et le nom des sections du menu de gauche et, quand une section en a plusieurs, de ses onglets. Les pages s’activent depuis la fiche de leur module (rubrique Modules). Glissez une ligne par sa poignée pour la déplacer."
      >
        {sections.length === 0 ? (
          <EmptyState title="Aucune section" description="Demander à l’agent de créer une page." size="compact" />
        ) : (
          <ul className="nav-settings__list">
            {drag.orderedItems.map(({ section }, index) => {
              const key = `section:${section.id}`;
              const owner = hiddenModuleOf(snapshot, section.module);
              // Une section d’une seule page tient sur une ligne : la section et sa page s’affichent ensemble.
              const only = section.pages.length === 1 ? section.pages[0] : undefined;
              const hidden = section.hidden || Boolean(only?.hidden);
              return (
                <li
                  key={section.id}
                  className={`nav-settings__section sortable-row${dragClasses(drag, section.id)}`}
                  data-sortable-scope={drag.scopeId}
                  data-sortable-id={section.id}
                >
                  <div className="nav-settings__row" data-nav-row={key}>
                    <span className={`nav-settings__name product-color--${section.color ?? "steel"}`}>
                      <DragHandle
                        subject={`la section ${section.label}`}
                        onPointerDown={(event) => {
                          const row = event.currentTarget.closest<HTMLElement>("li");
                          if (row) drag.startDrag(event, section.id, row);
                        }}
                      />
                      <span className="nav-settings__icon">
                        <SectionIcon section={section} />
                      </span>
                      <Text as="span" tone={hidden ? "muted" : "default"}>
                        {section.label}
                      </Text>
                      {owner ? (
                        <StatusBadge size="compact">Module {moduleName(owner)} masqué</StatusBadge>
                      ) : hidden ? (
                        <StatusBadge size="compact">Masquée</StatusBadge>
                      ) : null}
                      {only?.readOnly ? (
                        <StatusBadge size="compact" title="Module installé : seule sa présentation se règle ici.">
                          Lecture seule
                        </StatusBadge>
                      ) : null}
                    </span>
                    <RowActions
                      subject={`la section ${section.label}`}
                      rowKey={key}
                      hidden={hidden}
                      first={index === 0}
                      last={index === drag.orderedItems.length - 1}
                      onMove={(offset) =>
                        void applyLayoutChange((current) => {
                          const order = shift(
                            current.sections.map((candidate) => candidate.id),
                            section.id,
                            offset,
                          );
                          return order ? reorderSections(current, order, section.id) : null;
                        })
                      }
                      onRename={() => setRenaming({ kind: "section", id: section.id, label: section.label })}
                      onHistory={only ? () => setHistory(only) : undefined}
                      toggleLabel={owner ? `Réafficher le module ${moduleName(owner)}` : undefined}
                      onToggle={() => {
                        if (owner) {
                          void applyLayoutChange((current) => setModuleHidden(current, owner.id, false));
                          return;
                        }
                        void applyLayoutChange((current) => setSectionHidden(current, section.id, !hidden));
                        // Réafficher la ligne réaffiche aussi la page seule, si elle avait été masquée à part.
                        if (hidden && only?.hidden)
                          void applyLayoutChange((current) => setPageHidden(current, only.reference, false));
                      }}
                    />
                  </div>
                  {only ? null : (
                    <PageRows place={section.id} pages={section.pages} onRename={setRenaming} onHistory={setHistory} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section
        title="Pages des Réglages"
        description="Les pages de l’espace de travail placées dans les Réglages, après les onglets intégrés."
      >
        <PageRows place={SETTINGS_SECTION} pages={settingsPages} onRename={setRenaming} onHistory={setHistory} />
      </Section>
      {history ? <PageHistoryDialog page={history} onClose={() => setHistory(undefined)} /> : null}
      {renaming ? (
        <RenameDialog
          title={`Renommer ${renaming.kind === "section" ? "la section" : "la page"} « ${renaming.label} »`}
          initial={renaming.label}
          onSubmit={(value) =>
            void applyLayoutChange((current) =>
              renaming.kind === "section"
                ? renameSection(current, renaming.id, value)
                : renamePage(current, renaming.reference, value),
            )
          }
          onClose={() => setRenaming(undefined)}
        />
      ) : null}
    </Page>
  );
}
