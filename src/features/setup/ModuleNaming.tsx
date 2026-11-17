/**
 * Étape « Vos pages » de l’onboarding : chaque entrée que le module ajoute au menu de gauche, avec ses onglets et les
 * services dont chacun a besoin. L’utilisateur les nomme comme il veut ; le nom est enregistré dès qu’il quitte le
 * champ (ou appuie sur Entrée), dans la navigation de l’espace de travail, sans toucher au module.
 */
import { FormField, Text, TextInput } from "@alfred/ui";
import { useEffect, useState } from "react";
import type { ModuleSummary, ResolvedPage, ResolvedSection } from "../../lib/types";
import { NamedIcon } from "../../shell/icons";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { renamePage, renameSection } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";

/** Champ de nom enregistré en quittant le champ ; vide, il reprend le nom actuel. */
function NameField({ label, value, onSave }: { label: string; value: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const name = draft.trim();
    if (!name) setDraft(value);
    else if (name !== value) onSave(name);
  };
  return (
    <FormField label={label}>
      <TextInput
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </FormField>
  );
}

/** Services dont une page a besoin, en mots : leurs noms tels que le module les déclare. */
function servicesOf(page: ResolvedPage, module: ModuleSummary | undefined): string[] {
  return (page.uses?.clients ?? []).map((need) => {
    const local = need.includes("/") ? undefined : module?.clients.find((client) => client.id === need);
    return local?.label || need;
  });
}

/** Sections du module dans le menu ; une section par compte n’apparaît qu’une fois, sous son nom de base. */
export function moduleSections(sections: ResolvedSection[], module: string): ResolvedSection[] {
  return sections.filter((section) => section.module === module);
}

export function ModuleNaming({ module }: { module: ModuleSummary }) {
  const snapshot = useShell((state) => state.snapshot);
  const sections = snapshot ? moduleSections(snapshot.sections, module.id) : [];
  const perAccount = sections.some((section) => section.instance || section.perInstance);

  return (
    <div className="setup-flow__body">
      <h3>Vos pages</h3>
      <Text>
        {sections.length > 1
          ? `${module.name} ajoute ${sections.length} entrées au menu de gauche. Donnez-leur le nom qui vous parle : vous pourrez le changer plus tard.`
          : `${module.name} ajoute une entrée au menu de gauche. Donnez-lui le nom qui vous parle : vous pourrez le changer plus tard.`}
      </Text>
      {perAccount ? (
        <Text tone="muted">
          Une entrée apparaît pour chaque compte que vous connecterez : elle porte le nom du compte.
        </Text>
      ) : null}
      <ul className="onboarding-pages" aria-label="Pages du module dans le menu">
        {sections.map((section) => (
          <li key={section.id} className="onboarding-pages__section">
            <div className="onboarding-pages__head">
              <span className={`module-row__icon product-color--${section.color ?? "steel"}`} aria-hidden="true">
                <NamedIcon name={section.icon ?? "box"} size={15} />
              </span>
              <NameField
                label="Nom dans le menu"
                value={section.label}
                onSave={(label) => void applyLayoutChange((current) => renameSection(current, section.id, label))}
              />
            </div>
            {section.waiting ? (
              <Text size="meta" tone="muted">
                {section.waiting}
              </Text>
            ) : null}
            {section.pages.length > 0 ? (
              <ul className="onboarding-pages__tabs">
                {section.pages.map((page) => {
                  const needs = servicesOf(page, module);
                  return (
                    <li key={page.reference}>
                      {section.pages.length > 1 ? (
                        <NameField
                          label="Nom de l’onglet"
                          value={page.title}
                          onSave={(label) =>
                            void applyLayoutChange((current) => renamePage(current, page.reference, label))
                          }
                        />
                      ) : null}
                      <Text size="meta" tone="muted">
                        {section.pages.length > 1 ? "" : `Page « ${page.title} » · `}
                        {needs.length > 0 ? `utilise ${needs.join(", ")}` : "n’a besoin d’aucun service"}
                      </Text>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
