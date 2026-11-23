/**
 * « Ordre du menu » : toutes les sections et pages, masquées comprises, avec de quoi les réafficher, les renommer et
 * les réordonner. Décrit par données pour `SettingsPage` de Socle : une ligne par section, puis les onglets de chaque
 * section qui en a plusieurs, puis les pages placées dans les Réglages.
 */
import { ArrowDown, ArrowUp, Eye, EyeOff, History, Pencil } from "lucide-react";
import { useState } from "react";
import { type Action, type ItemSetting, type SettingsSection, type SettingTag, useOpenForm } from "socle-ui";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { applyLayoutChange } from "../../shell/navigationEditing";
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

const icon = (Icon: typeof Eye) => <Icon size={16} aria-hidden="true" />;

/** Module masqué qui emporte cette ligne : son action réaffiche le module plutôt que la ligne seule. */
function hiddenModuleOf(snapshot: Snapshot, module: string): ModuleSummary | undefined {
  return isModuleHidden(snapshot, module) ? snapshot.modules.find((candidate) => candidate.id === module) : undefined;
}

const moduleName = (module: ModuleSummary) => module.name || module.id;

/** Étiquettes d’une ligne : masquée (par elle-même ou par son module), en lecture seule. */
function tagsOf(owner: ModuleSummary | undefined, hidden: boolean, readOnly: boolean | undefined): SettingTag[] {
  return [
    ...(owner
      ? [{ label: `Module ${moduleName(owner)} masqué`, tone: "neutral" as const }]
      : hidden
        ? [{ label: "Masquée", tone: "neutral" as const }]
        : []),
    ...(readOnly ? [{ label: "Lecture seule", tone: "neutral" as const }] : []),
  ];
}

/** Actions d’une ligne : l’affichage d’abord (l’icône visible), puis monter, descendre, renommer, l’historique. */
function rowActions({
  subject,
  hidden,
  first,
  last,
  owner,
  onMove,
  onRename,
  onToggle,
  onHistory,
}: {
  subject: string;
  hidden: boolean;
  first: boolean;
  last: boolean;
  owner: ModuleSummary | undefined;
  onMove: (offset: -1 | 1) => void;
  onRename: () => void;
  onToggle: () => void;
  onHistory?: () => void;
}): Action[] {
  return [
    {
      id: "toggle",
      label: owner ? `Réafficher le module ${moduleName(owner)}` : `${hidden ? "Réafficher" : "Masquer"} ${subject}`,
      icon: icon(hidden ? Eye : EyeOff),
      onPress: onToggle,
    },
    { id: "up", label: `Monter ${subject}`, icon: icon(ArrowUp), isDisabled: first, onPress: () => onMove(-1) },
    { id: "down", label: `Descendre ${subject}`, icon: icon(ArrowDown), isDisabled: last, onPress: () => onMove(1) },
    { id: "rename", label: `Renommer ${subject}`, icon: icon(Pencil), onPress: onRename },
    ...(onHistory ? [{ id: "history", label: `Historique de ${subject}`, icon: icon(History), onPress: onHistory }] : []),
  ];
}

function pageRows(
  snapshot: Snapshot,
  place: string,
  pages: ResolvedPage[],
  rename: (page: ResolvedPage) => void,
  history: (page: ResolvedPage) => void,
): ItemSetting[] {
  return pages.map((page, index) => {
    const owner = hiddenModuleOf(snapshot, page.module);
    return {
      id: `page:${page.reference}`,
      type: "item",
      label: page.title,
      tags: tagsOf(owner, page.hidden, page.readOnly),
      actions: rowActions({
        subject: `la page ${page.title}`,
        hidden: page.hidden || Boolean(owner),
        first: index === 0,
        last: index === pages.length - 1,
        owner,
        onMove: (offset) =>
          void applyLayoutChange((current) => {
            const order = shift(
              pagesOf(current, place).map((candidate) => candidate.reference),
              page.reference,
              offset,
            );
            return order ? reorderTabs(current, place, order, page.reference) : null;
          }),
        onRename: () => rename(page),
        onHistory: () => history(page),
        onToggle: () =>
          void applyLayoutChange((current) =>
            owner ? setModuleHidden(current, owner.id, false) : setPageHidden(current, page.reference, !page.hidden),
          ),
      }),
    };
  });
}

