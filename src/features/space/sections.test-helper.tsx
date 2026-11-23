/**
 * Pour les tests des rubriques des Réglages : rend les sections d’un crochet `useXxxSections()` dans `SettingsPage`,
 * sous le `SocleProvider` que `tests/setup.ts` pose autour de chaque rendu.
 */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { SettingsPage, type SettingsSection } from "socle-ui";

export function renderSections(useSections: () => SettingsSection[], label = "Rubrique") {
  // biome-ignore lint/correctness/noComponentHookFactories: hôte de test, créé une fois par rendu pour le crochet donné.
  function Host() {
    const sections = useSections();
    return (
      <SettingsPage
        groups={[{ id: "test", categories: [{ id: "test", label, icon: <span />, sections }] }]}
        selectedId="test"
      />
    );
  }
  return renderWithSocle(<Host />);
}

/** `tests/setup.ts` pose déjà `SocleProvider` autour de chaque rendu. */
export function renderWithSocle(node: ReactNode) {
  return render(node);
}

/**
 * Lance l’action d’une ligne de réglage (`item`) : le bouton-icône s’il est visible, sinon l’entrée du menu « … »
 * du groupe « Actions sur {ligne} ».
 */
export async function pressRowAction(
  user: { click: (element: Element) => Promise<void> },
  row: string,
  action: string | RegExp,
) {
  const { screen, within } = await import("@testing-library/react");
  const group = screen.getByRole("group", { name: `Actions sur ${row}` });
  const direct = within(group).queryByRole("button", { name: action });
  if (direct) {
    await user.click(direct);
    return;
  }
  const buttons = within(group).getAllByRole("button");
  await user.click(buttons[buttons.length - 1]);
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

/** Le bouton d’un `Select` de Socle, par son libellé (son nom contient aussi la valeur choisie). */
export async function selectButton(label: string) {
  const { screen } = await import("@testing-library/react");
  const pattern = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return screen.getByRole("button", { name: pattern });
}

/** Choisit une option d’un `Select` de Socle. */
export async function pickOption(
  user: { click: (element: Element) => Promise<void> },
  label: string,
  option: string | RegExp,
) {
  const { screen } = await import("@testing-library/react");
  await user.click(await selectButton(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Libellés des options d’un `Select` de Socle (la liste est ouverte puis refermée). */
export async function optionsOf(
  user: { click: (element: Element) => Promise<void>; keyboard: (keys: string) => Promise<void> },
  label: string,
) {
  const { screen } = await import("@testing-library/react");
  await user.click(await selectButton(label));
  const names = (await screen.findAllByRole("option")).map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return names;
}
