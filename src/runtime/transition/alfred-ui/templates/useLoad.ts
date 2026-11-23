import { useCallback, useEffect, useRef, useState } from "react";
import { isFrameMessage } from "../../../../sdk/protocol";

export interface LoadState<Data> {
  data: Data | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Chargement d’un gabarit : comme `useAsync` de `@alfred/sdk`, sans dépendre du pont. */
export function useLoad<Data>(load: () => Promise<Data>, deps: ReadonlyArray<unknown>): LoadState<Data> {
  const [state, setState] = useState<{ data?: Data; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: les dépendances sont celles du gabarit appelant.
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: undefined }));
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (data) => active && setState({ data, loading: false }),
        (error: unknown) =>
          active && setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
      );
    return () => {
      active = false;
    };
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  // Données du module changées ailleurs (reçues de l’équipe) : la coquille prévient le cadre, le gabarit relit.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !isFrameMessage(event.data)) return;
      if (event.data.kind === "event" && event.data.name === "dataChanged") reload();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reload]);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
