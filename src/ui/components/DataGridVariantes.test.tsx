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

  it("densité compacte : la grille porte sa classe ; sans elle, rien ne change", () => {
    const { container, rerender } = render(
      <DataTable
        variant="grid"
        density="compact"
        label="Variables"
        columns={columns}
        rows={variables}
        rowKey={(v) => v.id}
      />,
    );
    expect(container.querySelector(".al-datagrid-frame")).toHaveClass("al-datagrid-frame--compact");
    rerender(<DataTable variant="grid" label="Variables" columns={columns} rows={variables} rowKey={(v) => v.id} />);
    expect(container.querySelector(".al-datagrid-frame")).not.toHaveClass("al-datagrid-frame--compact");
  });

  it("en-tête texte : le libellé est dans une étiquette qui se termine par « … »", () => {
    const { container } = render(
      <DataTable variant="grid" label="Variables" columns={columns} rows={variables} rowKey={(v) => v.id} />,
    );
    expect(container.querySelector("th .al-table__label")).toHaveTextContent("Variable");
  });

  it("groupes en texte : titre puis « · 2 variables », sans chevron, et le clic replie toujours", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable
        variant="grid"
        label="Variables"
        columns={columns}
        rows={variables}
        rowKey={(v) => v.id}
        groups={{ by: (v) => v.secret, appearance: "text", countLabel: (n) => `${n} variable${n > 1 ? "s" : ""}` }}
      />,
    );
    const groupe = screen.getByRole("gridcell", { name: /atom\/api, 2 lignes/ });
    expect(groupe).toHaveTextContent("atom/api· 2 variables");
    expect(groupe.closest("tr")).toHaveClass("al-datagrid__group--text");
    expect(groupe.querySelector("svg")).toBeNull();
    await user.click(groupe);
    expect(screen.queryByText("DB_USER")).not.toBeInTheDocument();
    expect(container.querySelectorAll("tr.al-datagrid__group--text")).toHaveLength(2);
  });

  it("cases teintées : `fill` teinte la case, `frame` y pose un cadre ; une ligne sans teinte reste neutre", () => {
    const { container } = render(
      <DataTable
        variant="grid"
        label="Variables"
        columns={[
          { key: "nom", header: "Variable" },
          {
            key: "prod",
            header: "Production",
            render: (v) => v.nom,
            tone: (v) => (v.id === "a" ? "danger" : undefined),
          },
          {
            key: "etat",
            header: "État",
            render: (v) => v.id,
            toneStyle: "frame",
            tone: (v) => (v.id === "b" ? "warning" : undefined),
          },
        ]}
        rows={variables}
        rowKey={(v) => v.id}
      />,
    );
    const lignes = container.querySelectorAll("tbody tr");
    expect(lignes[0].children[1]).toHaveClass("al-datagrid__cell--fill", "al-datagrid__cell--tone-danger");
    expect(lignes[1].children[1]).not.toHaveClass("al-datagrid__cell--tone-danger");
    expect(lignes[1].children[2]).toHaveClass("al-datagrid__cell--frame", "al-datagrid__cell--tone-warning");
    expect(lignes[1].children[2].querySelector(".al-datagrid__frame")).toHaveTextContent("b");
    expect(lignes[0].children[2].querySelector(".al-datagrid__frame")).not.toBeNull();
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

  it("menu de case : clic ou Entrée ouvrent un menu ancré (titre, groupe, entrées) ; une case sans menu est inerte", async () => {
    const user = userEvent.setup();
    const logs = vi.fn();
    render(
      <FrameServicesContext.Provider value={frame}>
        <Page>
          <DataTable
            variant="grid"
            label="Variables"
            columns={[
              { key: "nom", header: "Variable" },
              {
                key: "env",
                header: "Recette",
                render: (v) => (v.id === "c" ? "—" : "1.2.0"),
                cellTitle: (v) => `${v.nom} · registre/atom:1.2.0`,
                menu: (v) =>
                  v.id === "c"
                    ? undefined
                    : {
                        label: `Actions pour ${v.nom}`,
                        title: `${v.nom} · Recette`,
                        group: "En marche",
                        items: [
                          { label: "Voir les logs", onClick: () => logs(v.id) },
                          { label: "Ouvrir une console", disabled: true, onClick: noop },
                        ],
                      },
              },
            ]}
            rows={variables}
            rowKey={(v) => v.id}
          />
        </Page>
      </FrameServicesContext.Provider>,
    );
    const cases = screen.getAllByRole("gridcell").filter((td) => td.getAttribute("aria-colindex") === "2");
    expect(cases[0]).toHaveAttribute("aria-haspopup", "menu");
    expect(cases[0]).toHaveAttribute("aria-expanded", "false");
    expect(cases[0]).toHaveAttribute("title", "DB_PASSWORD · registre/atom:1.2.0");
    expect(cases[2]).toHaveAttribute("aria-disabled", "true");
    expect(cases[2]).not.toHaveAttribute("aria-haspopup");

    await user.click(cases[0]);
    const menu = await screen.findByRole("menu", { name: "Actions pour DB_PASSWORD" });
    expect(menu).toHaveTextContent("DB_PASSWORD · Recette");
    expect(screen.getByRole("group", { name: "En marche" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ouvrir une console" })).toBeDisabled();
    expect(cases[0]).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("menuitem", { name: "Voir les logs" }));
    await waitFor(() => expect(logs).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Au clavier : Entrée sur la case ouvre le menu, Échap le ferme et rend le focus à la case.
    cases[1].focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu", { name: "Actions pour DB_USER" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(cases[1]).toHaveFocus();

    // Une case sans menu ne l’ouvre pas.
    await user.click(cases[2]);
    expect(screen.queryByRole("menu")).toBeNull();
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
