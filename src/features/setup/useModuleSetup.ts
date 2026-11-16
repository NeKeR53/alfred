/** État de configuration des modules, relu à chaque changement des services, du coffre ou de l’espace. */
import { useCallback, useEffect, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { getSetup, type ModuleSetup } from "./api";

/**
 * `listen: false` : l’écran relit lui-même l’état quand ses services changent (`load`), sans s’abonner aux
 * événements une seconde fois.
 */
export function useModuleSetup({ listen = true }: { listen?: boolean } = {}) {
  const [modules, setModules] = useState<ModuleSetup[]>();
  const load = useCallback(async () => {
    try {
      setModules(await getSetup());
    } catch {
      // Pas d’espace ouvert ou backend indisponible : rien à signaler, les écrans gardent leur état.
    }
  }, []);
  useEffect(() => {
    void load();
    if (!listen) return;
    const stops = ["clients:changed", "vault:changed", "space:changed"].map((event) =>
      onNativeEvent(event, () => void load()),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [listen, load]);
  const of = useCallback((module: string) => modules?.find((item) => item.module === module), [modules]);
  return { modules, load, of };
}
