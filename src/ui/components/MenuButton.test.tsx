import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2 } from "lucide-react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { MenuGroup, MenuItem } from "./Menu";
import { MenuButton } from "./MenuButton";

describe("MenuButton", () => {
  it("ouvre un menu ancré, exécute l’entrée choisie puis rend le focus au bouton", async () => {
    const user = userEvent.setup();
    const exportCsv = vi.fn();
    render(
      <MenuButton label="Exporter" menuLabel="Formats d’export">
        <MenuItem onClick={exportCsv}>CSV</MenuItem>
        <MenuItem onClick={() => undefined}>JSON</MenuItem>
      </MenuButton>,
    );
    const trigger = screen.getByRole("button", { name: "Exporter" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const item = screen.getByRole("menuitem", { name: "CSV" });
    expect(screen.getByRole("menu", { name: "Formats d’export" })).toBeInTheDocument();
    expect(item).toHaveFocus();
    // Point de contrôle des microtâches d’un vrai clic, entre la capture et la remontée (voir OverflowMenu.test).
    item.addEventListener("click", () => flushSync(() => undefined));
    await user.click(item);
    expect(exportCsv).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("s’ouvre à la flèche bas et se ferme sur Échap", async () => {
    const user = userEvent.setup();
    render(
      <MenuButton label="Nouveau">
        <MenuItem onClick={() => undefined}>Tâche</MenuItem>
      </MenuButton>,
    );
    screen.getByRole("button", { name: "Nouveau" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Tâche" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nouveau" })).toHaveFocus();
  });

  it("marque une entrée destructrice et nomme ses groupes", async () => {
    const user = userEvent.setup();
    render(
      <MenuButton label="Actions">
        <MenuGroup label="Tâches terminées">
          <MenuItem tone="danger" onClick={() => undefined}>
            <Trash2 size={16} aria-hidden="true" />
            Supprimer
          </MenuItem>
        </MenuGroup>
      </MenuButton>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("group", { name: "Tâches terminées" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Supprimer" })).toHaveClass("ui-menu__item--danger");
  });
});
