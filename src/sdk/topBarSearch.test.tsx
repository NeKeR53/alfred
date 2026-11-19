import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTopBarSearch } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

const sent: FrameRequest[] = [];
const spyPost = () =>
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
  });

const fromShell = (data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));
  });

afterEach(() => {
  sent.length = 0;
});

describe("useTopBarSearch", () => {
  it("déclare la recherche, reprend le texte retenu et suit la barre du haut", async () => {
    const post = spyPost();
    const { result, unmount } = renderHook(() => useTopBarSearch({ label: "Rechercher un ticket" }));
    const declare = sent.find((message) => message.method === "shell.search.declare");
    expect(declare?.params).toEqual({ label: "Rechercher un ticket", placeholder: undefined });
    await fromShell({ alfred: ALFRED_MESSAGE, kind: "response", id: declare?.id, result: { query: "Élève" } });
    expect(result.current.query).toBe("Élève");
    expect(result.current.terms).toEqual(["eleve"]);
    expect(result.current.matches("Une élève", null)).toBe(true);

    await fromShell({ alfred: ALFRED_MESSAGE, kind: "event", name: "search", payload: { query: "paris lyon" } });
    expect(result.current.matches("Paris")).toBe(false);
    expect(result.current.matches("Paris", "Lyon")).toBe(true);

    act(() => result.current.clear());
    expect(result.current.query).toBe("");
    expect(sent.at(-1)).toMatchObject({ method: "shell.search.set", params: { query: "" } });

    unmount();
    expect(sent.at(-1)?.method).toBe("shell.search.remove");
    expect(post).toHaveBeenCalled();
  });
});
