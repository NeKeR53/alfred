import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sameValue, useAlfredState } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

const sent: FrameRequest[] = [];

function spyPost() {
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    const request = message as FrameRequest;
    if (request.kind !== "request") return;
    sent.push(request);
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
      data: { alfred: ALFRED_MESSAGE, kind: "event", name: "state", payload: { watch, state } },
    }),
  );
}

type Mail = { id: string; sujet: string; lu: boolean };
const boite = (mails: Mail[]) => ({ data: mails, loading: false, refreshing: false, updatedAt: 1_000 });

afterEach(() => {
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("useAlfredState", () => {
  it("avec select, une page qui montre le nombre de non-lus ne se redessine pas quand un autre champ change", () => {
    spyPost();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAlfredState<Mail[], number>("mail/boite-de-reception", {
        select: (mails) => mails.filter((mail) => !mail.lu).length,
      });
    });
    const watch = sent.find((request) => request.method === "states.watch");
    expect(watch?.params).toMatchObject({ name: "mail/boite-de-reception" });
    const id = (watch?.params as { watch?: string } | undefined)?.watch ?? "";

    act(() => push(id, boite([{ id: "m1", sujet: "Bonjour", lu: false }])));
    expect(result.current.data).toBe(1);
    const afterFirst = renders;

    // Le sujet change, le nombre de non-lus non : aucun redessin, même pendant une relecture.
    act(() => push(id, boite([{ id: "m1", sujet: "Bonjour (modifié)", lu: false }])));
    act(() => push(id, { ...boite([{ id: "m1", sujet: "Bonjour (modifié)", lu: false }]), refreshing: true }));
    expect(renders).toBe(afterFirst);

    // Un mail non lu de plus : la page se redessine.
    act(() =>
      push(
        id,
        boite([
          { id: "m1", sujet: "Bonjour (modifié)", lu: false },
          { id: "m2", sujet: "Facture", lu: false },
        ]),
      ),
    );
    expect(result.current.data).toBe(2);
    expect(renders).toBe(afterFirst + 1);
  });

  it("rend la valeur entière sans select, relit à la demande et se désabonne", async () => {
    spyPost();
    const { result, unmount } = renderHook(() => useAlfredState<Mail[]>("mail/boite-de-reception"));
    expect(result.current.loading).toBe(true);
    const id = (sent[0]?.params as { watch?: string } | undefined)?.watch ?? "";
    act(() => push(id, boite([{ id: "m1", sujet: "Bonjour", lu: true }])));
    expect(result.current).toMatchObject({ data: [{ id: "m1", sujet: "Bonjour", lu: true }], loading: false });
    expect(result.current.updatedAt?.getTime()).toBe(1_000);
    // Un état adressé à un autre abonnement est ignoré.
    act(() => push("autre", boite([])));
    expect(result.current.data).toHaveLength(1);
    await act(() => result.current.refresh());
    expect(sent.at(-1)).toMatchObject({ method: "states.refresh", params: { watch: id } });
    unmount();
    expect(sent.at(-1)).toMatchObject({ method: "states.unwatch", params: { watch: id } });
  });

  it("compare les valeurs par leur structure", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});
