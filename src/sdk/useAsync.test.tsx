import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAsync } from "./index";
import { ALFRED_MESSAGE } from "./protocol";

/** Une promesse que le test résout lui-même. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("useAsync relit en arrière-plan : les données restent affichées, sans état de chargement", async () => {
  const loads: Array<ReturnType<typeof deferred<string[]>>> = [];
  const { result, rerender } = renderHook(
    ({ filtre }) =>
      useAsync(() => {
        const load = deferred<string[]>();
        loads.push(load);
        return load.promise;
      }, [filtre]),
    {
      initialProps: { filtre: "tout" },
    },
  );
  // Premier chargement : rien à montrer.
  expect(result.current).toMatchObject({ data: undefined, loading: true, refreshing: true });
  await act(async () => loads[0]?.resolve(["a", "b"]));
  expect(result.current).toMatchObject({ data: ["a", "b"], loading: false, refreshing: false });

  // Données changées ailleurs : la relecture garde la liste à l’écran.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { alfred: ALFRED_MESSAGE, kind: "event", name: "dataChanged", payload: null },
      }),
    );
  });
  await waitFor(() => expect(loads).toHaveLength(2));
  expect(result.current).toMatchObject({ data: ["a", "b"], loading: false, refreshing: true });
  await act(async () => loads[1]?.resolve(["a", "b", "c"]));
  expect(result.current).toMatchObject({ data: ["a", "b", "c"], loading: false, refreshing: false });

  // Une relecture en échec garde les données et dit l’erreur.
  act(() => result.current.reload());
  await waitFor(() => expect(loads).toHaveLength(3));
  expect(result.current.loading).toBe(false);
  await act(async () => loads[2]?.reject(new Error("Base indisponible")));
  expect(result.current).toMatchObject({ data: ["a", "b", "c"], loading: false, refreshing: false });
  expect(result.current.error?.message).toBe("Base indisponible");

  // D’autres dépendances : les données montrées ne valent plus, c’est un chargement.
  rerender({ filtre: "urgent" });
  await waitFor(() => expect(loads).toHaveLength(4));
  expect(result.current.loading).toBe(true);
  await act(async () => loads[3]?.resolve(["u"]));
  expect(result.current).toMatchObject({ data: ["u"], loading: false });
});
