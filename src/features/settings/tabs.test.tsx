import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { SettingsModal } from "../../shell/SettingsModal";
import { useShell } from "../../shell/store";
import { MODULE_FOCUS, openModuleSettings, openSettings } from "./open";
import { settingsTabs } from "./tabs";

// Chaque rubrique affiche son seul nom : le test porte sur l’ordre et le choix de la rubrique, pas sur leur contenu.
const tabs = settingsTabs.map((tab) => ({ ...tab, useSections: undefined, render: () => <p>Rubrique {tab.label}</p> }));

beforeEach(() => {
  useShell.setState({ view: { kind: "agent" }, activeTab: {} });
});

it("range Général en tête de l’espace de travail, puis Modules, Marketplace, Apparence, Ordre du menu, Automatisations et Journal", () => {
  expect(settingsTabs.map((tab) => tab.label)).toEqual([
    "Général",
    "Modules",
    "Marketplace",
    "Apparence",
    "Ordre du menu",
    "Automatisations",
    "Journal",
    "Agent",
    "Voix",
    "Mots de passe et clés",
  ]);
  expect(settingsTabs[0]).toMatchObject({ id: "space", groupTitle: "Espace de travail" });
});

it("s’ouvre sur Général quand aucune rubrique n’est demandée", () => {
  render(<SettingsModal tabs={tabs} pages={[]} onClose={() => {}} />);
  expect(screen.getByText("Rubrique Général")).toBeInTheDocument();
  expect(screen.queryByText("Rubrique Modules")).not.toBeInTheDocument();
});

it("ouvre la rubrique demandée, et la fiche d’un module dans Modules", () => {
  openSettings("appearance");
  const { unmount } = render(<SettingsModal tabs={tabs} pages={[]} onClose={() => {}} />);
  expect(screen.getByText("Rubrique Apparence")).toBeInTheDocument();
  unmount();

  openModuleSettings("crm");
  render(<SettingsModal tabs={tabs} pages={[]} onClose={() => {}} />);
  expect(screen.getByText("Rubrique Modules")).toBeInTheDocument();
  expect(useShell.getState().activeTab[MODULE_FOCUS]).toBe("crm");
});
