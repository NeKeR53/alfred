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
import type { ModuleSummary } from "../../lib/types";
import { TeamSync } from "./TeamSync";

const carnet: ModuleSummary = {
  id: "carnet",
  name: "Carnet",
  version: "1.0.0",
  description: "",
  readOnly: false,
  origin: null,
  hidden: false,
  requires: [],
  requiredBy: [],
  pages: 1,
  functions: 0,
  clients: [],
  webhooks: [],
  schedules: [],
  sync: ["carnet_contacts"],
};

let linked: { url: string } | null;

beforeEach(() => {
  linked = null;
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    const status = () => ({
      module: "carnet",
      tables: ["carnet_contacts"],
      problems: [],
      link: linked
        ? { url: linked.url, lastSync: "2026-11-17T10:00:00Z", lastError: null, received: 3, sent: 1, conflicts: 0 }
        : null,
    });
    switch (command) {
      case "teamSync.status":
        return status();
      case "teamSync.link":
        linked = { url: String((args as { url: string }).url) };
        return { ...status(), outcome: { received: 3, sent: 1, conflicts: 0 } };
      case "teamSync.unlink":
        linked = null;
        return status();
      case "space.snapshot":
        return null;
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

it("relie un module au dépôt de l’équipe, montre la dernière synchronisation, puis arrête le partage", async () => {
  const user = userEvent.setup();
  render(<TeamSync module={carnet} />);
  expect(await screen.findByRole("heading", { name: "Partage en équipe" })).toBeInTheDocument();
  expect(screen.getByText(/Les données de carnet_contacts se partagent/)).toBeInTheDocument();

  await user.type(screen.getByLabelText("Adresse git du dépôt de l’équipe"), "git@exemple.fr:equipe/carnet.git");
  await user.click(screen.getByRole("button", { name: "Partager" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("teamSync.link", { module: "carnet", url: "git@exemple.fr:equipe/carnet.git" }),
  );
  expect(await screen.findByText("git@exemple.fr:equipe/carnet.git")).toBeInTheDocument();
  expect(screen.getByText(/3 lignes reçue\(s\), 1 ligne envoyée\(s\)/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Arrêter le partage" }));
  await user.click(screen.getAllByRole("button", { name: "Arrêter le partage" }).at(-1) as HTMLElement);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("teamSync.unlink", { module: "carnet" }));
  expect(await screen.findByLabelText("Adresse git du dépôt de l’équipe")).toBeInTheDocument();
});

it("n’apparaît pas pour un module qui ne partage aucune table", () => {
  const { container } = render(<TeamSync module={{ ...carnet, sync: [] }} />);
  expect(container).toBeEmptyDOMElement();
});
