import { render, screen } from "@testing-library/react";
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
  model = { model: "intfloat/multilingual-e5-small", status: "ready", error: null };
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "semantic.model") return model;
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("dit que le modèle est livré avec Alfred, sans rien à télécharger", async () => {
  render(<SemanticSection />);
  expect(await screen.findByText(/Livré avec Alfred : rien à télécharger/)).toBeInTheDocument();
  expect(screen.getByText("Prêt")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Télécharger/ })).not.toBeInTheDocument();
});

it("signale une installation à laquelle le modèle manque", async () => {
  model = { ...model, status: "missing" };
  render(<SemanticSection />);
  expect(await screen.findByText(/Le modèle manque à cette installation d’Alfred/)).toBeInTheDocument();
});

it("signale un modèle qui ne se charge pas", async () => {
  model = { ...model, status: "broken", error: "fichier illisible" };
  render(<SemanticSection />);
  expect(await screen.findByText(/n’a pas pu être chargé : fichier illisible/)).toBeInTheDocument();
});
