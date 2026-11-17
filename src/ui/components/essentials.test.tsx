import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Avatar, Pagination, ProgressBar, pageOf } from "./Essentials";
import { TagSearchField } from "./TagSearchField";

function Tags({ free = true }: { free?: boolean }) {
  const [tags, setTags] = useState<string[]>([]);
  return (
    <>
      <TagSearchField
        label="Rechercher un contact"
        tags={tags}
        onTagsChange={setTags}
        suggestions={["Paris", "Lyon", "Écully"]}
        allowFreeText={free}
      />
      <output>{tags.join("|")}</output>
    </>
  );
}

describe("TagSearchField", () => {
  it("propose pendant la frappe, pose une étiquette à Entrée et la retire", async () => {
    const user = userEvent.setup();
    render(<Tags />);
    const field = screen.getByRole("combobox", { name: "Rechercher un contact" });
    // Sans accents ni casse.
    await user.type(field, "ecu");
    const list = screen.getByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Écully"]);
    // Autocomplétion : Entrée prend la première suggestion.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Écully");
    // Texte libre : sans suggestion qui corresponde, Entrée pose le texte saisi ; Échap le permet aussi.
    await user.type(field, "dupont{Enter}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Écully|dupont");
    await user.type(field, "par{Escape}{Enter}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Écully|dupont|par");
    await user.type(field, "{Backspace}");
    // Une étiquette posée n’est plus proposée ; la croix la retire ; Retour arrière retire la dernière.
    await user.click(screen.getByRole("button", { name: "Retirer Écully" }));
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("dupont");
    await user.type(field, "{Backspace}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("");
  });

  it("sans texte libre, n’accepte que les suggestions", async () => {
    const user = userEvent.setup();
    render(<Tags free={false} />);
    await user.type(screen.getByRole("combobox"), "inconnu{Enter}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("");
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "lyo{Enter}");
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Lyon");
  });
});

describe("Pagination", () => {
  it("dit la tranche affichée et bloque les flèches aux bouts", async () => {
    const user = userEvent.setup();
    const pages: number[] = [];
    const { rerender } = render(
      <Pagination page={1} pageSize={50} total={312} onChange={(page) => pages.push(page)} />,
    );
    expect(screen.getByText("1–50 sur 312")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page précédente" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Page suivante" }));
    expect(pages).toEqual([2]);
    rerender(<Pagination page={7} pageSize={50} total={312} onChange={() => {}} />);
    expect(screen.getByText("301–312 sur 312")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page suivante" })).toHaveProperty("disabled", true);
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
  });
});

describe("ProgressBar et Avatar", () => {
  it("expose la progression et les initiales", () => {
    render(
      <>
        <ProgressBar label="Import des contacts" value={42} />
        <ProgressBar label="Espace utilisé" value={30} max={120} />
        <Avatar name="Léa Martin" />
        <Avatar name="Paul Durand 12" />
      </>,
    );
    expect(screen.getByRole("progressbar", { name: "Import des contacts" }).getAttribute("aria-valuetext")).toBe(
      "42 %",
    );
    expect(screen.getByText("30 / 120")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Léa Martin" }).textContent).toBe("LM");
    expect(screen.getByRole("img", { name: "Paul Durand 12" }).textContent).toBe("PD");
  });
});
