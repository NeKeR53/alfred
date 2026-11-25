import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

const sent: FrameRequest[] = [];

function spyPost() {
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    const request = message as FrameRequest;
    if (request.kind !== "request") return;
    sent.push(request);
    // La coquille accepte chaque demande.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { alfred: ALFRED_MESSAGE, kind: "response", id: request.id, result: null },
      }),
    );
  });
}

function push(watch: string, state: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { alfred: ALFRED_MESSAGE, kind: "event", name: "query", payload: { watch, state } },
    }),
  );
}

afterEach(() => {
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("useQuery", () => {
  it("s’abonne à la lecture partagée, suit chaque réponse et se désabonne", async () => {
    spyPost();
    const { result, unmount } = renderHook(() =>
      useQuery<{ tickets: string[] }>("jira/lister-tickets", { jql: "assignee = currentUser()" }, { refreshEvery: 30 }),
    );
    expect(result.current.loading).toBe(true);
    const watch = sent.find((request) => request.method === "functions.watch");
    expect(watch?.params).toMatchObject({
      function: "jira/lister-tickets",
      input: { jql: "assignee = currentUser()" },
      refreshEvery: 30,
    });
    const id = (watch?.params as { watch?: string } | undefined)?.watch ?? "";

    act(() => push(id, { data: { tickets: ["ALF-1"] }, loading: false, fetching: false, updatedAt: 1_000 }));
    expect(result.current).toMatchObject({ data: { tickets: ["ALF-1"] }, loading: false, refreshing: false });
    expect(result.current.updatedAt?.getTime()).toBe(1_000);

    // Une réponse publiée ailleurs arrive d’elle-même ; une erreur garde la donnée.
    act(() => push(id, { data: { tickets: ["ALF-1"] }, error: { message: "503" }, loading: false, fetching: false }));
    expect(result.current.data).toEqual({ tickets: ["ALF-1"] });
    expect(result.current.error?.message).toBe("503");
    // Un état adressé à un autre abonnement est ignoré.
    act(() => push("autre", { data: "x", loading: false, fetching: false }));
    expect(result.current.data).toEqual({ tickets: ["ALF-1"] });

    await act(() => result.current.refresh());
    expect(sent.at(-1)).toMatchObject({ method: "functions.refresh", params: { watch: id } });
    unmount();
    expect(sent.at(-1)).toMatchObject({ method: "functions.unwatch", params: { watch: id } });
  });

  it("ne lit rien sans référence, et se réabonne quand l’entrée change", () => {
    spyPost();
    const { result, rerender } = renderHook(
      ({ projet }: { projet: string | null }) => useQuery(projet ? "jira/lister-tickets" : null, { projet }),
      { initialProps: { projet: null as string | null } },
    );
    expect(result.current.loading).toBe(false);
    expect(sent).toHaveLength(0);
    rerender({ projet: "ALF" });
    rerender({ projet: "ALF" });
    expect(sent.filter((request) => request.method === "functions.watch")).toHaveLength(1);
    rerender({ projet: "OPS" });
    expect(sent.map((request) => request.method)).toEqual(["functions.watch", "functions.unwatch", "functions.watch"]);
  });
});
