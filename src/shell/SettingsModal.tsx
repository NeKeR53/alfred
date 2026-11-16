/**
 * Fenêtre des Réglages, posée par-dessus l’app : une barre latérale (recherche, rubriques de l’espace de travail
 * puis d’Alfred, groupées avec leur icône, pages de l’espace de travail placées dans les Réglages) et la rubrique choisie à droite. Échap ou la croix la ferment.
 *
 * Ce n’est pas un `<dialog>` natif : ses menus déroulants (rendus dans `body`) et les notifications doivent
 * passer au-dessus d’elle, et ses propres modales natives s’ouvrent par-dessus dans la couche supérieure.
 */
import { EmptyState, IconButton, SearchField } from "@alfred/ui";
import { FileText, X } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { ResolvedPage } from "../lib/types";
import type { BuiltInTab } from "./AppShell";
import type { MenuAnchor } from "./navigationEditing";
import { SETTINGS_SECTION } from "./navigationLayout";
import { PageFrame } from "./PageFrame";
import { useShell } from "./store";

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

interface Entry {
  id: string;
  label: string;
  group: string;
  groupTitle?: string;
  icon: React.ReactNode;
}

const SPACE_PAGES = "Pages de l’espace de travail";

export function SettingsModal({
  tabs,
  pages,
  onPageMenu,
  onClose,
}: {
  tabs: BuiltInTab[];
  /** Pages de l’espace de travail placées dans les Réglages. */
  pages: ResolvedPage[];
  onPageMenu?: (reference: string, anchor: MenuAnchor, returnFocus: HTMLElement | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const active = useShell((state) => state.activeTab[SETTINGS_SECTION]);
  const setActiveTab = useShell((state) => state.setActiveTab);

  const visiblePages = pages.filter((page) => !page.hidden);
  const entries: Entry[] = [
    ...tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      group: tab.group ?? "",
      groupTitle: tab.groupTitle,
      icon: tab.icon,
    })),
    ...visiblePages.map((page) => ({
      id: page.reference,
      label: page.title,
      group: SPACE_PAGES,
      icon: <FileText size={16} aria-hidden="true" />,
    })),
  ];
  const currentId = entries.some((entry) => entry.id === active) ? active : entries[0]?.id;
  const builtIn = tabs.find((tab) => tab.id === currentId);
  const page = visiblePages.find((candidate) => candidate.reference === currentId);
  const current = entries.find((entry) => entry.id === currentId);

  const folded = fold(query.trim());
  const shown = entries.filter((entry) => !folded || fold(entry.label).includes(folded));
  const groups = shown.reduce<Array<{ name: string; title?: string; entries: Entry[] }>>((all, entry) => {
    const last = all[all.length - 1];
    if (last && last.name === entry.group) last.entries.push(entry);
    else all.push({ name: entry.group, entries: [entry] });
    return all;
  }, []);
  // Le titre d’un groupe suit le groupe, même quand la recherche en masque la première entrée.
  const titles = new Map(entries.filter((entry) => entry.groupTitle).map((entry) => [entry.group, entry.groupTitle]));
  titles.set(SPACE_PAGES, SPACE_PAGES);
  let lastTitle: string | undefined;
  for (const group of groups) {
    const title = titles.get(group.name);
    if (title && title !== lastTitle) group.title = title;
    if (title) lastTitle = title;
  }

  // Le focus entre dans la fenêtre à l’ouverture et revient au déclencheur à la fermeture.
  useEffect(() => {
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    return () => {
      const target = invoker.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  // Échap ferme la fenêtre, même quand le focus est retombé sur la page ; une modale ou un menu ouverts dans les
  // Réglages se ferment d’abord.
  const closeLatest = useRef(onClose);
  closeLatest.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open], [role='menu'], [role='listbox']")) return;
      event.preventDefault();
      closeLatest.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: le fond ferme la fenêtre au clic, comme une modale.
    <div
      className="settings-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panel} className="settings-modal__panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-modal__header">
          <h1 id={titleId}>Réglages</h1>
          <IconButton label="Fermer les Réglages" tooltip="Fermer" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="settings-modal__layout">
          <nav className="settings-modal__nav" aria-label="Rubriques des Réglages">
            <SearchField
              label="Rechercher un réglage"
              placeholder="Rechercher"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {groups.length === 0 ? <p className="settings-modal__empty">Aucune rubrique trouvée.</p> : null}
            {groups.map((group, index) => (
              <Fragment key={group.entries[0]?.id}>
                {index > 0 ? <hr className="settings-modal__separator" /> : null}
                {group.title ? <p className="settings-modal__group">{group.title}</p> : null}
                <ul className="settings-modal__list">
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="settings-modal__item"
                        aria-current={entry.id === currentId ? "page" : undefined}
                        onClick={() => setActiveTab(SETTINGS_SECTION, entry.id)}
                        onContextMenu={
                          entry.group === SPACE_PAGES && onPageMenu
                            ? (event) => {
                                event.preventDefault();
                                onPageMenu(entry.id, { x: event.clientX, y: event.clientY }, event.currentTarget);
                              }
                            : undefined
                        }
                      >
                        <span className="settings-modal__icon">{entry.icon}</span>
                        {entry.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </Fragment>
            ))}
          </nav>
          <section
            className="settings-modal__content shell-body--settings"
            data-surface="settings"
            aria-label={current?.label ?? "Réglages"}
          >
            {builtIn ? (
              <Fragment key={builtIn.id}>{builtIn.render()}</Fragment>
            ) : page ? (
              page.missing ? (
                <EmptyState title="Page en cours de création" description="Je n’ai pas encore écrit son contenu." />
              ) : (
                <PageFrame key={page.reference} page={page} kind="page" />
              )
            ) : (
              <EmptyState title="Aucune rubrique" />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
