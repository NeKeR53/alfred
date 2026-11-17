/**
 * « Dans le menu », dans la fiche d’un module : ses entrées du menu de gauche en arbre (section, ses onglets, le
 * panneau de droite de chacun), puis ses pages placées ailleurs, Réglages compris. Un interrupteur par ligne affiche
 * ou masque la section ou l’onglet. Une section qui n’a qu’une page tient sur une seule ligne.
 */
import { SettingRow, SettingRows, SwitchControl } from "@alfred/ui";
import { Boxes } from "lucide-react";
import type { ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
import { NamedIcon, SectionIcon } from "../../shell/icons";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { setPageHidden, setSectionHidden } from "../../shell/navigationLayout";

interface Group {
  key: string;
  /** Section dont le module est propriétaire : son interrupteur masque toute la section. */
  section?: ResolvedSection;
  /** Libellé de l’endroit où vivent les pages quand la section appartient à un autre module. */
  place?: string;
  pages: ResolvedPage[];
}

/** Pages du module, rangées par section, Réglages compris. */
export function moduleGroups(snapshot: Snapshot, module: string): Group[] {
  const groups: Group[] = [];
  for (const section of snapshot.sections) {
    const pages = section.pages.filter((page) => page.module === module);
    if (section.module === module) groups.push({ key: section.id, section, pages: section.pages });
    else if (pages.length > 0) groups.push({ key: section.id, place: section.label, pages });
  }
  const settings = snapshot.settingsPages.filter((page) => page.module === module);
  if (settings.length > 0) groups.push({ key: "réglages", place: "Réglages", pages: settings });
  return groups;
}

/** Toutes les pages du module, panneaux compris, une fois chacune (les copies d’une section par compte comptent une fois). */
function modulePagesFlat(snapshot: Snapshot, module: string): ResolvedPage[] {
  const pages = [...snapshot.sections.flatMap((section) => section.pages), ...snapshot.settingsPages].flatMap((page) =>
    page.panel ? [page, page.panel] : [page],
  );
  const seen = new Set<string>();
  return pages.filter((page) => {
    if (page.module !== module || seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}

/** Titres des pages du module qui passent par un service (`uses.clients`), pour dire à quoi il sert. */
export function pagesUsing(snapshot: Snapshot, module: string, need: string): string[] {
  return [
    ...new Set(
      modulePagesFlat(snapshot, module)
        .filter((page) => page.uses.clients?.includes(need))
        .map((page) => page.title),
    ),
  ];
}

/** « A », « A et B », « A, B et C ». */
export function listing(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items.at(-1)}`;
}

/** Entrée du menu de gauche, telle qu’elle y apparaît : son icône dans sa couleur, puis son nom. */
function SectionTitle({ section }: { section: ResolvedSection }) {
  return (
    <span className={`module-entry module-entry--section product-color--${section.color ?? "steel"}`}>
      <span className="module-entry__icon" aria-hidden="true">
        {section.icon ? <SectionIcon section={section} size={16} /> : <Boxes size={16} />}
      </span>
      {section.label}
    </span>
  );
}

/** Onglet d’une entrée : son icône, discrète, puis son titre. */
function PageTitle({ page }: { page: ResolvedPage }) {
  return (
    <span className="module-entry module-entry--tab">
      {page.icon ? (
        <span className="module-entry__icon" aria-hidden="true">
          <NamedIcon name={page.icon} size={14} />
        </span>
      ) : null}
      {page.title}
    </span>
  );
}

/** « avec le panneau « Email » à droite », pour une page qui en a un. */
function panelNote(page: ResolvedPage | undefined): string | undefined {
  return page?.panel ? `Avec le panneau « ${page.panel.title} » à droite.` : undefined;
}

export function ModulePages({
  snapshot,
  module,
  disabled,
}: {
  snapshot: Snapshot;
  module: string;
  /** Module désactivé : ses pages ne s’affichent pas, quel que soit leur interrupteur. */
  disabled: boolean;
}) {
  const groups = moduleGroups(snapshot, module);
  if (groups.length === 0) return null;

  /** Interrupteur à droite d’une ligne : le titre de la ligne est son libellé. */
  const toggle = (label: string, checked: boolean, off: boolean, onChange: (shown: boolean) => void) => (
    <SwitchControl
      label=""
      aria-label={`Afficher ${label} dans le menu`}
      checked={checked}
      disabled={off}
      onChange={(event) => onChange(event.target.checked)}
    />
  );

  const pageRow = (page: ResolvedPage, off: boolean, description?: string, nested = false) => (
    <div key={page.reference} className={nested ? "setting-row--nested" : undefined}>
      <SettingRow title={<PageTitle page={page} />} description={description}>
        {toggle(
          page.title,
          !page.hidden,
          off,
          (shown) => void applyLayoutChange((current) => setPageHidden(current, page.reference, !shown)),
        )}
      </SettingRow>
    </div>
  );

  return (
    <SettingRows label="Pages du module">
      {groups.flatMap((group) => {
        const { section } = group;
        if (!section)
          return group.pages.map((page) =>
            pageRow(
              page,
              disabled,
              [group.place === "Réglages" ? "Dans les Réglages." : `Onglet dans « ${group.place} ».`, panelNote(page)]
                .filter(Boolean)
                .join(" "),
            ),
          );
        // Une section d’une seule page : une seule ligne, qui affiche ou masque la section et sa page ensemble.
        const only = section.pages.length === 1 ? section.pages[0] : undefined;
        if (section.pages.length <= 1)
          return [
            <div key={group.key}>
              <SettingRow
                title={<SectionTitle section={section} />}
                description={
                  only
                    ? [only.title !== section.label ? `Page « ${only.title} ».` : null, panelNote(only)]
                        .filter(Boolean)
                        .join(" ") || undefined
                    : (section.waiting ?? undefined)
                }
              >
                {toggle(section.label, !section.hidden && !only?.hidden, disabled, (shown) => {
                  void applyLayoutChange((current) => setSectionHidden(current, section.id, !shown));
                  if (shown && only?.hidden)
                    void applyLayoutChange((current) => setPageHidden(current, only.reference, false));
                })}
              </SettingRow>
            </div>,
          ];
        return [
          <div key={group.key}>
            <SettingRow title={<SectionTitle section={section} />} description={`${section.pages.length} onglets`}>
              {toggle(
                section.label,
                !section.hidden,
                disabled,
                (shown) => void applyLayoutChange((current) => setSectionHidden(current, section.id, !shown)),
              )}
            </SettingRow>
          </div>,
          ...section.pages.map((page) => pageRow(page, disabled || section.hidden, panelNote(page), true)),
        ];
      })}
    </SettingRows>
  );
}
