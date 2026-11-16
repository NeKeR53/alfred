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
        snapshot = { ...snapshot, path: String(args.path), name: "Perso" };
        return snapshot;
      case "space.undo":
        if (undoError) throw new Error(undoError);
        history = [
          { id: "c3", message: `Annulation : ${history[0].message}`, date: history[0].date, files: [] },
          ...history,
        ];
        return { commit: "c3" };
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

  const name = screen.getByLabelText("Nom de l’espace de travail");
  await user.clear(name);
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(screen.getByText("Saisissez le nom de l’espace de travail.")).toBeInTheDocument();
  await user.type(name, "Atelier Lyon{Enter}");
  await waitFor(() => expect(notifications()).toContain("Espace de travail renommé"));
  expect(lastCall("space.updateLayout")).toMatchObject({ name: "Atelier Lyon" });
  expect(useShell.getState().snapshot?.name).toBe("Atelier Lyon");

  expect(screen.getByText("/Users/test/Espaces de travail/Atelier")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Afficher dans le Finder" }));
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
  const recent = screen.getByRole("group", { name: "Espaces de travail récents" });
  // L’espace ouvert n’est pas proposé.
  expect(within(recent).queryByText("Atelier Lyon")).not.toBeInTheDocument();
  await user.click(within(recent).getByRole("button", { name: "Ouvrir l’espace de travail Perso" }));
  await waitFor(() => expect(lastCall("space.open")).toEqual({ path: "/Users/test/Espaces de travail/Perso" }));
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
