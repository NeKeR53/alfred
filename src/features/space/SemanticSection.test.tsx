import { screen, waitFor } from "@testing-library/react";
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
import { type SemanticModel, useSemanticSection } from "./SemanticSection";
import { renderSections } from "./sections.test-helper";

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
  renderSections(() => [useSemanticSection()]);
  expect(await screen.findByText(/Environ 470 Mo à télécharger une seule fois/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Télécharger" }));
  await waitFor(() => expect(screen.getByText("Téléchargement en cours : 10 Mo sur 470 Mo")).toBeInTheDocument());
});

it("ne propose plus rien quand le modèle est installé, et en donne la version", async () => {
  model = { ...model, status: "ready", revision: "614241f" };
  renderSections(() => [useSemanticSection()]);
  expect(await screen.findByText(/Installé\..* Version 614241f\./)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Télécharger" })).not.toBeInTheDocument();
});

it("dit qu’une version du modèle n’est pas prise en charge, et propose de la retélécharger", async () => {
  const unsupported =
    "Modèle de recherche sémantique : la version 9da7038 du modèle intfloat/multilingual-e5-small n’est pas prise en charge par cette version d’Alfred (missing field `hidden_size`). Une mise à jour d’Alfred est nécessaire.";
  model = { ...model, status: "damaged", damaged: unsupported };
  renderSections(() => [useSemanticSection()]);
  expect(await screen.findByText(unsupported)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Télécharger à nouveau" })).toBeInTheDocument();
});
