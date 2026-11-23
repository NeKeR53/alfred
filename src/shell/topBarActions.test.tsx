import { render, screen } from "@testing-library/react";
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

import { ActionBar } from "socle-ui";
import { frameActions } from "./AppShell";
import { type FrameIdentity, handleFrameRequest, releaseFrame } from "./frameBridge";
import { onTopBarAction, setTopBarActions, useTopBarActionStore } from "./topBarActions";

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

describe("actions de la barre du haut, côté coquille", () => {
  it("passent en `Action` de Socle : icônes, « … » et action principale, et renvoient le clic au cadre", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    onTopBarAction("atom/acces", chosen);
    await handleFrameRequest(page, "shell.actions.set", { actions });
    const list = frameActions("atom/acces", useTopBarActionStore.getState().actions["atom/acces"]);
    expect(list.map((action) => [action.label, action.primary ?? false])).toEqual([
      ["Exporter", false],
      ["Ajouter une personne", false],
      ["Rapport détaillé", false],
      ["Vider", false],
      ["Nouvel environnement", true],
    ]);
    render(<ActionBar actions={list} zone="topbar" />);
    await user.click(screen.getByRole("button", { name: "Nouvel environnement" }));
    expect(chosen).toHaveBeenCalledWith("4:Nouveau");
  });

  it("une bascule de vue devient une action ordinaire, la vue affichée est désactivée", () => {
    setTopBarActions("atom/secrets", [
      { id: "0:Tableau", label: "Tableau", icon: "Grid2x2Check", group: "Vue des secrets", selected: true },
      { id: "1:Arborescence", label: "Arborescence", icon: "ListTree", group: "Vue des secrets" },
    ]);
    const list = frameActions("atom/secrets", useTopBarActionStore.getState().actions["atom/secrets"]);
    expect(list.map((action) => [action.label, action.isDisabled ?? false])).toEqual([
      ["Tableau (affichée)", true],
      ["Arborescence", false],
    ]);
  });
});
