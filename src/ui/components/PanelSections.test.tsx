import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPageMemory, pageMemoryOf, rememberPageValue } from "../../shell/pageMemory";
import { DetailPanel } from "../templates/DetailPanel";
import { type FrameServices, FrameServicesContext } from "../templates/services";
import { orderSections, type PanelSection, PanelSections, reorderSections } from "./PanelSections";

/** Un cadre de panneau : ses services retiennent l’état comme la coquille, sous la référence du panneau. */
function frame(reference: string, selection?: unknown): FrameServices {
  return {
    notify: () => undefined,
    publish: () => undefined,
    setPanelVisible: () => undefined,
    openExternal: () => undefined,
    send: () => undefined,
    onPeer: () => () => undefined,
    onSelection: (handler) => {
      if (selection !== undefined) handler(selection);
      return () => undefined;
    },
    state: { initial: pageMemoryOf(reference), set: (key, value) => rememberPageValue(reference, key, value) },
  };
}

const sections: PanelSection[] = [
  { id: "deploiements", title: "Déploiements", summary: "2 en cours", content: "Liste des déploiements" },
  { id: "historique", title: "Historique", content: "Exécutions passées" },
  { id: "journal", title: "Journal", defaultCollapsed: true, content: "Lignes du journal" },
];

const titles = () => screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));

function mount(reference = "prefect/historique") {
  return render(
    <FrameServicesContext.Provider value={frame(reference)}>
      <PanelSections sections={sections} />
    </FrameServicesContext.Provider>,
  );
}

const durable = { load: vi.fn(async () => null), save: vi.fn(async () => null) };

afterEach(() => {
  clearPageMemory();
  vi.useRealTimers();
});

describe("PanelSections", () => {
  it("replie une section d’un clic sur son titre et garde son résumé visible", async () => {
    clearPageMemory(durable);
    const user = userEvent.setup();
    mount();
    const toggle = screen.getByRole("button", { name: /^Déploiements/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Liste des déploiements")).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Liste des déploiements")?.closest("[hidden]")).toBeTruthy();
    expect(screen.getByText("2 en cours")).toBeTruthy();
  });

  it("ouvre à la demande une section repliée par défaut", async () => {
    clearPageMemory(durable);
    const user = userEvent.setup();
    mount();
    const journal = screen.getByRole("button", { name: /^Journal/ });
    expect(journal.getAttribute("aria-expanded")).toBe("false");
    await user.click(journal);
    expect(journal.getAttribute("aria-expanded")).toBe("true");
  });

  it("déplace une section au clavier (Alt+↓) et retient l’ordre et le repli pour la page", async () => {
    clearPageMemory(durable);
    const user = userEvent.setup();
    const first = mount();
    expect(titles()).toEqual(["Déploiements", "Historique", "Journal"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Déplacer Déploiements, position 1 sur 3" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(titles()).toEqual(["Historique", "Déploiements", "Journal"]);
    await user.click(screen.getByRole("button", { name: /^Historique/ }));
    first.unmount();

    // Retour sur la page : un nouveau cadre, la même disposition.
    const back = mount();
    expect(titles()).toEqual(["Historique", "Déploiements", "Journal"]);
    expect(screen.getByRole("button", { name: /^Historique/ }).getAttribute("aria-expanded")).toBe("false");
    back.unmount();

    // Une autre page garde sa propre disposition.
    mount("jira/detail");
    expect(titles()).toEqual(["Déploiements", "Historique", "Journal"]);
  });

  it("enregistre la disposition sur le poste, sous la référence de la page", async () => {
    vi.useFakeTimers();
    const store = {
      load: vi.fn(async () => ({ "crm/fiche": { compte: 3, "alfred.sections.panel": {} } })),
      save: vi.fn(async (_value: unknown) => null),
    };
    clearPageMemory(store);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Historique/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(store.save).toHaveBeenCalledTimes(1);
    const saved = store.save.mock.calls[0]?.[0] as Record<string, Record<string, unknown>>;
    expect(saved["prefect/historique"]["alfred.sections.panel"]).toMatchObject({ collapsed: ["historique"] });
    // Seules les clés réservées sont enregistrées : l’état ordinaire d’une page ne dure que la session.
    expect(saved["crm/fiche"]).toEqual({ "alfred.sections.panel": {} });
  });
});

describe("ordre des sections", () => {
  it("place une section nouvelle à sa place déclarée et garde celles absentes de l’objet", () => {
    expect(orderSections(["c", "a"], ["a", "b", "c"])).toEqual(["b", "c", "a"]);
    expect(orderSections(["b", "x"], ["a", "b"])).toEqual(["a", "b", "x"]);
    expect(reorderSections(["a", "x", "b", "c"], ["c", "a", "b"])).toEqual(["c", "x", "a", "b"]);
  });
});

describe("DetailPanel", () => {
  it("rend ses blocs en sections repliables, avec leur résumé", async () => {
    clearPageMemory(durable);
    const user = userEvent.setup();
    render(
      <FrameServicesContext.Provider value={frame("jira/detail", { id: "T-1" })}>
        <DetailPanel
          emptyTitle="Aucun ticket sélectionné"
          load={async (id) => ({ id, name: "Corriger l’export" })}
          title={(item) => item.name}
          sections={() => [
            { title: "Description", content: "Le fichier est vide." },
            { id: "commentaires", title: "Commentaires", summary: "2", content: "Deux commentaires" },
          ]}
        />
      </FrameServicesContext.Provider>,
    );
    const toggle = await screen.findByRole("button", { name: /^Commentaires/ });
    expect(screen.getByText("2")).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Déplacer Description, position 1 sur 2" })).toBeTruthy();
  });
});
