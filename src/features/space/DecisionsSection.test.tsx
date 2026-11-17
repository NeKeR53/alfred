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
import { type DecisionsModel, DecisionsSection } from "./DecisionsSection";

let model: DecisionsModel;

beforeEach(() => {
  model = {
    model: "convaiinnovations/laya-multilingual",
    sizeMb: 647,
    status: "missing",
    received: null,
    total: null,
    error: null,
    damaged: null,
  };
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "decisions.model") return model;
    if (command === "decisions.download") {
      model = { ...model, status: "downloading", received: 10 * 1024 * 1024, total: 647 * 1024 * 1024 };
      return model;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("annonce la taille, puis télécharge le modèle à la demande", async () => {
  const user = userEvent.setup();
  render(<DecisionsSection />);
  expect(await screen.findByText(/Environ 647 Mo à télécharger une seule fois/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Télécharger" }));
  await waitFor(() => expect(screen.getByText("Téléchargement en cours : 10 Mo sur 647 Mo")).toBeInTheDocument());
});

it("dit le modèle prêt, sans bouton", async () => {
  model = { ...model, status: "ready" };
  render(<DecisionsSection />);
  expect(await screen.findByText(/Prêt\./)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Télécharger/ })).not.toBeInTheDocument();
});

it("propose de retélécharger un modèle abîmé", async () => {
  model = { ...model, status: "damaged", damaged: "model.safetensors est abîmé" };
  render(<DecisionsSection />);
  expect(await screen.findByText(/Le modèle est abîmé/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Télécharger à nouveau" })).toBeInTheDocument();
});
