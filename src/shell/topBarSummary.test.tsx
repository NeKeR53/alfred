import { render, screen } from "@testing-library/react";
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
import { TopBarSummary, useTopBarSummaries } from "./topBarSummary";

const page: FrameIdentity = { kind: "page", module: "atom", reference: "atom/acces" };

beforeEach(() => useTopBarSummaries.setState({ summaries: {} }));

describe("résumé de la barre du haut", () => {
  it("est posé par une page, affiché après le titre, et retiré par un texte vide", async () => {
    await handleFrameRequest(page, "shell.summary.set", { text: "  3 personnes ·\n 2 en écart  " });
    render(<TopBarSummary reference="atom/acces" />);
    expect(screen.getByText("3 personnes · 2 en écart")).toHaveClass("shell-topbar__summary");
    await handleFrameRequest(page, "shell.summary.set", { text: "" });
    expect(useTopBarSummaries.getState().summaries).toEqual({});
  });

  it("est ignoré d’un panneau et d’une capture, et disparaît avec le cadre de la page", async () => {
    await handleFrameRequest(
      { ...page, kind: "panel", reference: "atom/personne", host: "atom/acces" },
      "shell.summary.set",
      { text: "x" },
    );
    await handleFrameRequest({ ...page, capture: true }, "shell.summary.set", { text: "y" });
    expect(useTopBarSummaries.getState().summaries).toEqual({});
    await handleFrameRequest(page, "shell.summary.set", { text: "6 environnements" });
    releaseFrame(page);
    expect(useTopBarSummaries.getState().summaries).toEqual({});
  });
});
