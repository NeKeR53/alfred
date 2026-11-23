/**
 * Accueil au premier démarrage, application entière contre le faux backend : bienvenue, espace créé ou ouvert,
 * marketplace passé ou branché avec import, réglages par défaut, résumé ; puis la version courte quand le dernier
 * espace est fermé, et l’accueil relancé depuis les Réglages.
 */
import "./support/dom";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { App } from "../src/App";
import { useHarnesses } from "../src/features/agent/harness/installed";
import { closeOnboarding } from "../src/features/setup/Onboarding";
import { renderWithSocle as render, selectButton } from "../src/features/space/sections.test-helper";
import { useShell } from "../src/shell/store";
import { SUGGESTED_MARKETPLACE } from "../src/shell/welcome/ModulesStep";
import { closeWelcome } from "../src/shell/welcome/store";
import { FakeBackend } from "./support/fakeBackend";
import { findNavigation } from "./support/shell";

beforeEach(() => {
  closeWelcome();
  closeOnboarding();
  useHarnesses.setState({ probes: {} });
  useShell.setState({
    snapshot: undefined,
    recentSpaces: [],
    view: { kind: "agent" },
    activeTab: {},
    startupError: null,
  });
});
afterEach(cleanup);

async function begin() {
  const backend = new FakeBackend().install();
  const user = userEvent.setup();
  render(<App />);
  return { backend, user };
}

async function createSpace(user: ReturnType<typeof userEvent.setup>, name = "Maison") {
  await user.click(await screen.findByRole("button", { name: "Commencer" }));
  await user.type(screen.getByRole("textbox", { name: "Nom de l’espace" }), name);
  await user.click(screen.getByRole("button", { name: "Créer l’espace" }));
  await screen.findByRole("heading", { name: "Vos modules" });
}

