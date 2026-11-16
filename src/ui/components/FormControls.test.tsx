import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField, SelectControl, TextInput } from "./FormControls";
import { Page, Row } from "./page";

const wrapperOf = (select: HTMLElement) => select.closest("[data-slot='native-select-wrapper']");

describe("Largeur des champs", () => {
  it("dans une page, une liste prend la largeur de ses options et un champ hors formulaire 240 px", () => {
    render(
      <Page>
        <Row>
          <SelectControl aria-label="Tri">
            <option>Échéance</option>
          </SelectControl>
          <TextInput aria-label="Code" />
        </Row>
        <FormField label="Nom">
          <TextInput />
        </FormField>
        <SelectControl aria-label="Dossier" width="full">
          <option>Boîte de réception</option>
        </SelectControl>
      </Page>,
    );
    expect(wrapperOf(screen.getByRole("combobox", { name: "Tri" }))).toHaveAttribute("data-width", "auto");
    expect(screen.getByRole("textbox", { name: "Code" })).toHaveAttribute("data-width", "md");
    expect(screen.getByRole("textbox", { name: "Nom" })).toHaveAttribute("data-width", "full");
    expect(wrapperOf(screen.getByRole("combobox", { name: "Dossier" }))).toHaveAttribute("data-width", "full");
  });

  it("hors page (coquille), les champs gardent toute la largeur", () => {
    render(
      <>
        <SelectControl aria-label="Modèle">
          <option>Opus</option>
        </SelectControl>
        <TextInput aria-label="Recherche" />
      </>,
    );
    expect(wrapperOf(screen.getByRole("combobox", { name: "Modèle" }))).toHaveAttribute("data-width", "full");
    expect(screen.getByRole("textbox", { name: "Recherche" })).toHaveAttribute("data-width", "full");
  });
});
