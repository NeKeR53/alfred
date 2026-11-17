import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { clearPageMemory, pageMemoryOf, rememberPageValue } from "../../shell/pageMemory";
import { CollectionPage } from "./CollectionPage";
import { usePageState } from "./pageState";
import { type FrameServices, FrameServicesContext } from "./services";

/** Un cadre de page : ses services retiennent l’état comme la coquille, sous la référence de la page. */
function frame(reference: string): FrameServices {
  return {
    notify: () => undefined,
    publish: () => undefined,
    setPanelVisible: () => undefined,
    openExternal: () => undefined,
    send: () => undefined,
    onPeer: () => () => undefined,
    onSelection: () => () => undefined,
    state: { initial: pageMemoryOf(reference), set: (key, value) => rememberPageValue(reference, key, value) },
  };
}

function Compteur() {
  const [count, setCount] = usePageState("compte", 0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {count}
    </button>
  );
}

describe("usePageState", () => {
  it("retrouve la valeur en revenant sur la page, et pas sur une autre", async () => {
    clearPageMemory();
    const user = userEvent.setup();
    const first = render(
      <FrameServicesContext.Provider value={frame("crm/liste")}>
        <Compteur />
      </FrameServicesContext.Provider>,
    );
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));
    first.unmount();

    // Retour sur la page : un nouveau cadre, la même valeur.
    const back = render(
      <FrameServicesContext.Provider value={frame("crm/liste")}>
        <Compteur />
      </FrameServicesContext.Provider>,
    );
    expect(screen.getByRole("button").textContent).toBe("2");
    back.unmount();

    render(
      <FrameServicesContext.Provider value={frame("crm/autre")}>
        <Compteur />
      </FrameServicesContext.Provider>,
    );
    expect(screen.getByRole("button").textContent).toBe("0");
  });

  it("refuse une valeur trop grosse", () => {
    expect(() => rememberPageValue("crm/liste", "gros", "x".repeat(30_000))).toThrow(/trop gros/);
  });

  it("garde la recherche d’une CollectionPage", async () => {
    clearPageMemory();
    const user = userEvent.setup();
    const page = () => (
      <FrameServicesContext.Provider value={frame("crm/contacts")}>
        <CollectionPage
          label="Contacts"
          emptyTitle="Aucun contact"
          load={async () => [
            { id: 1, nom: "Léa" },
            { id: 2, nom: "Paul" },
          ]}
          rowKey={(row) => row.id}
          columns={[{ key: "nom", header: "Nom" }]}
          search={{ label: "Rechercher un contact" }}
        />
      </FrameServicesContext.Provider>
    );
    const first = render(page());
    await screen.findByText("Paul");
    await user.type(screen.getByRole("searchbox", { name: "Rechercher un contact" }), "léa");
    first.unmount();

    render(page());
    expect(((await screen.findByRole("searchbox", { name: "Rechercher un contact" })) as HTMLInputElement).value).toBe(
      "léa",
    );
    await screen.findByText("Léa");
    await act(async () => undefined);
    expect(screen.queryByText("Paul")).toBeNull();
  });
});
