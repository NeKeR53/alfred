import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pencil } from "lucide-react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DataTable } from "../components/DataTable";
import { Page, Text } from "../components/page";
import { installDialogPolyfill } from "../dialog.test-helper";
import { openModal } from "./dialogs";
import { type FrameServices, FrameServicesContext } from "./services";
import { openSubpage } from "./subpages";

beforeAll(installDialogPolyfill);

const noop = () => undefined;
const services = (): FrameServices => ({
  notify: vi.fn(),
  publish: vi.fn(),
  setPanelVisible: vi.fn(),
  openExternal: noop,
  send: vi.fn(),
  onPeer: () => noop,
  onSelection: () => noop,
});

describe("openModal", () => {
  it("montre le contenu, ferme après une action réussie et le dit à l’appelant", async () => {
    const user = userEvent.setup();
    const frame = services();
    render(
      <FrameServicesContext.Provider value={frame}>
        <Page>
          <Text>Liste</Text>
        </Page>
      </FrameServicesContext.Provider>,
    );
    const enregistrer = vi.fn(async () => undefined);
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = openModal({
        title: "Aperçu de la facture",
        content: <Text>Total : 120 €</Text>,
        actions: [{ label: "Envoyer", primary: true, success: "Facture envoyée", onClick: enregistrer }],
      });
    });
    const dialog = await screen.findByRole("dialog", { name: "Aperçu de la facture" });
    expect(within(dialog).getByText("Total : 120 €")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Envoyer" }));
    await expect(result).resolves.toBe(true);
    expect(enregistrer).toHaveBeenCalledOnce();
    expect(frame.notify).toHaveBeenCalledWith({ title: "Facture envoyée", tone: "success" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => {
      result = openModal({ title: "Détail", content: (close) => <Text>{typeof close}</Text> });
    });
    const detail = await screen.findByRole("dialog", { name: "Détail" });
    expect(within(detail).getByText("function")).toBeTruthy();
    const [, footer] = within(detail).getAllByRole("button", { name: "Fermer" });
    await user.click(footer);
    await expect(result).resolves.toBe(false);
  });
});

describe("openSubpage", () => {
  it("couvre la page sans la démonter, avec son en-tête, et revient par « Retour »", async () => {
    const user = userEvent.setup();
    render(
      <FrameServicesContext.Provider value={services()}>
        <Page header={{ title: "Tâches", actions: [{ label: "Modifier", icon: Pencil, onClick: noop }] }}>
          <Text>Liste</Text>
        </Page>
      </FrameServicesContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Tâches" })).toBeTruthy();
    let closed: Promise<void> = Promise.resolve();
    act(() => {
      closed = openSubpage({
        title: "Relancer le client",
        status: { label: "En cours", tone: "warning" },
        content: <Text>Détail de la tâche</Text>,
      });
    });
    const subpage = await screen.findByRole("region", { name: "Relancer le client" });
    expect(within(subpage).getByText("En cours")).toBeTruthy();
    expect(within(subpage).getByText("Détail de la tâche")).toBeTruthy();
    expect(screen.getByText("Liste", { selector: "p" }).closest("[inert]")).toBeTruthy();
    await user.click(within(subpage).getByRole("button", { name: "Retour" }));
    await closed;
    expect(screen.queryByRole("region", { name: "Relancer le client" })).toBeNull();
    expect(screen.getByText("Liste").closest("[inert]")).toBeNull();
  });
});

describe("DataTable", () => {
  it("garde un tableau accessible, en-tête séparé des lignes qui défilent", () => {
    render(
      <DataTable
        label="Tâches"
        fill
        rowKey={(row: { id: number; titre: string }) => row.id}
        columns={[{ key: "titre", header: "Titre" }]}
        rows={[
          { id: 1, titre: "Relancer" },
          { id: 2, titre: "Facturer" },
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "Tâches" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Titre"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(
      within(table)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Relancer", "Facturer"]);
  });
});

describe("barre de la page", () => {
  it("met la recherche et le contenu libre dans la barre fixe, sous l’en-tête, hors du défilement", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    render(
      <Page
        search={{ label: "Rechercher un contact", value: "", onChange: (value) => typed.push(value) }}
        bar={<Text>12 contacts</Text>}
      >
        <Text>Liste</Text>
      </Page>,
    );
    const field = screen.getByRole("searchbox", { name: "Rechercher un contact" });
    const bar = field.closest(".page-toolbar") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(within(bar).getByText("12 contacts")).toBeTruthy();
    // La barre n’est pas dans la zone qui défile.
    expect(bar.closest(".al-page__body")).toBeNull();
    await user.type(field, "a");
    expect(typed).toEqual(["a"]);
  });
});

describe("zones libres de la page", () => {
  it("accepte un en-tête et un pied libres, hors de la zone qui défile", () => {
    render(
      <Page header={<Text>Résumé du jour</Text>} footer={<Text>20 contacts</Text>}>
        <Text>Liste</Text>
      </Page>,
    );
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Résumé du jour")).toBeTruthy();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("20 contacts")).toBeTruthy();
    expect(footer.closest(".al-page__body")).toBeNull();
  });
});
