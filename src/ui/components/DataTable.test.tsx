import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Star } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

interface Task {
  id: number;
  title: string;
  hours: number;
  tags: string[];
}

const rows: Task[] = [
  { id: 1, title: "Relancer le client", hours: 3, tags: ["Client"] },
  { id: 2, title: "Archiver les devis", hours: 1, tags: [] },
];

const bodyTitles = () =>
  within(screen.getAllByRole("rowgroup")[1])
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("DataTable", () => {
  it("active la ligne au clic et à Entrée, mais pas depuis un bouton ou un champ d’une cellule", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const remove = vi.fn();
    const columns: DataTableColumn<Task>[] = [
      { key: "title", header: "Titre" },
      {
        key: "actions",
        header: "Actions",
        render: (task) => (
          <>
            <button type="button" onClick={() => remove(task.id)}>
              Supprimer {task.title}
            </button>
            <input aria-label={`Note de ${task.title}`} />
          </>
        ),
      },
    ];
    render(<DataTable label="Tâches" columns={columns} rows={rows} rowKey={(task) => task.id} onRowClick={open} />);

    await user.click(screen.getByRole("button", { name: "Supprimer Relancer le client" }));
    expect(remove).toHaveBeenCalledWith(1);
    expect(open).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Supprimer Archiver les devis" }).focus();
    await user.keyboard("{Enter}");
    expect(remove).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("textbox", { name: "Note de Relancer le client" }));
    await user.keyboard("a {Enter}");
    expect(open).not.toHaveBeenCalled();

    await user.click(screen.getByText("Archiver les devis"));
    expect(open).toHaveBeenCalledWith(rows[1]);
    screen.getByText("Relancer le client").closest("tr")!.focus();
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenLastCalledWith(rows[0]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("trie les colonnes simples ; une colonne sans valeur simple ni sortValue a un en-tête texte", async () => {
    const user = userEvent.setup();
    const columns: DataTableColumn<Task>[] = [
      { key: "title", header: "Titre" },
      { key: "hours", header: "Heures", align: "end" },
      { key: "tags", header: "Étiquettes", render: (task) => task.tags.join(", ") },
      { key: "fixed", header: "Fixe", sortable: false, render: () => "—" },
    ];
    render(<DataTable label="Tâches" columns={columns} rows={rows} rowKey={(task) => task.id} />);

    expect(screen.queryByRole("button", { name: "Étiquettes" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Étiquettes" })).not.toHaveAttribute("aria-sort");
    expect(screen.queryByRole("button", { name: "Fixe" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Heures" }));
    expect(screen.getByRole("columnheader", { name: "Heures" })).toHaveAttribute("aria-sort", "ascending");
    expect(bodyTitles()).toEqual(["Archiver les devis", "Relancer le client"]);
    await user.click(screen.getByRole("button", { name: "Heures" }));
    expect(bodyTitles()).toEqual(["Relancer le client", "Archiver les devis"]);
  });

  it("nomme une colonne dont l’en-tête est une icône par headerLabel", async () => {
    const user = userEvent.setup();
    const columns: DataTableColumn<Task>[] = [
      { key: "title", header: "Titre" },
      {
        key: "hours",
        header: <Star size={16} aria-hidden="true" />,
        headerLabel: "Priorité",
        sortValue: (task) => task.hours,
      },
    ];
    render(<DataTable label="Tâches" columns={columns} rows={rows} rowKey={(task) => task.id} />);
    expect(screen.getByRole("columnheader", { name: "Priorité" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Priorité" }));
    expect(bodyTitles()).toEqual(["Archiver les devis", "Relancer le client"]);
  });

  it("propose l’action de l’état vide", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    render(
      <DataTable
        label="Tâches"
        columns={[{ key: "title", header: "Titre" }]}
        rows={[] as Task[]}
        rowKey={(task) => task.id}
        emptyTitle="Aucun résultat"
        emptyAction={
          <button type="button" onClick={clear}>
            Effacer la recherche
          </button>
        }
      />,
    );
    expect(screen.getByText("Aucun résultat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Effacer la recherche" }));
    expect(clear).toHaveBeenCalled();
  });
});
