/**
 * Réglages d’Alfred : `SettingsPage` de Socle dans un `Dialog` `xl` (D-015). Les rubriques intégrées viennent de
 * `settingsTabs` ; les pages de l’espace de travail placées dans les Réglages suivent, dans leur propre groupe, et
 * s’affichent dans le contenu libre de leur rubrique.
 *
 * Une rubrique décrit ses sections par un crochet (`useSections`) : seul celui de la rubrique ouverte tourne, dans
 * un hôte remonté à chaque changement de rubrique. Les autres rubriques gardent leur libellé et leurs mots-clés pour
 * la recherche de la navigation.
 */
import { FileText } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
  Dialog,
  EmptyState,
  type SettingsCategory,
  type SettingsGroup,
  SettingsPage,
  type SettingsSection,
} from "socle-ui";
import type { ResolvedPage } from "../lib/types";
import { SETTINGS_SECTION } from "./navigationLayout";
import { PageFrame } from "./PageFrame";
import { useShell } from "./store";
import type { BuiltInTab } from "./types";

const SPACE_PAGES = "pages";

/** Une rubrique sans `useSections` : son rendu libre, en une seule section sans titre. */
const fallbackSections = (id: string, content: ReactNode): SettingsSection[] => [{ id, content }];

function useNoSections(): SettingsSection[] {
  return [];
}

function spacePageContent(page: ResolvedPage) {
  return page.missing ? (
    <EmptyState title="Page en cours de création" description="Je n’ai pas encore écrit son contenu." />
  ) : (
    <PageFrame key={page.reference} page={page} kind="page" />
  );
}

/** Groupes de la navigation : chaque rubrique sans ses sections ; celles de la rubrique ouverte sont ajoutées. */
function buildGroups(tabs: BuiltInTab[], pages: ResolvedPage[]): SettingsGroup[] {
  const groups: SettingsGroup[] = [];
  for (const tab of tabs) {
    const category: SettingsCategory = {
      id: tab.id,
      label: tab.label,
      icon: tab.icon ?? <FileText size={16} aria-hidden="true" />,
      keywords: tab.keywords,
      sections: [],
    };
    const name = tab.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.id === name) last.categories.push(category);
    else groups.push({ id: name, title: tab.groupTitle, categories: [category] });
  }
  if (pages.length) {
    groups.push({
      id: SPACE_PAGES,
      title: "Pages de l’espace de travail",
      categories: pages.map((page) => ({
        id: page.reference,
        label: page.title,
        icon: <FileText size={16} aria-hidden="true" />,
        sections: [],
      })),
    });
  }
  return groups;
}

/** Hôte de la rubrique ouverte : il appelle son crochet et dessine le gabarit avec ses sections. */
function SettingsHost({
  groups,
  selectedId,
  tab,
  page,
  onSelect,
}: {
  groups: SettingsGroup[];
  selectedId: string;
  tab: BuiltInTab | undefined;
  page: ResolvedPage | undefined;
  onSelect: (id: string) => void;
}) {
  const useTabSections = tab?.useSections ?? useNoSections;
  const described = useTabSections();
  const sections: SettingsSection[] = tab
    ? tab.useSections
      ? described
      : fallbackSections(tab.id, tab.render?.())
    : page
      ? fallbackSections(page.reference, spacePageContent(page))
      : [];
  const filled = groups.map((group) => ({
    ...group,
    categories: group.categories.map((category) => (category.id === selectedId ? { ...category, sections } : category)),
  }));
  return <SettingsPage groups={filled} selectedId={selectedId} onSelectionChange={onSelect} />;
}

export function SettingsModal({
  tabs,
  pages,
  onClose,
}: {
  tabs: BuiltInTab[];
  /** Pages de l’espace de travail placées dans les Réglages. */
  pages: ResolvedPage[];
  onClose: () => void;
}) {
  const active = useShell((state) => state.activeTab[SETTINGS_SECTION]);
  const setActiveTab = useShell((state) => state.setActiveTab);
  const visiblePages = useMemo(() => pages.filter((page) => !page.hidden), [pages]);
  const groups = useMemo(() => buildGroups(tabs, visiblePages), [tabs, visiblePages]);
  const ids = groups.flatMap((group) => group.categories.map((category) => category.id));
  const selectedId = active && ids.includes(active) ? active : (ids[0] ?? "");
  const tab = tabs.find((candidate) => candidate.id === selectedId);
  const page = visiblePages.find((candidate) => candidate.reference === selectedId);

  return (
    <Dialog
      isOpen
      size="xl"
      title="Réglages"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SettingsHost
        key={selectedId}
        groups={groups}
        selectedId={selectedId}
        tab={tab}
        page={page}
        onSelect={(id) => setActiveTab(SETTINGS_SECTION, id)}
      />
    </Dialog>
  );
}
