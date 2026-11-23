import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
// Le magasin de la coquille lit le thème du système à son chargement ; jsdom n’a pas `matchMedia`.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke, onNativeEvent } from "../../lib/native";
import type { Commit, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { type Grant, useAppearanceSections, useSpaceSections } from "./SpaceSettings";
import { pressRowAction, renderSections } from "./sections.test-helper";

const renderGeneral = () => renderSections(useSpaceSections, "Général");

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

let snapshot: Snapshot;
let history: Commit[];
let grants: Grant[];
let undoError: string | undefined;
let calls: Array<{ command: string; args: Record<string, unknown> }>;

const page = (reference: string, title: string) => ({
  reference,
  module: reference.split("/")[0],
  id: reference.split("/")[1],
  title,
  icon: null,
  description: "",
  hidden: false,
  readOnly: false,
  missing: false,
  errors: [],
  uses: {},
  panel: null,
});

beforeEach(() => {
  calls = [];
  undoError = undefined;
  useNotifications.getState().clear();
  snapshot = {
    path: "/Users/test/Espaces de travail/Atelier",
    name: "Atelier",
    accent: null,
    sections: [
      {
        id: "ventes/main",
        module: "ventes",
        label: "Ventes",
        icon: null,
        color: null,
        hidden: false,
        pages: [page("ventes/tableau", "Tableau des ventes")],
      },
    ],
    settingsPages: [],
    modules: [
      {
        id: "ventes",
        name: "Ventes",
        version: "1.0.0",
        description: "",
        readOnly: false,
        origin: null,
        hidden: false,
        requires: [],
        requiredBy: [],
        pages: 1,
        functions: 1,
        clients: [{ id: "jira", label: "Jira de l’équipe" }],
        webhooks: [],
        schedules: [],
      },
    ],
    functions: [],
    bindings: {},
    problems: [],
  };
  history = [
    { id: "c2", message: "Ajout de la page Tableau des ventes", date: "2026-11-12T10:00:00+01:00", files: ["a", "b"] },
    { id: "c1", message: "Création de l’espace de travail", date: "2026-11-10T09:00:00+01:00", files: ["space.json"] },
  ];
  grants = [{ subject: "page:ventes/tableau", resource: "client:jira", grantedAt: "2026-11-11T08:00:00Z" }];
  useShell.setState({
    snapshot,
    theme: "light",
    themeFollowsSystem: true,
    info: { version: "0.1.0", serverPort: 1, pageBase: "", platform: "macos", home: null },
  });
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "space.history":
        return history;
      case "grants.list":
        return grants;
      case "grants.revoke":
        grants = [];
        return null;
      case "space.updateLayout": {
        const input = args as { name?: string; accent?: string | null };
        snapshot = {
          ...snapshot,
          ...(input.name ? { name: input.name } : {}),
          ...("accent" in input ? { accent: input.accent ?? null } : {}),
        };
        return snapshot;
      }
      case "space.snapshot":
        return snapshot;
      case "space.open":
        if (args.path === "/Users/test/Espaces de travail/Disparu")
          throw new Error("Le dossier n’est plus un espace de travail.");
        snapshot = { ...snapshot, path: String(args.path), name: String(args.path).split("/").pop() ?? "" };
        return snapshot;
      case "spaces.rename":
        if (args.path === snapshot.path) snapshot = { ...snapshot, name: String(args.name) };
        return { name: args.name };
      case "spaces.trash":
      case "jobs.list":
        return command === "jobs.list" ? [] : null;
      case "space.undo":
        if (undoError) throw new Error(undoError);
        history = [
          { id: "c3", message: `Annulation : ${history[0].message}`, date: history[0].date, files: [] },
          ...history,
        ];
        return { commit: "c3" };
      case "backups.list":
        return [];
      case "backups.settings":
        return { keep: 14 };
      case "decisions.model":
        return {
          model: "convaiinnovations/laya-multilingual",
          sizeMb: 647,
          status: "missing",
          received: null,
          total: null,
          error: null,
          damaged: null,
        };
      case "semantic.model":
        return {
          model: "intfloat/multilingual-e5-small",
          sizeMb: 470,
          status: "missing",
          received: null,
          total: null,
          error: null,
        };
      case "files.reveal":
      case "settings.set":
      case "space.close":
        return null;
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const lastCall = (command: string) => calls.filter((call) => call.command === command).at(-1)?.args;
const notifications = () => useNotifications.getState().items.map((item) => item.title);

it("renomme l’espace de travail, montre son dossier, règle l’apparence et ramène à l’accueil après confirmation", async () => {
  const user = userEvent.setup();
  const { unmount } = renderGeneral();

  // La rubrique s’ouvre sur son titre, « Général ».
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Général");
  // L’espace ouvert, marqué, avec son dossier.
  expect(screen.getByText("Atelier")).toBeInTheDocument();
  expect(screen.getByText("Ouvert")).toBeInTheDocument();
  expect(screen.getByText("/Users/test/Espaces de travail/Atelier")).toBeInTheDocument();
  const actions = screen.getByRole("group", { name: "Actions sur Atelier" });
  expect(within(actions).queryByRole("button", { name: "Ouvrir" })).not.toBeInTheDocument();

  // Renommer : le nom seul, jamais le dossier.
  await pressRowAction(user, "Atelier", "Renommer…");
  const renaming = screen.getByRole("dialog", { name: "Renommer l’espace de travail" });
  expect(within(renaming).queryByLabelText(/Dossier/)).not.toBeInTheDocument();
  await user.clear(within(renaming).getByRole("textbox", { name: /Nom/ }));
  await user.type(within(renaming).getByRole("textbox", { name: /Nom/ }), "Atelier Lyon{Enter}");
  await waitFor(() => expect(notifications()).toContain("Espace de travail renommé"));
  expect(lastCall("spaces.rename")).toEqual({ path: "/Users/test/Espaces de travail/Atelier", name: "Atelier Lyon" });
  expect(useShell.getState().snapshot?.name).toBe("Atelier Lyon");

  await pressRowAction(user, "Atelier Lyon", "Afficher dans le Finder");
  await waitFor(() => expect(lastCall("files.reveal")).toEqual({ path: "/Users/test/Espaces de travail/Atelier" }));
  unmount();

  // L’apparence est une rubrique à part : mode (comme l’ordinateur d’abord), densité, accent.
  const appearance = renderSections(useAppearanceSections, "Apparence");
  const mode = screen.getByRole("button", { name: /Mode/ });
  expect(mode).toHaveTextContent("Comme l’ordinateur");
  await user.click(mode);
  await user.click(await screen.findByRole("option", { name: "Sombre" }));
  expect(useShell.getState().theme).toBe("dark");
  expect(lastCall("settings.set")).toEqual({ key: "appearance.theme", value: "dark" });
  expect(screen.getByText(/Le reste du thème .* est fixé/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Couleur d’accent/ }));
  await user.click(await screen.findByRole("option", { name: "Bleu-vert" }));
  await waitFor(() => expect(useShell.getState().snapshot?.accent).toBe("teal"));
  expect(lastCall("space.updateLayout")).toMatchObject({ accent: "teal" });
  await user.click(screen.getByRole("button", { name: /Couleur d’accent/ }));
  await user.click(await screen.findByRole("option", { name: "Par défaut" }));
  await waitFor(() => expect(lastCall("space.updateLayout")).toMatchObject({ accent: null }));
  appearance.unmount();

  // Changer d’espace : un espace récent s’ouvre en un clic, sans repasser par l’accueil.
  useShell.setState({
    recentSpaces: [
      { path: "/Users/test/Espaces de travail/Atelier", name: "Atelier Lyon", openedAt: "2026-11-14T09:00:00Z" },
      { path: "/Users/test/Espaces de travail/Perso", name: "Perso", openedAt: "2026-11-13T09:00:00Z" },
    ],
  });
  renderGeneral();
  expect(screen.getByText(/Ouvert le 13 novembre 2026/)).toBeInTheDocument();
  await pressRowAction(user, "Perso", "Ouvrir");
  await waitFor(() =>
    expect(lastCall("space.open")).toEqual({ path: "/Users/test/Espaces de travail/Perso", existing: true }),
  );
  expect(useShell.getState().recentSpaces[0]?.path).toBe("/Users/test/Espaces de travail/Perso");

  // Fermer l’espace : confirmé, puis retour à l’accueil.
  await user.click(screen.getByRole("button", { name: "Fermer l’espace de travail" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Rien n’est supprimé/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Fermer l’espace de travail" }));
  await waitFor(() => expect(useShell.getState().snapshot).toBeNull());
  expect(lastCall("space.close")).toEqual({});
});

it("annule une modification de l’historique et retire un accès accordé", async () => {
  const user = userEvent.setup();
  renderGeneral();

  expect(await screen.findByText("Ajout de la page Tableau des ventes")).toBeInTheDocument();
  expect(lastCall("space.history")).toEqual({ limit: 50 });

  // Une modification non annulable seule : l’erreur du backend est rapportée telle quelle.
  undoError = "Cette modification touche des fichiers modifiés depuis : annulez d’abord les plus récentes.";
  await pressRowAction(user, "Création de l’espace de travail", "Annuler la modification");
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/peut elle-même être annulée/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Annuler la modification" }));
  await waitFor(() => expect(notifications()).toContain("La modification n’a pas été annulée"));
  expect(useNotifications.getState().items[0].description).toBe(undoError);

  undoError = undefined;
  await pressRowAction(user, "Ajout de la page Tableau des ventes", "Annuler la modification");
  dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Annuler la modification" }));
  expect(await screen.findByText("Annulation : Ajout de la page Tableau des ventes")).toBeInTheDocument();
  expect(lastCall("space.undo")).toEqual({ commit: "c2" });
  expect(notifications()).toContain("Modification annulée");

  // Accès : le demandeur et la ressource sont nommés comme l’utilisateur les connaît.
  const access = await screen.findByRole("grid", { name: "Accès accordés" });
  expect(within(access).getByText("Page « Tableau des ventes » (module Ventes)")).toBeInTheDocument();
  expect(within(access).getByText("Client « Jira de l’équipe »")).toBeInTheDocument();
  await user.click(
    within(access).getByRole("button", {
      name: "Retirer l’accès Page « Tableau des ventes » (module Ventes)",
    }),
  );
  dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Retirer" }));
  expect(await screen.findByText("Aucun accès accordé")).toBeInTheDocument();
  expect(lastCall("grants.revoke")).toEqual({ subject: "page:ventes/tableau", resource: "client:jira" });
});

const ATELIER = "/Users/test/Espaces de travail/Atelier";
const PERSO = "/Users/test/Espaces de travail/Perso";
const PRO = "/Users/test/Espaces de travail/Pro";
const GONE = "/Users/test/Espaces de travail/Disparu";

/** Ouvre « Supprimer… » d’un espace de la liste et renvoie la confirmation. */
async function askRemoval(user: ReturnType<typeof userEvent.setup>, name: string) {
  await pressRowAction(user, name, "Supprimer…");
  return screen.findByRole("alertdialog");
}
it("supprime un autre espace de la liste sans toucher au disque, ou le met à la corbeille si on le coche", async () => {
  useShell.setState({
    recentSpaces: [
      { path: ATELIER, name: "Atelier", openedAt: "2026-11-16T09:00:00Z" },
      { path: PERSO, name: "Perso", openedAt: "2026-11-15T09:00:00Z" },
      { path: PRO, name: "Pro", openedAt: "2026-11-14T09:00:00Z" },
    ],
  });
  const user = userEvent.setup();
  renderGeneral();

  let dialog = await askRemoval(user, "Perso");
  expect(dialog).toHaveTextContent("Supprimer l’espace de travail « Perso » ?");
  expect(dialog).toHaveTextContent(PERSO);
  expect(dialog).toHaveTextContent(/Son dossier reste en place : rien n’est effacé/);
  expect(within(dialog).getByRole("checkbox", { name: "Mettre aussi le dossier à la corbeille" })).not.toBeChecked();
  await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(notifications()).toContain("« Perso » est retiré de la liste"));
  expect(useShell.getState().recentSpaces.map((space) => space.path)).toEqual([ATELIER, PRO]);
  expect(lastCall("spaces.trash")).toBeUndefined();
  expect(useShell.getState().snapshot?.path).toBe(ATELIER);

  dialog = await askRemoval(user, "Pro");
  await user.click(within(dialog).getByRole("checkbox", { name: "Mettre aussi le dossier à la corbeille" }));
  expect(dialog).toHaveTextContent(/son dossier part à la corbeille du système/);
  await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(lastCall("spaces.trash")).toEqual({ path: PRO }));
  expect(notifications()).toContain("« Pro » est à la corbeille");
  expect(useShell.getState().recentSpaces.map((space) => space.path)).toEqual([ATELIER]);
});

it("supprimer l’espace ouvert passe sur le plus récent des autres encore présents, et sur l’accueil s’il n’en reste aucun", async () => {
  useShell.setState({
    recentSpaces: [
      { path: ATELIER, name: "Atelier", openedAt: "2026-11-16T09:00:00Z" },
      { path: GONE, name: "Disparu", openedAt: "2026-11-15T12:00:00Z" },
      { path: PERSO, name: "Perso", openedAt: "2026-11-15T09:00:00Z" },
    ],
  });
  const user = userEvent.setup();
  renderGeneral();

  let dialog = await askRemoval(user, "Atelier");
  expect(dialog).toHaveTextContent(/C’est l’espace ouvert : Alfred passe sur « Disparu »/);
  await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  // Le dossier de « Disparu » n’existe plus : il n’est pas recréé, Perso prend la place.
  await waitFor(() => expect(useShell.getState().snapshot?.path).toBe(PERSO));
  expect(calls.filter((call) => call.command === "space.open").map((call) => call.args)).toEqual([
    { path: GONE, existing: true },
    { path: PERSO, existing: true },
  ]);
  await waitFor(() => expect(useShell.getState().recentSpaces.map((space) => space.path)).toEqual([PERSO, GONE]));
  useShell.getState().forgetSpace(GONE);

  dialog = await askRemoval(user, "Perso");
  expect(dialog).toHaveTextContent(/C’est l’espace ouvert : Alfred revient à l’accueil/);
  await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(useShell.getState().snapshot).toBeNull());
  expect(lastCall("space.close")).toEqual({});
  expect(useShell.getState().recentSpaces).toEqual([]);
  expect(lastCall("spaces.trash")).toBeUndefined();
});
