/**
 * Harnais des tests d’une rubrique des Réglages décrite par un crochet (`useXxxSections`) : la rubrique seule, dans
 * `SettingsPage` de Socle, sous `SocleProvider`, comme la coquille la dessine dans la modale des Réglages.
 */
import { render } from "@testing-library/react";
import { Settings } from "lucide-react";
import { SettingsPage, type SettingsSection, SocleProvider } from "socle-ui";

function Category({ hook, label }: { hook: () => SettingsSection[]; label: string }) {
  const sections = hook();
  return (
    <SettingsPage
      groups={[{ id: "test", categories: [{ id: "test", label, icon: <Settings size={16} />, sections }] }]}
      selectedId="test"
    />
  );
}

/** `extra` : ce que la coquille monte à côté (l’onboarding, par exemple). */
export function renderSections(hook: () => SettingsSection[], label = "Rubrique", extra?: React.ReactNode) {
  return render(
    <SocleProvider density="desktop">
      <Category hook={hook} label={label} />
      {extra}
    </SocleProvider>,
  );
}

/** `SocleProvider` des tests (dialogues, confirmations, formulaires en modale). */
export function Socle({ children }: { children: React.ReactNode }) {
  return <SocleProvider density="desktop">{children}</SocleProvider>;
}

/** Un composant libre sous `SocleProvider` ; `rerender` garde le fournisseur. */
export function renderWithSocle(node: React.ReactNode) {
  return render(node, { wrapper: Socle });
}
