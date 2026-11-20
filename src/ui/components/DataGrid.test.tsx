import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

/** L’exemple « matrice » de DESIGN.md : une ligne par secret, une colonne par environnement. */
const environments = ["dev", "staging", "prod"] as const;
interface SecretRow {
  name: string;
  in: Record<string, boolean>;
}

function Matrix({ onToggle }: { onToggle: (name: string, env: string, present: boolean) => void }) {
  const [rows, setRows] = useState<SecretRow[]>([
    { name: "DATABASE_URL", in: { dev: true, staging: true, prod: true } },
    { name: "STRIPE_KEY", in: { dev: true, staging: false, prod: false } },
  ]);
  const columns: DataTableColumn<SecretRow>[] = [
    { key: "name", header: "Secret", frozen: true, rowHeader: true, width: "200px" },
    ...environments.map(
      (env): DataTableColumn<SecretRow> => ({
        key: env,
        header: env,
        width: "96px",
        sortValue: (row) => (row.in[env] ? 1 : 0),
        editor: {
          type: "check",
          labels: { on: "Présent", off: "Absent" },
          value: (row) => row.in[env] ?? false,
          onCommit: (row, present) => {
            onToggle(row.name, env, present);
            setRows((current) =>
              current.map((other) =>
                other.name === row.name ? { ...other, in: { ...other.in, [env]: present } } : other,
              ),
            );
          },
        },
      }),
    ),
  ];
  return (
    <DataTable
      variant="grid"
      label="Secrets par environnement"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.name}
    />
  );
}

interface Person {
  id: number;
  name: string;
  role: string;
  city: string;
}
const people: Person[] = [
  { id: 1, name: "Léa", role: "admin", city: "Lyon" },
  { id: 2, name: "Hugo", role: "lecture", city: "Paris" },
  { id: 3, name: "Anaïs", role: "admin", city: "Paris" },
];
const roles = [
  { value: "admin", label: "Administration" },
  { value: "lecture", label: "Lecture" },
];

