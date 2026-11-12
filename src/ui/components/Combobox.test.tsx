import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Combobox, MultiSelectCombobox, SearchCombobox } from "./Combobox";
import { FormField } from "./FormControls";

function City() {
  const [city, setCity] = useState("");
  return (
    <FormField label="Ville" error="Saisissez une ville.">
      <Combobox value={city} options={["Lyon", "Paris"]} onChange={setCity} />
    </FormField>
  );
}

describe("Combobox dans un FormField", () => {
  it("relie le libellé, l’aide et l’erreur au champ sans `id` explicite", async () => {
    const user = userEvent.setup();
    render(<City />);
    const input = screen.getByRole("combobox", { name: "Ville" });
    expect(input).toHaveAccessibleDescription("Saisissez une ville.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.type(input, "Ly");
    expect(input).toHaveValue("Ly");
  });

  it("nomme SearchCombobox par le libellé du champ", () => {
    render(
      <FormField label="Contact" hint="Nom ou adresse.">
        <SearchCombobox
          label="Rechercher un contact"
          value=""
          options={[] as { id: number; name: string }[]}
          onChange={vi.fn()}
          onSelect={vi.fn()}
          getOptionKey={(option) => String(option.id)}
          getOptionLabel={(option) => option.name}
        />
      </FormField>,
    );
    const input = screen.getByRole("combobox", { name: "Contact" });
    expect(input).toHaveAccessibleDescription("Nom ou adresse.");
  });

  it("nomme MultiSelectCombobox par le libellé du champ, et par `label` hors d’un champ", () => {
    render(
      <>
        <FormField label="Étiquettes" error="Choisissez une étiquette.">
          <MultiSelectCombobox label="Étiquettes du devis" values={[]} options={["Client"]} onChange={vi.fn()} />
        </FormField>
        <MultiSelectCombobox label="Filtrer par état" values={[]} options={["Ouvert"]} onChange={vi.fn()} />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Étiquettes" })).toHaveAccessibleDescription(
      "Choisissez une étiquette.",
    );
    expect(screen.getByRole("combobox", { name: "Filtrer par état" })).toBeInTheDocument();
  });
});
