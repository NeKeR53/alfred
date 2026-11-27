import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { describePage } from "../runtime/describePage";
import type { FrameMessage } from "../sdk/protocol";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;

/**
 * Cadre simulé : il s’inscrit comme le vrai PageFrame, se déclare prêt et répond à `describe` avec la description
 * d’un document de test, comme le fait l’hôte d’une page, et à `review` avec des mesures démesurées.
 */
/** Éléments choisis reçus par les cadres simulés (`selection` d’une capture de panneau). */
const received: unknown[] = [];

vi.mock("./PageFrame", () => ({
  PageFrame({
    page,
    token,
    selection,
  }: {
    page: { reference: string };
    token?: string;
    selection?: { value: unknown };
  }) {
    if (selection) received.push(selection.value);
    useEffect(() => {
      let dispose: () => void = () => undefined;
      // Import différé : pageSnapshot importe ce module simulé, l’inverse au chargement bloquerait.
      void import("./pageSnapshot").then(({ registerSnapshotTarget }) => {
        const target = registerSnapshotTarget(
          page.reference,
          (message: FrameMessage) => {
            if (message.kind !== "event") return;
            const { id, themes } = message.payload as { id: string; themes?: string[] };
            if (message.name === "describe") setTimeout(() => target.receive({ id, ...describePage(sample()) }), 0);
            if (message.name === "review") {
              const layout = {
                width: 1e9,
                busy: true,
                belowFold: [{ kind: "inventé", text: "x".repeat(500), top: 900 }],
                truncated: Array.from({ length: 50 }, () => ({ text: "coupé", shown: 7 })),
              };
              const contrast = (themes ?? []).map((theme) => ({ theme, count: 1, items: [] }));
              setTimeout(() => target.receive({ id, review: { layout, contrast } }), 0);
            }
          },
          true,
          undefined,
          false,
          token,
        );
        setTimeout(() => target.ready(), 0);
        dispose = () => target.dispose();
      });
      return () => dispose();
    }, [page.reference, token]);
    return <div data-testid={`cadre-${page.reference}`} />;
  },
}));

const { capturePage, reviewPages, SnapshotFrames } = await import("./pageSnapshot");
const { useShell } = await import("./store");

function sample(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <h1>Tâches</h1>
    <p>Trois tâches en retard.</p>
    <div hidden>secret caché</div>
    <label for="nom">Nom</label><input id="nom" value="Revue" required />
    <label><input type="checkbox" checked /> Terminée</label>
    <button disabled>Enregistrer</button>
    <div role="tablist"><button role="tab" aria-selected="true">Ouvertes</button><button role="tab">Fermées</button></div>
    <table><tr><th>Titre</th><th>Échéance</th></tr><tr><td>Revue</td><td>12 nov.</td></tr></table>
    <div role="alert">Connexion perdue</div>`;
  document.body.append(root);
  return root;
}

describe("capture d’une page pour l’agent", () => {
  it("décrit titres, champs, états, onglets, tableaux et alertes, sans ce qui est caché", () => {
    const { text } = describePage(sample());
    expect(text).toContain('heading 1 "Tâches"');
    expect(text).toContain('text "Trois tâches en retard."');
    expect(text).toContain('textbox "Nom" valeur="Revue" (requis)');
    expect(text).toContain('checkbox "Terminée" (coché)');
    expect(text).toContain('button "Enregistrer" (désactivé)');
    expect(text).toContain('tab "Ouvertes" (sélectionné)');
    expect(text).toContain("table (2 lignes)");
    expect(text).toContain('row: "Revue" | "12 nov."');
    expect(text).toContain('alert\n  text "Connexion perdue"');
    expect(text).not.toContain("secret caché");
  });

  it("charge hors de la vue une page qui n’est pas affichée, la décrit, puis retire le cadre", async () => {
    useShell.setState({
      snapshot: {
        sections: [
          {
            pages: [
              {
                reference: "suivi/taches",
                module: "suivi",
                id: "taches",
                title: "Tâches",
                panel: { reference: "suivi/detail", module: "suivi", id: "detail", title: "Détail", panel: null },
              },
            ],
          },
        ],
        settingsPages: [],
      },
    } as never);
    const view = render(<SnapshotFrames />);
    const pending = capturePage("suivi/detail");
    await vi.waitFor(() => expect(view.getByTestId("cadre-suivi/detail")).toBeTruthy());
    const snapshot = await pending;
    expect(snapshot).toMatchObject({ page: "suivi/detail", title: "Détail", displayed: false, truncated: false });
    expect(snapshot.text).toContain('button "Enregistrer" (désactivé)');
    await vi.waitFor(() => expect(view.queryByTestId("cadre-suivi/detail")).toBeNull());

    await expect(capturePage("suivi/absente")).rejects.toThrow("n’existe pas");

    // Un panneau se capture rempli : l’agent donne l’élément choisi, le cadre invisible le reçoit.
    const chosen = capturePage("suivi/detail", undefined, { selection: { value: "T-12" } });
    await vi.waitFor(() => expect(view.getByTestId("cadre-suivi/detail")).toBeTruthy());
    await chosen;
    expect(received).toContain("T-12");
    const { frameContext } = await import("./frameBridge");
    const context = frameContext({
      kind: "panel",
      module: "suivi",
      reference: "suivi/detail",
      host: "suivi/taches",
      capture: true,
      selection: { value: "T-12" },
    });
    expect(context.selection).toBe("T-12");
  });

  it("examine une page dans deux cadres invisibles à la taille d’une fenêtre, et borne ce que rend le cadre", async () => {
    useShell.setState({
      snapshot: {
        sections: [{ pages: [{ reference: "suivi/taches", module: "suivi", id: "taches", title: "Tâches" }] }],
        settingsPages: [],
      },
    } as never);
    const view = render(<SnapshotFrames />);
    const pending = reviewPages([{ page: "suivi/taches", panel: true }, { page: "suivi/absente" }]);
    // Les deux tailles se chargent en même temps, chacune dans son cadre.
    await vi.waitFor(() => expect(view.getAllByTestId("cadre-suivi/taches")).toHaveLength(2));
    const [taches, absente] = await pending;
    expect(taches.viewports?.map(({ window, width, height }) => [window, width, height])).toEqual([
      ["1440 × 900, panneau ouvert", 928, 862],
      ["1024 × 900", 784, 862],
    ]);
    const [wide, narrow] = taches.viewports ?? [];
    expect(wide.contrast.map((item) => item.theme)).toEqual(["light", "dark"]);
    expect(narrow.contrast).toEqual([]);
    // Ce que rend le cadre vient de la page : nombres et textes bornés, listes courtes, genres connus.
    expect(wide.layout.width).toBe(100_000);
    expect(wide.layout.belowFold[0].kind).toBe("heading");
    expect(wide.layout.belowFold[0].text.length).toBeLessThanOrEqual(121);
    expect(wide.layout.truncated).toHaveLength(8);
    expect(wide.layout.truncated[0].shown).toBe(1);
    expect(absente.error).toContain("n’existe pas");
    await vi.waitFor(() => expect(view.queryByTestId("cadre-suivi/taches")).toBeNull());
  });
});
