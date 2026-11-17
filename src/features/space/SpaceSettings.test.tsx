import { render, screen, waitFor, within } from "@testing-library/react";
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
import { AppearanceSettings, type Grant, SpaceSettings } from "./SpaceSettings";

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
  const { unmount } = render(<SpaceSettings />);

  // La rubrique s’ouvre sur son titre, « Général », comme les autres rubriques.
  expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Général");
  // Une seule liste : l’espace ouvert, marqué, avec son dossier en texte discret.
  const list = screen.getByRole("group", { name: "Vos espaces de travail" });
  expect(within(list).getByText("Atelier")).toBeInTheDocument();
  expect(within(list).getByText("Ouvert")).toBeInTheDocument();
  expect(within(list).getByText("/Users/test/Espaces de travail/Atelier")).toBeInTheDocument();
  expect(within(list).queryByRole("button", { name: "Ouvrir l’espace de travail Atelier" })).not.toBeInTheDocument();

  // Renommer : le nom seul, jamais le dossier.
  await user.click(within(list).getByRole("button", { name: "Actions de l’espace de travail Atelier" }));
  await user.click(screen.getByRole("menuitem", { name: "Renommer…" }));
  const renaming = screen.getByRole("dialog", { name: "Renommer l’espace de travail" });
  expect(within(renaming).queryByLabelText(/Dossier/)).not.toBeInTheDocument();
  await user.clear(within(renaming).getByLabelText(/Nom/));
  await user.type(within(renaming).getByLabelText(/Nom/), "Atelier Lyon{Enter}");
  await waitFor(() => expect(notifications()).toContain("Espace de travail renommé"));
  expect(lastCall("spaces.rename")).toEqual({ path: "/Users/test/Espaces de travail/Atelier", name: "Atelier Lyon" });
  expect(useShell.getState().snapshot?.name).toBe("Atelier Lyon");

  await user.click(within(list).getByRole("button", { name: "Actions de l’espace de travail Atelier Lyon" }));
  await user.click(screen.getByRole("menuitem", { name: "Afficher dans le Finder" }));
  expect(lastCall("files.reveal")).toEqual({ path: "/Users/test/Espaces de travail/Atelier" });

  // L’apparence est une rubrique à part.
  expect(screen.queryByLabelText("Couleur d’accent")).not.toBeInTheDocument();
  unmount();
  const appearance = render(<AppearanceSettings />);

  // Thème : suivre le système est le choix actif, puis Sombre.
  expect(screen.getByRole("radio", { name: /^Système/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /^Sombre/ }));
  expect(useShell.getState().theme).toBe("dark");
  expect(lastCall("settings.set")).toEqual({ key: "appearance.theme", value: "dark" });
  expect(screen.getByRole("radio", { name: /^Sombre/ })).toBeChecked();
  expect(screen.getByText(/Le reste du thème .* est fixé par Alfred/)).toBeInTheDocument();

  // Accent : appliqué immédiatement, puis retour à « Par défaut ».
  await user.selectOptions(screen.getByLabelText("Couleur d’accent"), "teal");
  await waitFor(() => expect(useShell.getState().snapshot?.accent).toBe("teal"));
  expect(lastCall("space.updateLayout")).toMatchObject({ accent: "teal" });
  await user.selectOptions(screen.getByLabelText("Couleur d’accent"), "");
  await waitFor(() => expect(lastCall("space.updateLayout")).toMatchObject({ accent: null }));

  // Changer d’espace : un espace récent s’ouvre en un clic, sans repasser par l’accueil.
  appearance.unmount();
  useShell.setState({
    recentSpaces: [
      { path: "/Users/test/Espaces de travail/Atelier", name: "Atelier Lyon", openedAt: "2026-11-14T09:00:00Z" },
      { path: "/Users/test/Espaces de travail/Perso", name: "Perso", openedAt: "2026-11-13T09:00:00Z" },
    ],
  });
  render(<SpaceSettings />);
  const recent = screen.getByRole("group", { name: "Vos espaces de travail" });
  expect(within(recent).getByText(/Ouvert le 13 novembre 2026/)).toBeInTheDocument();
  await user.click(within(recent).getByRole("button", { name: "Ouvrir l’espace de travail Perso" }));
  await waitFor(() =>
    expect(lastCall("space.open")).toEqual({ path: "/Users/test/Espaces de travail/Perso", existing: true }),
  );
  expect(useShell.getState().recentSpaces[0]?.path).toBe("/Users/test/Espaces de travail/Perso");

  // Fermer l’espace : confirmé, puis retour à l’accueil.
  await user.click(screen.getByRole("button", { name: "Fermer l’espace de travail" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/Rien n’est supprimé/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Fermer l’espace de travail" }));
  await waitFor(() => expect(useShell.getState().snapshot).toBeNull());
  expect(lastCall("space.close")).toEqual({});
});

it("annule une modification de l’historique et retire un accès accordé", async () => {
  const user = userEvent.setup();
  render(<SpaceSettings />);

  const table = await screen.findByRole("table", { name: "Historique de l’espace de travail" });
  expect(within(table).getByText("Ajout de la page Tableau des ventes")).toBeInTheDocument();
  expect(lastCall("space.history")).toEqual({ limit: 50 });

  // Une modification non annulable seule : l’erreur du backend est rapportée telle quelle.
  undoError = "Cette modification touche des fichiers modifiés depuis : annulez d’abord les plus récentes.";
  await user.click(screen.getByRole("button", { name: "Annuler la modification « Création de l’espace de travail »" }));
  let dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/peut elle-même être annulée/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Annuler la modification" }));
  await waitFor(() => expect(notifications()).toContain("La modification n’a pas été annulée"));
  expect(useNotifications.getState().items[0].description).toBe(undoError);

  undoError = undefined;
  await user.click(
    screen.getByRole("button", { name: "Annuler la modification « Ajout de la page Tableau des ventes »" }),
  );
  dialog = screen.getByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Annuler la modification" }));
  expect(await within(table).findByText("Annulation : Ajout de la page Tableau des ventes")).toBeInTheDocument();
  expect(lastCall("space.undo")).toEqual({ commit: "c2" });
  expect(notifications()).toContain("Modification annulée");

  // Accès : le demandeur et la ressource sont nommés comme l’utilisateur les connaît.
  const access = await screen.findByRole("table", { name: "Accès accordés" });
  expect(within(access).getByText("Page « Tableau des ventes » (module Ventes)")).toBeInTheDocument();
  expect(within(access).getByText("Client « Jira de l’équipe »")).toBeInTheDocument();
  await user.click(
    within(access).getByRole("button", {
      name: "Retirer l’accès de Page « Tableau des ventes » (module Ventes) à Client « Jira de l’équipe »",
    }),
  );
  dialog = screen.getByRole("alertdialog");
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
  const list = screen.getByRole("group", { name: "Vos espaces de travail" });
  await user.click(within(list).getByRole("button", { name: `Actions de l’espace de travail ${name}` }));
  await user.click(screen.getByRole("menuitem", { name: "Supprimer…" }));
  return screen.getByRole("alertdialog");
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
  render(<SpaceSettings />);

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
  render(<SpaceSettings />);

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
