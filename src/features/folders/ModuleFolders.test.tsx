import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

import { invoke } from "../../lib/native";
import { renderSections } from "../modules/settingsHarness";
import { type GrantedFolder, useFoldersSection } from "./ModuleFolders";

const useSections = () => {
  const section = useFoldersSection({ id: "produits", name: "Produits" });
  return section ? [section] : [];
};

let granted: GrantedFolder[];

beforeEach(() => {
  granted = [
    { id: "api", path: "/Users/moi/alpha/api", label: "api", grantedAt: "2026-11-20T10:00:00Z", grantedBy: "user" },
    { id: "equipe", path: "/Users/moi/equipe", label: "Équipe", grantedAt: "2026-11-19T10:00:00Z", grantedBy: "agent" },
  ];
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "folders.list") return granted;
    if (command === "folders.revoke") {
      granted = granted.filter((folder) => folder.id !== (args as { folder: string }).folder);
      return null;
    }
    throw new Error(`inattendu : ${command}`);
  });
});

it("montre les dossiers accordés et retire un accès après confirmation", async () => {
  renderSections(useSections);
  expect(await screen.findByText(/\/Users\/moi\/alpha\/api/)).toBeTruthy();
  expect(screen.getByText(/par l’agent/)).toBeTruthy();
  const row = screen.getByRole("group", { name: "Actions sur Équipe" });
  await userEvent.click(within(row).getByRole("button", { name: "Plus d'actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Retirer l’accès à Équipe" }));
  await userEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retirer l’accès" }),
  );
  await waitFor(() => expect(screen.queryByText(/\/Users\/moi\/equipe/)).toBeNull());
  expect(invoke).toHaveBeenCalledWith("folders.revoke", { module: "produits", folder: "equipe" });
});

it("ne montre rien quand le module n’a aucun dossier", async () => {
  granted = [];
  renderSections(useSections);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("folders.list", { module: "produits" }));
  expect(screen.queryByRole("region", { name: "Dossiers du poste" })).toBeNull();
});
