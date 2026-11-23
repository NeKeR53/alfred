import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { renderSections } from "../modules/settingsHarness";
import type { VaultEntry } from "./api";
import { useVaultSections } from "./VaultSettings";

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const SECRET = "s3cr3t-jira-AAA";

/** Faux backend : garde l’inventaire, jamais renvoyé avec une valeur secrète, comme le vrai. */
let entries: VaultEntry[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let deleteError: string | undefined;
const listeners = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  entries = [];
  calls = [];
  deleteError = undefined;
  listeners.clear();
  useNotifications.getState().clear();
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "vault.list") return entries.map((entry) => ({ ...entry }));
    if (command === "vault.save") {
      const input = args as {
        id: string;
        label: string;
        kind: VaultEntry["kind"];
        meta: Record<string, string>;
        secrets: Record<string, string>;
      };
      const previous = entries.find((entry) => entry.id === input.id);
      const saved: VaultEntry = {
        id: input.id,
        label: input.label,
        kind: input.kind,
        meta: input.meta,
        updatedAt: "2026-11-12T10:00:00Z",
        hasSecret: Boolean(previous?.hasSecret) || Object.values(input.secrets).some(Boolean),
      };
      entries = [...entries.filter((entry) => entry.id !== input.id), saved];
      return saved;
    }
    if (command === "vault.delete") {
      if (deleteError) throw new Error(deleteError);
      entries = entries.filter((entry) => entry.id !== (args as { id: string }).id);
      return null;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

const lastCall = (command: string) => calls.filter((call) => call.command === command).at(-1)?.args;
const notifications = () => useNotifications.getState().items.map((item) => item.title);

/** Ouvre le menu « … » d’une ligne de réglage et choisit une entrée. */
async function openMenuItem(user: ReturnType<typeof userEvent.setup>, row: string, item: string) {
  const actions = screen.getByRole("group", { name: `Actions sur ${row}` });
  await user.click(within(actions).getByRole("button", { name: "Plus d'actions" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

it("crée, modifie et supprime une entrée sans jamais afficher ni préremplir le secret", async () => {
  const user = userEvent.setup();
  renderSections(useVaultSections, "Coffre");

  // Coffre vide : l’état vide explique le coffre et propose la création.
  expect(await screen.findByText(/^Aucun mot de passe ni clé\./)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  const creation = await screen.findByRole("dialog", { name: "Nouveau mot de passe ou clé" });

  // L’identifiant suit le libellé ; le secret est un champ masqué, vide, et obligatoire à la création.
  await user.type(within(creation).getByLabelText("Libellé"), "Jeton Jira");
  expect(within(creation).getByLabelText("Identifiant")).toHaveValue("jeton-jira");
  const value = within(creation).getByLabelText("Valeur");
  expect(value).toHaveAttribute("type", "password");
  expect(value).toHaveValue("");
  await user.click(within(creation).getByRole("button", { name: "Créer" }));
  expect(within(creation).getByText("Saisissez la valeur.")).toBeInTheDocument();
  expect(lastCall("vault.save")).toBeUndefined();

  await user.type(value, SECRET);
  await user.click(within(creation).getByRole("button", { name: "Créer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(lastCall("vault.save")).toEqual({
    id: "jeton-jira",
    label: "Jeton Jira",
    kind: "token",
    meta: {},
    secrets: { value: SECRET },
  });
  expect(notifications()).toContain("Mot de passe ou clé ajouté");

  // La liste montre l’entrée et son état, pas sa valeur.
  const table = await screen.findByRole("region", { name: "Mots de passe et clés" });
  expect(within(table).getByText("Jeton Jira")).toBeInTheDocument();
  expect(within(table).getByText(/^Jeton ou clé d’API · mis à jour le/)).toBeInTheDocument();
  expect(within(table).getByText("Secret enregistré")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(SECRET);

  // Édition : identifiant et type figés, secret vide avec la consigne « Laisser vide pour conserver ».
  await user.click(screen.getByRole("button", { name: "Modifier Jeton Jira" }));
  const edition = await screen.findByRole("dialog", { name: "Modifier « Jeton Jira »" });
  expect(within(edition).getByLabelText("Identifiant")).toBeDisabled();
  expect(within(edition).getByRole("button", { name: /Type/ })).toBeDisabled();
  expect(within(edition).getByLabelText(/^Valeur/)).toHaveValue("");
  expect(within(edition).getByLabelText(/^Valeur/)).toHaveAttribute("type", "password");
  expect(within(edition).getByText(/Laisser vide pour conserver/)).toBeInTheDocument();
  expect(edition.innerHTML).not.toContain(SECRET);
  await user.clear(within(edition).getByLabelText("Libellé"));
  await user.type(within(edition).getByLabelText("Libellé"), "Jeton Jira (prod)");
  await user.click(within(edition).getByRole("button", { name: "Enregistrer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(lastCall("vault.save")).toEqual({
    id: "jeton-jira",
    label: "Jeton Jira (prod)",
    kind: "token",
    meta: {},
    secrets: {},
  });
  expect(await screen.findByText("Jeton Jira (prod)")).toBeInTheDocument();

  // Suppression : confirmée, et un refus du backend (entrée utilisée par un client) est rapporté tel quel.
  deleteError = "Cette entrée est utilisée par le client : Jira.";
  await openMenuItem(user, "Jeton Jira (prod)", "Supprimer Jeton Jira (prod)");
  const confirmation = await screen.findByRole("alertdialog");
  expect(within(confirmation).getByText("Supprimer « Jeton Jira (prod) » ?")).toBeInTheDocument();
  await user.click(within(confirmation).getByRole("button", { name: "Annuler" }));
  expect(lastCall("vault.delete")).toBeUndefined();
  await openMenuItem(user, "Jeton Jira (prod)", "Supprimer Jeton Jira (prod)");
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(notifications()).toContain("Le mot de passe ou la clé n’a pas été supprimé"));
  expect(useNotifications.getState().items[0].description).toBe(deleteError);
  expect(screen.getByText("Jeton Jira (prod)")).toBeInTheDocument();

  deleteError = undefined;
  await openMenuItem(user, "Jeton Jira (prod)", "Supprimer Jeton Jira (prod)");
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  expect(await screen.findByText(/^Aucun mot de passe ni clé\./)).toBeInTheDocument();
  expect(lastCall("vault.delete")).toEqual({ id: "jeton-jira" });
});

it("adapte le formulaire au type et suit les changements venus d’ailleurs", async () => {
  const user = userEvent.setup();
  entries = [
    {
      id: "sso",
      label: "SSO",
      kind: "oauth2",
      meta: { clientId: "alfred-app" },
      updatedAt: "2026-11-12T09:00:00Z",
      hasSecret: false,
      connected: false,
    },
  ];
  renderSections(useVaultSections, "Coffre");
  const table = await screen.findByRole("region", { name: "Mots de passe et clés" });
  expect(within(table).getByText("Non connecté")).toBeInTheDocument();

  // Une connexion OAuth aboutie ailleurs met la liste à jour.
  entries = [{ ...entries[0], connected: true }];
  listeners.get("clients:changed")?.({ client: "portail", connected: true });
  expect(await within(table).findByText("Connecté")).toBeInTheDocument();

  // Identifiant et mot de passe : l’identifiant de connexion n’est pas secret, le mot de passe l’est.
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  const dialog = await screen.findByRole("dialog", { name: "Nouveau mot de passe ou clé" });
  await user.click(within(dialog).getByRole("button", { name: /Type/ }));
  await user.click(await screen.findByRole("option", { name: "Identifiant et mot de passe" }));
  await user.type(within(dialog).getByLabelText("Libellé"), "Compte de service");
  await user.clear(within(dialog).getByLabelText("Identifiant"));
  await user.type(within(dialog).getByLabelText("Identifiant"), "Compte Invalide");
  await user.type(within(dialog).getByLabelText("Mot de passe"), "p4ss-BBB");
  await user.click(within(dialog).getByRole("button", { name: "Créer" }));
  expect(within(dialog).getByText("Saisissez l’identifiant de connexion.")).toBeInTheDocument();
  expect(within(dialog).getByText(/minuscules, chiffres et tirets \(64/)).toBeInTheDocument();
  await user.clear(within(dialog).getByLabelText("Identifiant"));
  await user.type(within(dialog).getByLabelText("Identifiant"), "compte");
  await user.type(within(dialog).getByLabelText("Identifiant de connexion"), "alice");
  expect(within(dialog).getByLabelText("Identifiant de connexion")).not.toHaveAttribute("type", "password");
  expect(within(dialog).getByLabelText("Mot de passe")).toHaveAttribute("type", "password");
  await user.click(within(dialog).getByRole("button", { name: "Créer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(lastCall("vault.save")).toEqual({
    id: "compte",
    label: "Compte de service",
    kind: "basic",
    meta: { username: "alice" },
    secrets: { password: "p4ss-BBB" },
  });
  expect(document.body.textContent).not.toContain("p4ss-BBB");
});
