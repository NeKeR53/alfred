import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../dialog.test-helper";
import { type FrameServices, FrameServicesContext } from "../templates/services";
import { DataTable, type DataTableColumn } from "./DataTable";
import { Page } from "./page";

beforeAll(() => {
  installDialogPolyfill();
  // jsdom n’a pas l’API Popover des infobulles.
  HTMLElement.prototype.showPopover ??= () => undefined;
  HTMLElement.prototype.hidePopover ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
const noop = () => undefined;
const frame: FrameServices = {
  notify: vi.fn(),
  publish: noop,
  setPanelVisible: noop,
  openExternal: noop,
  send: noop,
  onPeer: () => noop,
  onSelection: () => noop,
};

interface Variable {
  id: string;
  secret: string;
  nom: string;
}
const variables: Variable[] = [
  { id: "a", secret: "atom/api", nom: "DB_PASSWORD" },
  { id: "b", secret: "atom/api", nom: "DB_USER" },
  { id: "c", secret: "atom/web", nom: "OIDC_ID" },
];
const columns: DataTableColumn<Variable>[] = [{ key: "nom", header: "Variable" }];

function Selection() {
  const [selected, setSelected] = useState<Array<string | number>>([]);
  return (
    <>
      <DataTable
        variant="grid"
        label="Variables"
        columns={columns}
        rows={variables}
        rowKey={(v) => v.id}
        selection={{ selected, onChange: setSelected }}
      />
      <output>{selected.join(",")}</output>
    </>
  );
}

describe("variantes de la grille", () => {
  it("sans cadre : la grille porte sa classe, sans changer le reste", () => {
    const { container } = render(
      <DataTable
        variant="grid"
        appearance="plain"
        label="Variables"
        columns={columns}
        rows={variables}
        rowKey={(v) => v.id}
      />,
    );
    expect(container.querySelector(".al-datagrid-frame")).toHaveClass("al-datagrid-frame--plain");
  });

  it("groupes : une ligne de titre avec son compteur, qui se replie au clic et au clavier", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        variant="grid"
        label="Variables"
        columns={columns}
        rows={variables}
        rowKey={(v) => v.id}
        onRowClick={onRowClick}
        groups={{ by: (v) => v.secret }}
      />,
    );
    const api = screen.getByRole("gridcell", { name: /atom\/api, 2 lignes, déplié/ });
    expect(api).toHaveAttribute("aria-expanded", "true");
    await user.click(api);
    expect(screen.queryByText("DB_USER")).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole("gridcell", { name: /atom\/api, 2 lignes, replié/ })).toBeInTheDocument();
    screen.getByRole("gridcell", { name: /atom\/api/ }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("DB_USER")).toBeInTheDocument();
    await user.click(screen.getByText("OIDC_ID"));
    expect(onRowClick).toHaveBeenCalledWith(variables[2]);
  });

  it("sélection : une case par ligne (clic, Espace) et « Tout sélectionner »", async () => {
    const user = userEvent.setup();
    render(<Selection />);
    const cases = screen.getAllByRole("checkbox", { name: /Non sélectionnée/ });
    expect(cases).toHaveLength(3);
    await user.click(cases[0]);
    expect(document.querySelector("output")).toHaveTextContent("a");
    screen.getAllByRole("checkbox", { name: /Non sélectionnée/ })[0].focus();
    await user.keyboard(" ");
    expect(document.querySelector("output")).toHaveTextContent("a,b");
    await user.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
    expect(document.querySelector("output")).toHaveTextContent("a,b,c");
    await user.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
    expect(document.querySelector("output")).toHaveTextContent("");
  });

  it("action de ligne directe : corbeille rouge, confirmée avant de s’exécuter", async () => {
    const user = userEvent.setup();
    const supprimer = vi.fn();
    render(
      <FrameServicesContext.Provider value={frame}>
        <Page>
          <DataTable
            variant="grid"
            label="Variables"
            columns={columns}
            rows={variables}
            rowKey={(v) => v.id}
            rowAction={(v) => ({
              label: "Supprimer",
              danger: true,
              confirm: `Supprimer ${v.nom} ?`,
              onClick: () => supprimer(v.id),
            })}
          />
        </Page>
      </FrameServicesContext.Provider>,
    );
    const bouton = screen.getByRole("button", { name: "Supprimer : DB_USER" });
    expect(bouton).toHaveClass("button--danger");
    await user.click(bouton);
    expect(supprimer).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(supprimer).toHaveBeenCalledWith("b"));
  });

  it("la corbeille d’une ligne est rouge au repos : la règle danger l’emporte sur la couleur atténuée des icônes", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");
    const attenuee = css.indexOf(".table-icon-action {");
    const rouge = css.indexOf(".table-icon-action.button--danger");
    expect(attenuee).toBeGreaterThan(-1);
    expect(rouge).toBeGreaterThan(attenuee);
  });
});
