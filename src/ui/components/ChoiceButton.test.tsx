import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ChoiceButton, ChoiceGroup } from "./ChoiceButton";

function Filters({ appearance }: { appearance?: "default" | "segmented" }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <ChoiceGroup label="Filtrer par état" appearance={appearance}>
      {["Toutes", "Ouvertes", "Terminées"].map((choice) => (
        <ChoiceButton
          key={choice}
          variant="label"
          label={choice}
          selected={value === choice}
          onClick={() => setValue(choice)}
        >
          {choice}
        </ChoiceButton>
      ))}
    </ChoiceGroup>
  );
}

function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <ChoiceButton label="Afficher les terminées" selected={on} onClick={() => setOn(!on)}>
      T
    </ChoiceButton>
  );
}

describe("ChoiceGroup et ChoiceButton", () => {
  it("transmet le mode radio aux boutons et suit les flèches", async () => {
    const user = userEvent.setup();
    render(<Filters />);
    const group = screen.getByRole("radiogroup", { name: "Filtrer par état" });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);

    // Sans choix actif, le premier reste joignable par Tab.
    await user.tab();
    expect(screen.getByRole("radio", { name: "Toutes" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Ouvertes" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Ouvertes" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Terminées" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Ouvertes" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "Terminées" })).toHaveAttribute("tabindex", "0");
  });

  it("offre l’apparence segmentée par une prop", () => {
    render(<Filters appearance="segmented" />);
    expect(screen.getByRole("radiogroup")).toHaveClass("choice-segmented");
  });

  it("reste une bascule hors d’un groupe", async () => {
    const user = userEvent.setup();
    render(<Toggle />);
    const button = screen.getByRole("button", { name: "Afficher les terminées" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("donne les rôles d’onglets en mode tab", () => {
    render(
      <ChoiceGroup label="Rubriques" selectionMode="tab">
        <ChoiceButton variant="label" label="Résumé" selected onClick={() => undefined}>
          Résumé
        </ChoiceButton>
        <ChoiceButton variant="label" label="Historique" selected={false} onClick={() => undefined}>
          Historique
        </ChoiceButton>
      </ChoiceGroup>,
    );
    expect(screen.getByRole("tablist", { name: "Rubriques" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Résumé" })).toHaveAttribute("aria-selected", "true");
  });
});
