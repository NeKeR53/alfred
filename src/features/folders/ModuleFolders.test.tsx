import { render, screen, waitFor } from "@testing-library/react";
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
import { type GrantedFolder, ModuleFolders } from "./ModuleFolders";

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
  render(<ModuleFolders module="produits" name="Produits" />);
  expect(await screen.findByText("/Users/moi/alpha/api")).toBeTruthy();
  expect(screen.getByText(/par l’agent/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retirer l’accès à Équipe" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Retirer l’accès" }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByText("/Users/moi/equipe")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("folders.revoke", { module: "produits", folder: "equipe" });
});

it("ne montre rien quand le module n’a aucun dossier", async () => {
  granted = [];
  const { container } = render(<ModuleFolders module="produits" name="Produits" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("folders.list", { module: "produits" }));
  expect(container.textContent).toBe("");
});
