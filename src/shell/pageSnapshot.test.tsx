import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { describePage } from "../runtime/describePage";
import type { FrameMessage } from "../sdk/protocol";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;

/**
 * Cadre simulé : il s’inscrit comme le vrai PageFrame, se déclare prêt et répond à `describe` avec la description
 * d’un document de test, comme le fait l’hôte d’une page.
 */
vi.mock("./PageFrame", () => ({
  PageFrame({ page }: { page: { reference: string } }) {
    useEffect(() => {
      let dispose: () => void = () => undefined;
      // Import différé : pageSnapshot importe ce module simulé, l’inverse au chargement bloquerait.
      void import("./pageSnapshot").then(({ registerSnapshotTarget }) => {
        const target = registerSnapshotTarget(
          page.reference,
          (message: FrameMessage) => {
            if (message.kind !== "event" || message.name !== "describe") return;
            const { id } = message.payload as { id: string };
            setTimeout(() => target.receive({ id, ...describePage(sample()) }), 0);
          },
          true,
        );
        setTimeout(() => target.ready(), 0);
        dispose = () => target.dispose();
      });
      return () => dispose();
    }, [page.reference]);
    return <div data-testid={`cadre-${page.reference}`} />;
  },
}));

const { capturePage, SnapshotFrames } = await import("./pageSnapshot");
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
  });
});
