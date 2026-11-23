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
