/**
 * Onglet « Navigation » des Réglages : les modules affichés, puis toutes les sections et pages, masquées
 * comprises, avec de quoi les réafficher, les renommer et les réordonner sans glisser-déposer.
 */
import { EmptyState, IconButton, Page, Section, StatusBadge, Text } from "@alfred/ui";
import { ArrowDown, ArrowUp, Eye, EyeOff, History, Pencil } from "lucide-react";
import { useState } from "react";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { NamedIcon } from "../../shell/icons";
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
import { PageHistoryDialog } from "./PageHistory";
import "./navigation.css";

/** Module masqué qui emporte cette ligne : son bouton réaffiche le module plutôt que la ligne seule. */
function hiddenModuleOf(snapshot: Snapshot, module: string): ModuleSummary | undefined {
  return isModuleHidden(snapshot, module) ? snapshot.modules.find((candidate) => candidate.id === module) : undefined;
}

const moduleName = (module: ModuleSummary) => module.name || module.id;

type Renaming = { kind: "section"; id: string; label: string } | { kind: "page"; reference: string; label: string };

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
  if (pages.length === 0)
    return (
      <Text size="meta" tone="muted">
        Aucune page.
      </Text>
    );
  return (
    <ul className="nav-settings__list nav-settings__list--pages">
      {pages.map((page, index) => {
        const key = `page:${page.reference}`;
        const owner = snapshot ? hiddenModuleOf(snapshot, page.module) : undefined;
        return (
          <li key={page.reference} className="nav-settings__row" data-nav-row={key}>
            <span className="nav-settings__name">
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
              last={index === pages.length - 1}
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
  if (!snapshot) return null;
  const { sections, settingsPages, modules } = snapshot;
  const nameOf = (id: string) => {
    const module = modules.find((candidate) => candidate.id === id);
    return module ? moduleName(module) : id;
  };

  return (
    <Page width="text">
      <Section
        title="Modules"
        description="Un module masqué quitte le menu avec toutes ses sections et ses pages ; ses fonctions et ses clients servent toujours aux modules qui en dépendent."
      >
        {modules.length === 0 ? (
          <Text size="meta" tone="muted">
            Aucun module.
          </Text>
        ) : (
          <ul className="nav-settings__list">
            {modules.map((module) => {
              const key = `module:${module.id}`;
              const hidden = isModuleHidden(snapshot, module.id);
              const name = moduleName(module);
              return (
                <li key={module.id} className="nav-settings__row" data-nav-row={key}>
                  <span className="nav-settings__name">
                    <Text as="span" weight="medium" tone={hidden ? "muted" : "default"}>
                      {name}
                    </Text>
                    {hidden ? <StatusBadge size="compact">Masqué</StatusBadge> : null}
                    {module.requiredBy.length > 0 ? (
                      <Text as="span" size="meta" tone="muted">
                        utilisé par {module.requiredBy.map(nameOf).join(", ")}
                      </Text>
                    ) : null}
                  </span>
                  <span className="nav-settings__actions">
                    <IconButton
                      size="small"
                      label={`${hidden ? "Réafficher" : "Masquer"} le module ${name}`}
                      tooltip={hidden ? "Réafficher" : "Masquer"}
                      data-nav-action="toggle"
                      onClick={() => {
                        void applyLayoutChange((current) => setModuleHidden(current, module.id, !hidden));
                        refocus(key, "toggle");
                      }}
                    >
                      {hidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
                    </IconButton>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section
        title="Menu"
        description="Les sections du menu de gauche et leurs onglets, masqués compris. Le menu se réorganise aussi par glisser-déposer, Alt+Flèche ou clic droit."
      >
        {sections.length === 0 ? (
          <EmptyState title="Aucune section" description="Demander à l’agent de créer une page." size="compact" />
        ) : (
          <ul className="nav-settings__list">
            {sections.map((section, index) => {
              const key = `section:${section.id}`;
              const owner = hiddenModuleOf(snapshot, section.module);
              return (
                <li key={section.id} className="nav-settings__section">
                  <div className="nav-settings__row" data-nav-row={key}>
                    <span className={`nav-settings__name product-color--${section.color ?? "steel"}`}>
                      <span className="nav-settings__icon">
                        <NamedIcon name={section.icon} />
                      </span>
                      <Text as="span" weight="medium" tone={section.hidden ? "muted" : "default"}>
                        {section.label}
                      </Text>
                      {owner ? (
                        <StatusBadge size="compact">Module {moduleName(owner)} masqué</StatusBadge>
                      ) : section.hidden ? (
                        <StatusBadge size="compact">Masquée</StatusBadge>
                      ) : null}
                    </span>
                    <RowActions
                      subject={`la section ${section.label}`}
                      rowKey={key}
                      hidden={section.hidden}
                      first={index === 0}
                      last={index === sections.length - 1}
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
                      toggleLabel={owner ? `Réafficher le module ${moduleName(owner)}` : undefined}
                      onToggle={() =>
                        void applyLayoutChange((current) =>
                          owner
                            ? setModuleHidden(current, owner.id, false)
                            : setSectionHidden(current, section.id, !section.hidden),
                        )
                      }
                    />
                  </div>
                  <PageRows place={section.id} pages={section.pages} onRename={setRenaming} onHistory={setHistory} />
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section
        title="Pages des Réglages"
        description="Les pages de l’espace placées dans les Réglages, après les onglets intégrés."
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
