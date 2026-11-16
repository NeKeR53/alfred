/**
 * Pages d’un module dans sa fiche : un interrupteur par page pour l’afficher ou la masquer du menu. Une section qui
 * n’a qu’une page tient sur une seule ligne.
 */
import { SettingRow, SettingRows, SwitchControl, Text } from "@alfred/ui";
import type { ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
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
  if (groups.length === 0)
    return (
      <Text size="meta" tone="muted">
        Ce module n’a pas de page.
      </Text>
    );

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
      <SettingRow title={page.title} description={description}>
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
        if (!section) return group.pages.map((page) => pageRow(page, disabled, `Onglet dans ${group.place}`));
        // Une section d’une seule page : une seule ligne, qui affiche ou masque la section et sa page ensemble.
        const only = section.pages.length === 1 ? section.pages[0] : undefined;
        if (section.pages.length <= 1)
          return [
            <div key={group.key}>
              <SettingRow title={section.label}>
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
            <SettingRow
              title={section.label}
              description={`Une entrée du menu de gauche, avec ${section.pages.length} onglets.`}
            >
              {toggle(
                section.label,
                !section.hidden,
                disabled,
                (shown) => void applyLayoutChange((current) => setSectionHidden(current, section.id, !shown)),
              )}
            </SettingRow>
          </div>,
          ...section.pages.map((page) => pageRow(page, disabled || section.hidden, "Onglet", true)),
        ];
      })}
    </SettingRows>
  );
}
