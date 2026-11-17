import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
  // Pas de flux d’événements du backend dans jsdom.
  onNativeEvent: () => () => undefined,
}));

import type { ResolvedPage } from "../lib/types";
import { PageFrame } from "./PageFrame";
import { useShell } from "./store";

beforeEach(() => {
  native.invoke.mockReset().mockImplementation(async (command: string, args: { module: string }) => {
    if (command === "pages.frameKey") return { key: `cle-${args.module}` };
    return null;
  });
  useShell.setState({ info: { pageBase: "alfred-page://localhost" } } as never);
});

describe("cadre d’une page", () => {
  it("reçoit la clé de son module, et seulement elle, dans son adresse", async () => {
    const page = { id: "liste", module: "notes", reference: "notes/liste", title: "Liste" } as ResolvedPage;
    const { container } = render(<PageFrame page={page} kind="page" />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const source = new URL(container.querySelector("iframe")?.getAttribute("src") ?? "");
    expect(source.searchParams.get("module")).toBe("notes");
    expect(source.searchParams.get("key")).toBe("cle-notes");
    expect(native.invoke).toHaveBeenCalledWith("pages.frameKey", { module: "notes" });
    expect(native.invoke).not.toHaveBeenCalledWith("pages.frameKey", { module: "banque" });
  });
});
