import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlfredSdkError, isPythonObjectLost, python, usePythonChannel, usePythonObject } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

const sent: FrameRequest[] = [];
/** Réponses de la coquille, par méthode : une valeur, ou une fonction des paramètres. */
let answers: Record<string, unknown> = {};

function respond(id: string, result: unknown, error?: { message: string; detail?: unknown }) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window.parent,
      data: { alfred: ALFRED_MESSAGE, kind: "response", id, ...(error ? { error } : { result }) },
    }),
  );
}

function shell() {
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    const request = message as FrameRequest;
    if (request.kind !== "request") return;
    sent.push(request);
    const answer = answers[request.method];
    if (answer === undefined) return;
    const value = typeof answer === "function" ? (answer as (params: unknown) => unknown)(request.params) : answer;
    queueMicrotask(() => {
      if (value instanceof AlfredSdkError) respond(request.id, null, { message: value.message, detail: value.detail });
      else respond(request.id, value);
    });
  });
}

afterEach(() => {
  sent.length = 0;
  answers = {};
  vi.restoreAllMocks();
});

describe("python", () => {
  it("crée un objet, appelle ses méthodes et le libère", async () => {
    shell();
    answers = {
      "python.create": { handle: "py_1", class: "analyse.Graphe" },
      "python.call": (params: { method: string }) => (params.method === "filtrer" ? [1, 2] : null),
      "python.dispose": { disposed: true },
    };
    const graphe = await python.create("analyse.Graphe", { source: "a,b" });
    expect(graphe.handle).toBe("py_1");
    expect(await graphe.call("filtrer", { seuil: 3 }, { timeout: 30 })).toEqual([1, 2]);
    await graphe.call("vider");
    await graphe.dispose();
    expect(sent.map((request) => [request.method, request.params])).toEqual([
      ["python.create", { class: "analyse.Graphe", args: { source: "a,b" } }],
      ["python.call", { handle: "py_1", method: "filtrer", args: { seuil: 3 }, timeout: 30 }],
      ["python.call", { handle: "py_1", method: "vider", args: null }],
      ["python.dispose", { handle: "py_1" }],
    ]);
  });

  it("appelle une fonction libre, avec ou sans canal d’avancement", async () => {
    shell();
    answers = { "python.run": "résumé", "python.channel": { channel: "c9" } };
    expect(await python.run("analyse.resumer", ["un texte"])).toBe("résumé");
    const run = await python.start("analyse.resumer", { texte: "x" }, { timeout: 600 });
    expect(run.channel).toBe("c9");
    expect(await run.result).toBe("résumé");
    expect(sent.map((request) => [request.method, request.params])).toEqual([
      ["python.run", { function: "analyse.resumer", args: ["un texte"] }],
      ["python.channel", {}],
      ["python.run", { function: "analyse.resumer", args: { texte: "x" }, timeout: 600, channel: "c9" }],
    ]);
  });

  it("rejette sur une erreur Python et reconnaît un objet perdu", async () => {
    shell();
    answers = {
      "python.call": (params: { method: string }) =>
        params.method === "echouer"
          ? new AlfredSdkError("ValueError: montant négatif", { python: { type: "ValueError", trace: "…" } })
          : new AlfredSdkError("L’objet Python « py_1 » n’existe plus", { code: "objectLost" }),
      "python.create": { handle: "py_1", class: "a.B" },
    };
    const objet = await python.create("a.B");
    const failure = await objet.call("echouer").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AlfredSdkError);
    expect((failure as AlfredSdkError).message).toBe("ValueError: montant négatif");
    expect(isPythonObjectLost(failure)).toBe(false);
    expect(isPythonObjectLost(await objet.call("autre").catch((error: unknown) => error))).toBe(true);
  });
});

describe("usePythonObject", () => {
  it("crée l’objet pour la page et le libère quand elle se ferme ou que ses dépendances changent", async () => {
    shell();
    let next = 0;
    answers = {
      "python.create": () => {
        next += 1;
        return { handle: `py_${next}`, class: "analyse.Graphe" };
      },
      "python.dispose": { disposed: true },
    };
    const { result, rerender, unmount } = renderHook(
      ({ source }) => usePythonObject("analyse.Graphe", { source }, [source]),
      { initialProps: { source: "a" } },
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.object?.handle).toBe("py_1"));
    rerender({ source: "b" });
    await waitFor(() => expect(result.current.object?.handle).toBe("py_2"));
    unmount();
    const calls = sent.map((request) => [request.method, request.params]);
    expect(calls).toEqual([
      ["python.create", { class: "analyse.Graphe", args: { source: "a" } }],
      ["python.dispose", { handle: "py_1" }],
      ["python.create", { class: "analyse.Graphe", args: { source: "b" } }],
      ["python.dispose", { handle: "py_2" }],
    ]);
  });
});

describe("usePythonChannel", () => {
  it("rend le dernier avancement et les valeurs envoyées, jusqu’à la fin de l’appel", async () => {
    shell();
    answers = {
      "channels.read": {
        events: [
          { seq: 1, type: "data", event: "progress", data: '{"fraction":0.5,"message":"moitié"}' },
          { seq: 2, type: "data", event: "data", data: '"ligne"' },
          { seq: 3, type: "data", event: "data", data: '{"n":2}' },
        ],
        next: 3,
        closed: true,
        reason: "terminé",
        dropped: 0,
        kind: "stream",
      },
    };
    const { result } = renderHook(() => usePythonChannel("c1"));
    await waitFor(() => expect(result.current.closed).toBe(true));
    await act(async () => undefined);
    expect(result.current.progress).toEqual({ fraction: 0.5, message: "moitié" });
    expect(result.current.data).toEqual(["ligne", { n: 2 }]);
  });
});
