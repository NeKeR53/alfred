/**
 * Parcours de la coquille, application entière contre le faux backend : accueil et ouverture d’un espace, navigation
 * entre la page Agent, une section à plusieurs onglets, son panneau et les dix onglets des Réglages, palette de
 * commandes, demande d’accord d’accès.
 */
import "./support/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { FakeBackend, frameKeyOf } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";

it("de l’accueil à un espace de travail construit : navigation, Réglages, palette et accord d’accès", async () => {
  const backend = new FakeBackend().install();
  const user = userEvent.setup();
  render(<App />);

  // Accueil : aucun espace mémorisé, le dossier proposé est dans le dossier personnel.
  expect(await screen.findByRole("heading", { name: "Bonjour, je suis Alfred" })).toBeVisible();
  const folder = screen.getByRole("textbox", { name: "Dossier de l’espace de travail" });
  expect(folder).toHaveValue("/Users/lea/Alfred");
  await user.clear(folder);
  await user.type(folder, "/Users/lea/Maison");
  await user.click(screen.getByRole("button", { name: "Ouvrir l’espace de travail" }));

  // Espace ouvert, encore vide : la page Agent invite à construire.
  expect(await screen.findByText("Que puis-je faire pour vous ?")).toBeVisible();
  expect(backend.lastCall("space.open")).toEqual({ path: "/Users/lea/Maison" });
  const navigation = screen.getByRole("navigation", { name: "Sections de l’espace de travail" });
  expect(within(navigation).queryAllByRole("button")).toHaveLength(0);

  // L’agent construit dans le dossier : le backend signale le changement, la navigation se relit.
  backend.withSpace("/Users/lea/Maison", "Maison", builtModules());
  act(() => backend.emit("space:changed"));
  const suivi = await within(navigation).findByRole("button", { name: "Suivi" });
  expect(within(navigation).getByRole("button", { name: "Notes" })).toBeVisible();
  expect(backend.commandsCalled()).toContain("db.applyMigrations");

  // Section à deux onglets : la page s’affiche dans son cadre, avec son panneau de droite.
  await user.click(suivi);
  expect(screen.getByRole("heading", { name: "Suivi" })).toBeVisible();
  const tabs = screen.getByRole("tablist", { name: "Onglets de Suivi" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Tâches", "Échéances"]);
  expect(await screen.findByTitle("Tâches")).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  expect(await screen.findByTitle("Détail")).toBeInTheDocument();
  const page = screen.getByTitle("Tâches") as HTMLIFrameElement;
  expect(page.src).toContain("module=suivi");
  expect(page.src).toContain(`key=${frameKeyOf("suivi")}`);
  expect(page.src).toContain("page=taches");

  // Le panneau se masque et se réaffiche.
  await user.click(screen.getByRole("button", { name: "Masquer le panneau « Détail »" }));
  expect(screen.queryByTitle("Détail")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Afficher le panneau « Détail »" }));
  expect(await screen.findByTitle("Détail")).toBeInTheDocument();

  // L’autre onglet n’est pas encore écrit : l’utilisateur le voit en cours de création.
  await user.click(within(tabs).getByRole("tab", { name: "Échéances" }));
  expect(await screen.findByText("Page en cours de création")).toBeVisible();
  expect(screen.queryByTitle("Détail")).not.toBeInTheDocument();

  // Retour à la page Agent, puis les Réglages : une fenêtre par-dessus l’app, rubriques dans sa barre latérale.
  await user.click(screen.getByRole("button", { name: "Agent" }));
  expect(await screen.findByText("Que puis-je faire pour vous ?")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Réglages" }));
  const settings = await screen.findByRole("dialog", { name: "Réglages" });
  const nav = within(settings).getByRole("navigation", { name: "Rubriques des Réglages" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((item) => item.textContent),
  ).toEqual([
    "Modules",
    "Général",
    "Apparence",
    "Ordre du menu",
    "Fonctions",
    "Webhooks",
    "Tâches planifiées",
    "Journal",
    "Marketplaces",
    "Agent",
    "Voix",
    "Mots de passe et clés",
    "Préférences du suivi",
  ]);
  // L’espace de travail d’abord, puis Alfred : deux groupes titrés.
  expect(
    within(nav)
      .getAllByText(/^(Espace de travail|Alfred|Pages de l’espace de travail)$/)
      .map((title) => title.textContent),
  ).toEqual(["Espace de travail", "Alfred", "Pages de l’espace de travail"]);
  // Les modules d’abord, en liste ; « Importer des modules » mène au catalogue des marketplaces.
  expect(await within(settings).findByRole("list", { name: "Modules de l’espace de travail" })).toBeVisible();
  await user.click(within(settings).getByRole("button", { name: "Importer des modules" }));
  expect((await within(settings).findAllByText("Importer des modules"))[0]).toBeVisible();
  await user.click(within(settings).getByRole("button", { name: "Tous les modules" }));

  const expected: Record<string, string> = {
    Agent: "Harnais par défaut",
    Général: "Historique",
    Marketplaces: "Aucun marketplace",
    Apparence: "Couleur d’accent",
    "Mots de passe et clés": "Aucun mot de passe ni clé",
    "Ordre du menu": "Pages des Réglages",
    Fonctions: "Synchronise les tâches avec Jira.",
    Webhooks: "Aucun webhook",
    "Tâches planifiées": "Aucune planification",
    Journal: "Aucune exécution",
  };
  for (const [item, text] of Object.entries(expected)) {
    await user.click(within(nav).getByRole("button", { name: item }));
    expect((await within(settings).findAllByText(text))[0], `rubrique ${item}`).toBeVisible();
  }
  await user.click(within(nav).getByRole("button", { name: "Préférences du suivi" }));
  expect(await within(settings).findByTitle("Préférences du suivi")).toBeInTheDocument();

  // La recherche réduit la barre latérale ; Échap ferme la fenêtre et rend la page Agent.
  await user.type(within(nav).getByLabelText("Rechercher un réglage"), "cles");
  expect(
    within(nav)
      .getAllByRole("button")
      .filter((item) => item.classList.contains("settings-modal__item"))
      .map((item) => item.textContent),
  ).toEqual(["Mots de passe et clés"]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Réglages" })).not.toBeInTheDocument());
  expect(screen.getByText("Que puis-je faire pour vous ?")).toBeVisible();

  // Palette de commandes (Cmd+K sur macOS) : elle trouve une page et y mène.
  await user.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: "Palette de commandes" });
  await user.type(within(palette).getByPlaceholderText("Rechercher une page, une fonction ou une commande…"), "Carnet");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible());
  expect(await screen.findByTitle("Carnet")).toBeInTheDocument();

  // Une page demande un client : la question est posée à l’utilisateur, qui accorde ; l’accord est mémorisé.
  let answer: Promise<{ result?: unknown; error?: string }> | undefined;
  act(() => {
    answer = backend.ask("permission:ask", {
      subject: { kind: "page", module: "notes", reference: "notes/carnet" },
      resource: "client:jira",
      label: "le client Jira",
    });
  });
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Autoriser l’accès au client Jira ?")).toBeVisible();
  expect(within(dialog).getByText(/La page « Carnet » \(notes\/carnet\) veut utiliser le client Jira/)).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Autoriser" }));
  expect(await answer).toEqual({ result: { granted: true } });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

  expect(backend.unknown, "commandes absentes du faux backend").toEqual([]);
});