describe("DataTable en grille", () => {
  it("matrice : se parcourt cellule par cellule et bascule les cases au clic, à Espace et à Entrée", async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(<Matrix onToggle={toggle} />);
    const grid = screen.getByRole("grid", { name: "Secrets par environnement" });
    expect(
      within(grid)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["DATABASE_URL", "STRIPE_KEY"]);

    await user.tab();
    expect(screen.getByRole("rowheader", { name: "DATABASE_URL" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowRight}");
    const staging = screen.getAllByRole("checkbox", { name: /^staging/ })[1];
    expect(staging).toHaveFocus();
    expect(staging).toHaveAccessibleName("staging : Absent");
    await user.keyboard(" ");
    expect(toggle).toHaveBeenLastCalledWith("STRIPE_KEY", "staging", true);
    expect(screen.getAllByRole("checkbox", { name: /^staging/ })[1]).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}{Enter}");
    expect(toggle).toHaveBeenLastCalledWith("STRIPE_KEY", "prod", true);
    await user.click(screen.getAllByRole("checkbox", { name: /^dev/ })[0]);
    expect(toggle).toHaveBeenLastCalledWith("DATABASE_URL", "dev", false);
    await user.keyboard("{Control>}{End}{/Control}");
    expect(screen.getAllByRole("checkbox", { name: /^prod/ })[1]).toHaveFocus();
    // Une seule tabulation pour toute la grille.
    await user.keyboard("{Control>}{Home}{/Control}");
    expect(screen.getByRole("rowheader", { name: "DATABASE_URL" })).toHaveFocus();
    // L’en-tête fait partie de la grille : flèche haut, puis Entrée trie la colonne.
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(screen.getByRole("button", { name: "dev" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("columnheader", { name: "dev" })).toHaveAttribute("aria-sort", "ascending");
    expect(
      within(grid)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });

  it("édite une cellule : Entrée ouvre, la validation refuse, Échap annule, l’échec reste sur la cellule", async () => {
    const user = userEvent.setup();
    const rename = vi.fn((_row: Person, value: string) =>
      value === "Bob" ? Promise.reject(new Error("Nom déjà pris")) : undefined,
    );
    const changeRole = vi.fn();
    const columns: DataTableColumn<Person>[] = [
      {
        key: "name",
        header: "Nom",
        editor: {
          type: "text",
          validate: (value) => (value.trim() ? null : "Le nom est obligatoire."),
          onCommit: rename,
        },
      },
      { key: "role", header: "Rôle", editor: { type: "choice", options: roles, onCommit: changeRole } },
    ];
    render(<DataTable variant="grid" label="Membres" columns={columns} rows={people} rowKey={(row) => row.id} />);

    await user.tab();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Nom" });
    expect(input).toHaveValue("Léa");
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Le nom est obligatoire.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByRole("gridcell", { name: "Léa" })).toHaveFocus();

    // Une lettre tapée ouvre la saisie avec elle.
    await user.keyboard("Bob{Enter}");
    expect(rename).toHaveBeenCalledWith(people[0], "Bob");
    const failed = await screen.findByRole("gridcell", { name: /Échec : Nom déjà pris/ });
    expect(failed).toHaveAttribute("aria-invalid", "true");

    await user.keyboard("{ArrowRight}{Enter}");
    await user.selectOptions(screen.getByRole("combobox", { name: "Rôle" }), "lecture");
    expect(changeRole).toHaveBeenCalledWith(people[0], "lecture");
    expect(screen.queryByRole("combobox", { name: "Rôle" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("gridcell", { name: "Administration" })[0]).toHaveFocus();
  });

  it("cumule filtres et tris, en liste comme en grille", async () => {
    const user = userEvent.setup();
    const columns: DataTableColumn<Person>[] = [
      { key: "name", header: "Nom", filter: { type: "text" } },
      { key: "role", header: "Rôle", filter: { type: "choice", options: roles } },
      { key: "city", header: "Ville" },
    ];
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).queryAllByRole("cell")[0]?.textContent)
        .filter(Boolean);
    const { rerender } = render(<DataTable label="Membres" columns={columns} rows={people} rowKey={(row) => row.id} />);

    await user.click(screen.getByRole("button", { name: "Ville" }));
    await user.click(screen.getByRole("button", { name: "Nom" }));
    expect(names()).toEqual(["Anaïs", "Hugo", "Léa"]);
    await user.click(screen.getByRole("button", { name: "Ville" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Nom" }));
    await user.keyboard("{/Shift}");
    expect(names()).toEqual(["Léa", "Anaïs", "Hugo"]);
    expect(screen.getByRole("columnheader", { name: /Ville/ })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: /Nom/ })).toHaveAttribute("aria-sort", "none");

    await user.selectOptions(screen.getByRole("combobox", { name: "Filtrer rôle" }), "admin");
    expect(names()).toEqual(["Léa", "Anaïs"]);
    await user.type(screen.getByRole("searchbox", { name: "Filtrer nom" }), "anais");
    expect(names()).toEqual(["Anaïs"]);
    await user.type(screen.getByRole("searchbox", { name: "Filtrer nom" }), "x");
    expect(screen.getByText("Aucun résultat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    expect(names()).toHaveLength(3);

    rerender(<DataTable variant="grid" label="Membres" columns={columns} rows={people} rowKey={(row) => row.id} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Filtrer rôle" }), "lecture");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("gridcell", { name: "Hugo" })).toBeInTheDocument();
  });

  it("ne rend que les lignes à l’écran d’une grande grille, et y amène la cellule au clavier", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: index, name: `Ligne ${index + 1}` }));
    render(
      <DataTable
        variant="grid"
        label="Journal"
        columns={[{ key: "name", header: "Nom", frozen: true }]}
        rows={rows}
        rowKey={(row) => row.id}
      />,
    );
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "5001");
    expect(within(grid).getAllByRole("row").length).toBeLessThan(80);
    await user.tab();
    await user.keyboard("{Control>}{End}{/Control}");
    const last = screen.getByRole("gridcell", { name: "Ligne 5000" });
    expect(last).toHaveFocus();
    expect(last.closest("tr")).toHaveAttribute("aria-rowindex", "5001");
  });
});