export function useNavigationSections(): SettingsSection[] {
  const snapshot = useShell((state) => state.snapshot);
  const openForm = useOpenForm();
  const [history, setHistory] = useState<ResolvedPage>();
  if (!snapshot) return [];
  const { sections, settingsPages } = snapshot;

  const rename = (kind: "section" | "page", id: string, label: string) =>
    void openForm({
      title: `Renommer ${kind === "section" ? "la section" : "la page"} « ${label} »`,
      submitLabel: "Renommer",
      initialValues: { name: label },
      fields: [{ name: "name", label: "Nom", isRequired: true, autoComplete: "off" }],
    }).then((values) => {
      const name = String(values?.name ?? "").trim();
      if (!values || !name || name === label) return;
      void applyLayoutChange((current) =>
        kind === "section" ? renameSection(current, id, name) : renamePage(current, id, name),
      );
    });
  const renamePageOf = (page: ResolvedPage) => rename("page", page.reference, page.title);

  const sectionRows: ItemSetting[] = sections.map((section, index) => {
    const owner = hiddenModuleOf(snapshot, section.module);
    // Une section d’une seule page tient sur une ligne : la section et sa page s’affichent ensemble.
    const only = section.pages.length === 1 ? section.pages[0] : undefined;
    const hidden = section.hidden || Boolean(only?.hidden);
    return {
      id: `section:${section.id}`,
      type: "item",
      label: section.label,
      description: only ? undefined : `${section.pages.length} onglets`,
      tags: tagsOf(owner, hidden, only?.readOnly),
      actions: rowActions({
        subject: `la section ${section.label}`,
        hidden: hidden || Boolean(owner),
        first: index === 0,
        last: index === sections.length - 1,
        owner,
        onMove: (offset) =>
          void applyLayoutChange((current) => {
            const order = shift(
              current.sections.map((candidate) => candidate.id),
              section.id,
              offset,
            );
            return order ? reorderSections(current, order, section.id) : null;
          }),
        onRename: () => rename("section", section.id, section.label),
        onHistory: only ? () => setHistory(only) : undefined,
        onToggle: () => {
          if (owner) {
            void applyLayoutChange((current) => setModuleHidden(current, owner.id, false));
            return;
          }
          void applyLayoutChange((current) => setSectionHidden(current, section.id, !hidden));
          // Réafficher la ligne réaffiche aussi la page seule, si elle avait été masquée à part.
          if (hidden && only?.hidden) void applyLayoutChange((current) => setPageHidden(current, only.reference, false));
        },
      }),
    };
  });

  return [
    {
      id: "sections",
      title: "Sections du menu",
      description:
        "L’ordre et le nom des sections du menu de gauche. Les pages s’activent depuis la fiche de leur module (rubrique Modules).",
      settings: sectionRows,
      emptyMessage: "Aucune section. Demandez à l’agent de créer une page.",
      content: history ? <PageHistoryDialog page={history} onClose={() => setHistory(undefined)} /> : undefined,
    },
    ...sections
      .filter((section) => section.pages.length > 1)
      .map((section) => ({
        id: `tabs:${section.id}`,
        title: `Onglets de « ${section.label} »`,
        settings: pageRows(snapshot, section.id, section.pages, renamePageOf, setHistory),
      })),
    {
      id: "settings-pages",
      title: "Pages des Réglages",
      description: "Les pages de l’espace de travail placées dans les Réglages, après les rubriques intégrées.",
      settings: pageRows(snapshot, SETTINGS_SECTION, settingsPages, renamePageOf, setHistory),
      emptyMessage: "Aucune page.",
    },
  ];
}
