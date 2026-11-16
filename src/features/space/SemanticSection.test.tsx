import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { invoke, onNativeEvent } from "../../lib/native";
import { type SemanticModel, SemanticSection } from "./SemanticSection";

let model: SemanticModel;

beforeEach(() => {
  model = {
    model: "intfloat/multilingual-e5-small",
    sizeMb: 470,
    status: "missing",
    received: null,
    total: null,
    error: null,
  };
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "semantic.model") return model;
    if (command === "semantic.download") {
      model = { ...model, status: "downloading", received: 10 * 1024 * 1024, total: 470 * 1024 * 1024 };
      return model;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("annonce la taille, puis télécharge le modèle à la demande", async () => {
  const user = userEvent.setup();
  render(<SemanticSection />);
  expect(await screen.findByText(/Environ 470 Mo à télécharger une seule fois/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Télécharger" }));
  await waitFor(() => expect(screen.getByText("Téléchargement en cours : 10 Mo sur 470 Mo")).toBeInTheDocument());
});

it("ne propose plus rien quand le modèle est installé", async () => {
  model = { ...model, status: "ready" };
  render(<SemanticSection />);
  expect(await screen.findByText(/Installé/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Télécharger" })).not.toBeInTheDocument();
});