it("premier démarrage sans espace : la bienvenue, puis le choix de l’espace, qui ne se passe pas", async () => {
  const { backend, user } = await begin();
  expect(await screen.findByRole("heading", { name: "Bonjour, je suis Alfred" })).toBeVisible();
  // Un seul bouton à la bienvenue, et rien de la coquille.
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Commencer"]);
  expect(screen.queryByRole("treegrid", { name: "Navigation principale" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Commencer" }));

  expect(screen.getByRole("heading", { name: "Votre espace de travail" })).toBeVisible();
  expect(screen.getByText("Étape 1 sur 3")).toBeVisible();
  const cards = screen.getByRole("radiogroup", { name: "Votre espace de travail" });
  expect(
    within(cards)
      .getAllByRole("radio")
      .map((card) => (card as HTMLInputElement).checked),
  ).toEqual([true, false]);
  expect(screen.queryByRole("button", { name: "Plus tard" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Créer l’espace" })).toBeDisabled();
  expect(backend.commandsCalled()).not.toContain("space.open");
  // Retour à la bienvenue.
  await user.click(screen.getByRole("button", { name: "Retour" }));
  expect(screen.getByRole("heading", { name: "Bonjour, je suis Alfred" })).toBeVisible();
});

it("crée un espace dans ~/Alfred/<nom>, et l’accueil continue une fois l’espace ouvert", async () => {
  const { backend, user } = await begin();
  await user.click(await screen.findByRole("button", { name: "Commencer" }));
  const folder = screen.getByRole("textbox", { name: "Dossier" });
  expect(folder).toHaveValue("/Users/lea/Alfred");
  await user.type(screen.getByRole("textbox", { name: "Nom de l’espace" }), "Travail");
  expect(folder).toHaveValue("/Users/lea/Alfred/Travail");
  await user.click(screen.getByRole("button", { name: "Créer l’espace" }));

  expect(await screen.findByRole("heading", { name: "Vos modules" })).toBeVisible();
  expect(backend.lastCall("space.open")).toEqual({ path: "/Users/lea/Alfred/Travail", name: "Travail" });
  // L’espace est ouvert, mais la coquille attend la fin de l’accueil.
  expect(useShell.getState().snapshot?.name).toBe("Travail");
  expect(screen.queryByRole("treegrid", { name: "Navigation principale" })).not.toBeInTheDocument();
});

it("ouvre un espace existant, et dit simplement quand le dossier n’en est pas un", async () => {
  const { backend, user } = await begin();
  backend.spaceFolders.add("/Users/lea/Alfred/Equipe");
  await user.click(await screen.findByRole("button", { name: "Commencer" }));
  await user.click(screen.getByRole("radio", { name: /Ouvrir un espace existant/ }));
  const folder = screen.getByRole("textbox", { name: "Dossier de l’espace" });

  await user.type(folder, "/Users/lea/Documents");
  await user.click(screen.getByRole("button", { name: "Ouvrir l’espace" }));
  expect(await screen.findByText(/Ce dossier n’est pas un espace de travail Alfred/)).toBeVisible();
  expect(useShell.getState().snapshot).toBeNull();

  await user.clear(folder);
  await user.type(folder, "/Users/lea/Alfred/Equipe");
  await user.click(screen.getByRole("button", { name: "Ouvrir l’espace" }));
  expect(await screen.findByRole("heading", { name: "Vos modules" })).toBeVisible();
  expect(backend.lastCall("space.open")).toEqual({ path: "/Users/lea/Alfred/Equipe", existing: true });
});

it("marketplace passé : la suggestion est proposée sans être ajoutée, et « Plus tard » mène aux réglages", async () => {
  const { backend, user } = await begin();
  await createSpace(user);
  const address = screen.getByRole("textbox", { name: "Adresse git du marketplace" });
  expect(address).toHaveValue(SUGGESTED_MARKETPLACE);
  expect(screen.getByText(/C’est une suggestion/)).toBeVisible();
  // Modifiable : on peut la remplacer.
  await user.clear(address);
  await user.type(address, "git@exemple.fr:equipe/modules.git");
  expect(screen.getByText(/L’adresse du dépôt git où votre équipe partage ses modules/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Plus tard" }));
  expect(screen.getByRole("heading", { name: "Quelques réglages" })).toBeVisible();
  expect(backend.commandsCalled()).not.toContain("marketplace.add");

  await user.click(screen.getByRole("button", { name: "Continuer" }));
  expect(screen.getByText("Aucun pour l’instant. Vous en trouverez dans Réglages › Marketplace.")).toBeVisible();
});

it("marketplace ajouté : le catalogue s’affiche, les modules cochés sont importés puis configurés", async () => {
  const { backend, user } = await begin();
  backend.catalogs.set(SUGGESTED_MARKETPLACE, [
    { id: "prefect", name: "Prefect", description: "Suivez vos déploiements." },
    { id: "jira", name: "Jira", description: "Vos tickets." },
    { id: "ancien", name: "Ancien", blocked: "Demande une version plus récente d’Alfred." },
  ]);
  await createSpace(user);
  await user.click(screen.getByRole("button", { name: "Ajouter le marketplace" }));

  const list = await screen.findByRole("list", { name: "Modules proposés" });
  expect(backend.lastCall("marketplace.add")).toEqual({ url: SUGGESTED_MARKETPLACE });
  expect(within(list).getByRole("checkbox", { name: "Ancien" })).toBeDisabled();
  expect(within(list).getByText("Demande une version plus récente d’Alfred.")).toBeVisible();
  // Sans rien cocher, le bouton principal continue simplement.
  expect(screen.getByRole("button", { name: "Continuer" })).toBeEnabled();
  await user.click(within(list).getByRole("checkbox", { name: "Prefect" }));
  await user.click(within(list).getByRole("checkbox", { name: "Jira" }));
  await user.click(screen.getByRole("button", { name: "Importer 2 modules" }));

  expect(await screen.findByRole("heading", { name: "Quelques réglages" })).toBeVisible();
  expect(backend.installed).toEqual(["alfred.place/prefect", "alfred.place/jira"]);
  await user.click(screen.getByRole("button", { name: "Continuer" }));
  expect(screen.getByText("Prefect et Jira sont importés.")).toBeVisible();
  expect(screen.getByText(/je vous guide pour configurer Prefect\. Jira attend dans Réglages › Modules/)).toBeVisible();

  // « Ouvrir Alfred » : la coquille, et l’onboarding du premier module importé.
  await user.click(screen.getByRole("button", { name: "Ouvrir Alfred" }));
  expect(await screen.findByRole("dialog", { name: "Configurer Prefect" })).toBeInTheDocument();
});

it("réglages par défaut : thème du système, accent par défaut, agent détecté, réseau replié, voix plus tard", async () => {
  const { backend, user } = await begin();
  await createSpace(user);
  await user.click(screen.getByRole("button", { name: "Plus tard" }));

  expect(await selectButton("Mode")).toHaveTextContent("Comme l’ordinateur");
  expect(await selectButton("Couleur d’accent")).toHaveTextContent("Par défaut");
  expect(await screen.findAllByText("Installé et connecté")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Réseau d’entreprise (facultatif)" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByText(/vous l’activerez quand vous voudrez, dans Réglages › Voix/)).toBeVisible();
  expect(backend.commandsCalled()).not.toContain("voice.whisper.install");

  // Un choix s’applique tout de suite, et le résumé le reprend.
  await user.click(await selectButton("Mode"));
  await user.click(await screen.findByRole("option", { name: "Sombre" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  await user.click(screen.getByRole("button", { name: "Continuer" }));
  expect(screen.getByText("Thème sombre.")).toBeVisible();
  expect(screen.getByText("Claude Code, Codex et OpenCode, prêts à travailler.")).toBeVisible();
  useShell.getState().setTheme(null);
});

it("sans agent installé : deux lignes et le lien d’installation, sans rien installer", async () => {
  const backend = new FakeBackend();
  backend.agentsInstalled = false;
  backend.install();
  const user = userEvent.setup();
  render(<App />);
  await createSpace(user);
  await user.click(screen.getByRole("button", { name: "Plus tard" }));
  expect(await screen.findByText("Aucun agent n’est installé : Claude Code, Codex ou OpenCode.")).toBeVisible();
  expect(screen.getByRole("button", { name: /Comment l’installer/ })).toBeVisible();
  expect(
    backend.commandsCalled().filter((command) => command.startsWith("agents.") && command !== "agents.probe"),
  ).toEqual([]);
});

it("le dernier espace fermé : la version courte, créer ou ouvrir, avec les espaces récents", async () => {
  const backend = new FakeBackend().withSpace("/Users/lea/Maison", "Maison", []).install();
  const user = userEvent.setup();
  render(<App />);
  // Un espace connu : jamais l’accueil d’office.
  expect(await findNavigation()).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Bonjour, je suis Alfred" })).not.toBeInTheDocument();

  await act(() => useShell.getState().closeSpace());
  expect(await screen.findByRole("heading", { name: "Quel espace ouvrir ?" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Commencer" })).not.toBeInTheDocument();
  const recents = screen.getByRole("list", { name: "Vos espaces récents" });
  expect(within(recents).getByText("Maison")).toBeVisible();
  expect(screen.getByRole("radio", { name: /Créer un nouvel espace/ })).toBeVisible();

  await user.click(within(recents).getByRole("button", { name: "Ouvrir l’espace Maison" }));
  expect(await findNavigation()).toBeInTheDocument();
  expect(backend.lastCall("space.open")).toEqual({ path: "/Users/lea/Maison", existing: true });
});

it("relancé depuis Réglages › Général : garder l’espace ouvert, puis revenir à Alfred", async () => {
  const backend = new FakeBackend().withSpace("/Users/lea/Maison", "Maison", []).install();
  const user = userEvent.setup();
  render(<App />);
  await findNavigation();
  await user.click(screen.getByRole("button", { name: "Réglages" }));
  const settings = await screen.findByRole("dialog", { name: "Réglages" });
  await user.click(await within(settings).findByRole("button", { name: "Revoir l’accueil" }));

  expect(screen.getByRole("heading", { name: "Bonjour, je suis Alfred" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Commencer" }));
  expect(screen.getByRole("radio", { name: /Garder « Maison »/ })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Continuer" }));
  expect(screen.getByRole("heading", { name: "Vos modules" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Fermer l’accueil" }));
  // Retour à Alfred : la coquille revient (les Réglages, d’où l’accueil a été relancé, restent ouverts par-dessus).
  await waitFor(() =>
    expect(screen.getAllByRole("treegrid", { name: "Navigation principale", hidden: true })[0]).toBeInTheDocument(),
  );
  expect(backend.commandsCalled().filter((command) => command === "space.open")).toEqual([]);
});
