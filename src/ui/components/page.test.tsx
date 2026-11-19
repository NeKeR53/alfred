import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { KeyValueList, Page, Surface } from "./page";

describe("KeyValueList", () => {
  it("affiche deux libellés identiques sans avertissement de clé", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <KeyValueList
        items={[
          { label: "Téléphone", value: "01 23 45 67 89" },
          { label: "Téléphone", value: "06 12 34 56 78" },
        ]}
      />,
    );
    expect(screen.getAllByText("Téléphone")).toHaveLength(2);
    expect(screen.getByText("06 12 34 56 78")).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("LoadingSkeleton", () => {
  it("apparaît après 200 ms dans Page, sans marge propre", () => {
    vi.useFakeTimers();
    render(
      <Page>
        <LoadingSkeleton variant="page" label="Chargement des tâches…" />
      </Page>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    const skeleton = screen.getByRole("status", { name: "Chargement des tâches…" });
    expect(skeleton.closest(".al-page__body")).not.toBeNull();
    vi.useRealTimers();
  });
});

describe("Surface", () => {
  it("rend son pied en dernier, dans la zone collée au bas de la surface", () => {
    const { container } = render(
      <Surface footer={<span>Build n° 12</span>}>
        <p>Contenu</p>
      </Surface>,
    );
    const surface = container.querySelector(".al-surface");
    const pied = surface?.lastElementChild;
    expect(pied).toHaveClass("al-surface__footer");
    expect(pied).toHaveTextContent("Build n° 12");
  });

  it("n’a pas de pied sans footer", () => {
    const { container } = render(<Surface>Contenu</Surface>);
    expect(container.querySelector(".al-surface__footer")).toBeNull();
  });
});
