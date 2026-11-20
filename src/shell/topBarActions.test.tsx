import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: vi.fn().mockResolvedValue(null),
}));

import { type FrameIdentity, handleFrameRequest, releaseFrame } from "./frameBridge";
import {
  arrangeTopBarActions,
  onTopBarAction,
  setTopBarActions,
  TopBarActions,
  useTopBarActionStore,
} from "./topBarActions";

const page: FrameIdentity = { kind: "page", module: "atom", reference: "atom/acces" };
const actions = [
  { id: "0:Exporter", label: "Exporter", icon: "Download" },
  { id: "1:Ajouter", label: "Ajouter une personne", icon: "UserPlus" },
  { id: "2:Rapport", label: "Rapport détaillé" },
  { id: "3:Vider", label: "Vider", icon: "Trash2", danger: true },
  { id: "4:Nouveau", label: "Nouvel environnement", primary: true },
];

beforeEach(() => useTopBarActionStore.setState({ actions: {} }));

describe("actions de la barre du haut, côté pont", () => {
  it("garde une description valide, ignore un panneau et une capture, et disparaît avec le cadre", async () => {
    await handleFrameRequest(page, "shell.actions.set", {
      actions: [{ id: "x", label: "Exporter", icon: "PasUneIcone", onClick: "() => 1" }, { label: "sans id" }],
    });
    expect(useTopBarActionStore.getState().actions["atom/acces"]).toEqual([{ id: "x", label: "Exporter" }]);
    await handleFrameRequest(
      { ...page, kind: "panel", reference: "atom/personne", host: "atom/acces" },
      "shell.actions.set",
      { actions },
    );
    await handleFrameRequest({ ...page, capture: true, reference: "atom/autre" }, "shell.actions.set", { actions });
    expect(Object.keys(useTopBarActionStore.getState().actions)).toEqual(["atom/acces"]);
    releaseFrame(page);
    expect(useTopBarActionStore.getState().actions).toEqual({});
  });
});

describe("TopBarActions", () => {
  it("montre des icônes, un menu « ⋯ » (destructrices à part) et l’action principale, et renvoie le clic au cadre", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    onTopBarAction("atom/acces", chosen);
    await handleFrameRequest(page, "shell.actions.set", { actions });
    render(<TopBarActions reference="atom/acces" />);
    await user.click(screen.getByRole("button", { name: "Exporter" }));
    expect(chosen).toHaveBeenCalledWith("0:Exporter");
    await user.click(screen.getByRole("button", { name: "Nouvel environnement" }));
    expect(chosen).toHaveBeenCalledWith("4:Nouveau");
    await user.click(screen.getByRole("button", { name: "Autres actions de la page" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Rapport détaillé" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Vider" }));
    expect(chosen).toHaveBeenCalledWith("3:Vider");
  });

  it("range tout dans « ⋯ » quand la fenêtre est étroite", () => {
    const arranged = arrangeTopBarActions(actions, true);
    expect(arranged.icons).toEqual([]);
    expect(arranged.primary).toBeUndefined();
    expect(arranged.menu.map((a) => a.label)).toEqual([
      "Exporter",
      "Ajouter une personne",
      "Rapport détaillé",
      "Nouvel environnement",
    ]);
    expect(arranged.dangerous.map((a) => a.label)).toEqual(["Vider"]);
  });

  it("bascule de vue : les actions d’un même groupe sont des boutons accolés, la vue affichée est cochée", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    onTopBarAction("atom/secrets", chosen);
    setTopBarActions("atom/secrets", [
      { id: "0:Tableau", label: "Tableau", icon: "Grid2x2Check", group: "Vue des secrets", selected: true },
      { id: "1:Arborescence", label: "Arborescence", icon: "ListTree", group: "Vue des secrets" },
      { id: "2:Actualiser", label: "Actualiser", icon: "RefreshCw" },
      { id: "3:Sans icône", label: "Sans icône", group: "Vue des secrets" },
    ]);
    const arranged = arrangeTopBarActions(useTopBarActionStore.getState().actions["atom/secrets"], true);
    expect(arranged.toggles[0].map((a) => a.label)).toEqual(["Tableau", "Arborescence"]);
    expect(arranged.menu.map((a) => a.label)).toEqual(["Actualiser", "Sans icône"]);
    render(<TopBarActions reference="atom/secrets" />);
    const groupe = screen.getByRole("radiogroup", { name: "Vue des secrets" });
    expect(within(groupe).getByRole("radio", { name: "Tableau" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(groupe).getByRole("radio", { name: "Arborescence" }));
    expect(chosen).toHaveBeenCalledWith("1:Arborescence");
  });
});
