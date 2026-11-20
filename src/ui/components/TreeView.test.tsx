import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder, Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { type TreeNode, TreeView } from "./TreeView";

const folders: TreeNode[] = [
  { id: "/docs", label: "docs", icon: Folder, hasChildren: true },
  { id: "/src", label: "src", icon: Folder, children: [{ id: "/src/main.ts", label: "main.ts" }] },
  { id: "/README.md", label: "README.md" },
];

const item = (name: string) => screen.getByRole("treeitem", { name: new RegExp(`^${name}`) });

describe("TreeView", () => {
  it("se parcourt au clavier et charge les enfants à l’ouverture, avec erreur et nouvel essai", async () => {
    const user = userEvent.setup();
    let fail = true;
    const pending: Array<() => void> = [];
    const loadChildren = vi.fn(
      (node: TreeNode) =>
        new Promise<TreeNode[]>((resolve, reject) => {
          pending.push(() =>
            fail ? reject(new Error("Dossier illisible")) : resolve([{ id: `${node.id}/guide.md`, label: "guide.md" }]),
          );
        }),
    );
    render(<TreeView label="Dossiers" nodes={folders} loadChildren={loadChildren} />);

    expect(screen.getByRole("tree", { name: "Dossiers" })).toBeInTheDocument();
    await user.tab();
    expect(item("docs")).toHaveFocus();
    expect(item("docs")).toHaveAttribute("aria-expanded", "false");
    expect(item("README.md")).not.toHaveAttribute("aria-expanded");

    // Ouvrir un dossier non chargé : état de chargement, puis erreur et « Réessayer ».
    await user.keyboard("{ArrowRight}");
    expect(item("docs")).toHaveAttribute("aria-expanded", "true");
    expect(item("docs")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Chargement…")).toBeInTheDocument();
    await act(async () => pending.shift()?.());
    expect(screen.getByText("Dossier illisible")).toBeInTheDocument();
    expect(item("docs")).toHaveAccessibleDescription("Dossier illisible");

    fail = false;
    await user.keyboard("{ArrowRight}");
    await act(async () => pending.shift()?.());
    expect(loadChildren).toHaveBeenCalledTimes(2);
    expect(item("guide.md")).toHaveAttribute("aria-level", "2");

    await user.keyboard("{ArrowRight}");
    expect(item("guide.md")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(item("docs")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("treeitem", { name: "guide.md" })).not.toBeInTheDocument();

    await user.keyboard("{End}");
    expect(item("README.md")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("docs")).toHaveFocus();
    // Première lettre : « s » mène à src, « m » ne trouve rien tant que src est fermé.
    await user.keyboard("s");
    expect(item("src")).toHaveFocus();
    await user.keyboard("*");
    expect(item("src")).toHaveAttribute("aria-expanded", "true");
    expect(item("main.ts")).toHaveAttribute("aria-posinset", "1");
  });

  it("sélectionne plusieurs nœuds à la souris et au clavier, et propose les actions de la ligne", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const activate = vi.fn();
    const remove = vi.fn();
    render(
      <TreeView
        label="Secrets"
        selection="multiple"
        defaultExpanded={["/src"]}
        nodes={folders}
        onSelectedChange={change}
        onActivate={activate}
        actions={(node) => [
          { label: `Supprimer ${node.label}`, icon: Trash2, danger: true, onClick: () => remove(node.id) },
        ]}
      />,
    );
    expect(screen.getByRole("tree")).toHaveAttribute("aria-multiselectable", "true");

    await user.click(screen.getByText("docs"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(change).toHaveBeenLastCalledWith(["/docs", "/src", "/src/main.ts"]);
    await user.keyboard(" ");
    expect(change).toHaveBeenLastCalledWith(["/docs", "/src"]);
    await user.keyboard("{Control>}");
    await user.click(screen.getByText("README.md"));
    await user.keyboard("{/Control}");
    expect(item("README.md")).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(activate).toHaveBeenLastCalledWith(folders[2]);

    // Les actions suivent la ligne active dans l’ordre de tabulation, et leur clic ne sélectionne pas la ligne.
    await user.tab();
    expect(within(item("README.md")).getByRole("button", { name: "Supprimer README.md" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Supprimer docs" }));
    expect(remove).toHaveBeenCalledWith("/docs");
  });

  it("ne rend que les lignes à l’écran dans un grand arbre", async () => {
    const user = userEvent.setup();
    const nodes: TreeNode[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `secret-${index}`,
      label: `secret-${String(index).padStart(4, "0")}`,
    }));
    render(<TreeView label="Secrets" nodes={nodes} />);
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
    await user.tab();
    await user.keyboard("{End}");
    expect(item("secret-4999")).toHaveFocus();
    expect(item("secret-4999")).toHaveAttribute("aria-posinset", "5000");
    expect(item("secret-4999")).toHaveAttribute("aria-setsize", "5000");
  });
});
