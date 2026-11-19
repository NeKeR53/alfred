import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { TopBarSearch } from "./TopBarSearch";
import { clearTopBarSearches, onTopBarQuery, topBarQueryOf, useTopBarSearches } from "./topBarSearchStore";

const page: FrameIdentity = { kind: "page", module: "suivi", reference: "suivi/taches" };

beforeEach(() => clearTopBarSearches());

describe("recherche de la barre du haut, côté pont", () => {
  it("est déclarée par une page et rend le texte retenu", async () => {
    useTopBarSearches.setState({ queries: { "suivi/taches": "revue" } });
    const result = await handleFrameRequest(page, "shell.search.declare", { label: "Rechercher une tâche" });
    expect(result).toEqual({ query: "revue" });
    expect(useTopBarSearches.getState().declared["suivi/taches"]).toEqual({
      label: "Rechercher une tâche",
      placeholder: "Rechercher…",
    });
  });

  it("est refusée à un panneau, et une capture la lit sans prendre la barre", async () => {
    const panel: FrameIdentity = { ...page, kind: "panel", reference: "suivi/detail", host: "suivi/taches" };
    await expect(handleFrameRequest(panel, "shell.search.declare", {})).rejects.toThrow(/réservée à une page/);
    useTopBarSearches.setState({ queries: { "suivi/taches": "client" } });
    const capture = await handleFrameRequest({ ...page, capture: true }, "shell.search.declare", {});
    expect(capture).toEqual({ query: "client" });
    expect(useTopBarSearches.getState().declared).toEqual({});
  });

  it("disparaît quand la page la retire ou que son cadre s’en va, et garde le texte", async () => {
    await handleFrameRequest(page, "shell.search.declare", {});
    await handleFrameRequest(page, "shell.search.set", { query: "relance" });
    await handleFrameRequest(page, "shell.search.remove", {});
    expect(useTopBarSearches.getState().declared).toEqual({});
    await handleFrameRequest(page, "shell.search.declare", {});
    releaseFrame(page);
    expect(useTopBarSearches.getState().declared).toEqual({});
    expect(topBarQueryOf("suivi/taches")).toBe("relance");
  });
});

describe("TopBarSearch", () => {
  it("n’affiche rien tant que la page n’a pas de recherche", () => {
    const { container } = render(<TopBarSearch reference="suivi/taches" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("envoie chaque frappe à la page, efface avec Échap et répond à ⌘F ou Ctrl+F", async () => {
    const user = userEvent.setup();
    const received = vi.fn();
    onTopBarQuery("suivi/taches", received);
    await handleFrameRequest(page, "shell.search.declare", { label: "Rechercher une tâche", placeholder: "Tâche…" });
    render(
      <>
        <button type="button">Ailleurs</button>
        <TopBarSearch reference="suivi/taches" />
      </>,
    );
    const field = screen.getByRole("searchbox", { name: "Rechercher une tâche" });
    expect(field).toHaveAttribute("placeholder", "Tâche…");
    await user.type(field, "rev");
    expect(received).toHaveBeenLastCalledWith("rev");
    await user.keyboard("{Escape}");
    expect(field).toHaveValue("");
    expect(received).toHaveBeenLastCalledWith("");
    // Champ vide : Échap rend la main.
    await user.keyboard("{Escape}");
    expect(field).not.toHaveFocus();

    screen.getByRole("button", { name: "Ailleurs" }).focus();
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      field.blur();
      const event = new KeyboardEvent("keydown", { key: "f", cancelable: true, ...modifier });
      act(() => {
        window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(field).toHaveFocus();
    }
  });

  it("montre le texte que la page a changé, sans le lui renvoyer", async () => {
    const received = vi.fn();
    onTopBarQuery("suivi/taches", received);
    await handleFrameRequest(page, "shell.search.declare", {});
    render(<TopBarSearch reference="suivi/taches" />);
    await act(() => handleFrameRequest(page, "shell.search.set", { query: "client" }));
    expect(screen.getByRole("searchbox")).toHaveValue("client");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(received).toHaveBeenCalledTimes(1);
  });
});
