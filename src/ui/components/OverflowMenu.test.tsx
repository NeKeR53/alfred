import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { MenuItem } from "./Menu";
import { OverflowMenu } from "./OverflowMenu";

describe("OverflowMenu", () => {
  it("exécute l’action d’une entrée choisie à la souris, puis ferme le menu et rend le focus au bouton", async () => {
    const user = userEvent.setup();
    const exporter = vi.fn();
    render(
      <OverflowMenu label="Autres actions">
        <MenuItem onClick={exporter}>Exporter</MenuItem>
      </OverflowMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Autres actions" });
    await user.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Exporter" });
    // Un vrai clic laisse passer les microtâches entre l’écoute en capture et celle en remontée : React y applique
    // les mises à jour en attente. jsdom ne le fait pas pour un clic simulé ; on reproduit ce point de contrôle sur
    // la cible, entre les deux phases. Un menu fermé en capture serait alors démonté avant l’action.
    item.addEventListener("click", () => flushSync(() => undefined));
    await user.click(item);
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("laisse le focus là où l’action l’a placé (champ de renommage)", async () => {
    const user = userEvent.setup();
    const field = document.createElement("input");
    document.body.append(field);
    render(
      <OverflowMenu label="Autres actions">
        <MenuItem onClick={() => field.focus()}>Renommer</MenuItem>
      </OverflowMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Autres actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Renommer" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(field).toHaveFocus();
    field.remove();
  });

  it("exécute l’action d’une entrée choisie au clavier", async () => {
    const user = userEvent.setup();
    const archiver = vi.fn();
    render(
      <OverflowMenu label="Autres actions">
        <MenuItem onClick={() => undefined}>Exporter</MenuItem>
        <MenuItem onClick={archiver}>Archiver</MenuItem>
      </OverflowMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Autres actions" }));
    expect(screen.getByRole("menuitem", { name: "Exporter" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(archiver).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("ferme sur Échap et sur un clic à côté sans rien exécuter", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(
      <>
        <p>Ailleurs</p>
        <OverflowMenu label="Autres actions">
          <MenuItem onClick={action}>Exporter</MenuItem>
        </OverflowMenu>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Autres actions" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByText("Ailleurs"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
