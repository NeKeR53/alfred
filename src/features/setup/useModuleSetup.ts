/** État de configuration des modules, relu à chaque changement des services, du coffre ou de l’espace. */
import { useCallback, useEffect, useRef, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import type { Uses } from "../../lib/types";
import { getSetup, type ModuleSetup, type SetupStep } from "./api";

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

/**
 * Compteur qui augmente chaque fois qu’un service dont la page dépend devient prêt (compte ajouté, approuvé,
 * connecté, testé) : la page affichée se recharge alors d’elle-même, sans que l’utilisateur ait à la rouvrir.
 */
export function useReadyServicesReload(module: string, uses?: Uses, enabled = true): number {
  const { of } = useModuleSetup({ listen: enabled });
  const setup = of(module);
  const ready = setup
    ? stepsOfPage(setup, module, uses)
        .filter((step) => step.state === "ready")
        .map((step) => step.key)
        .sort()
        .join(",")
    : undefined;
  const previous = useRef<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!enabled || ready === undefined) return;
    const before = previous.current;
    previous.current = ready;
    if (before === undefined) return;
    const known = new Set(before.split(",").filter(Boolean));
    if (ready.split(",").some((key) => key && !known.has(key))) setReloads((count) => count + 1);
  }, [ready, enabled]);
  return reloads;
}

/**
 * Services dont dépend une page : ceux qu’elle déclare dans `uses.clients` (« besoin » de son module, ou
 * « dépendance/besoin »), sinon tous ceux du module, dépendances comprises.
 */
export function stepsOfPage(setup: ModuleSetup, module: string, uses?: Uses): SetupStep[] {
  const declared = uses?.clients ?? [];
  if (declared.length === 0) return setup.steps;
  const keys = new Set(declared.map((need) => (need.includes("/") ? need : `${module}/${need}`)));
  return setup.steps.filter((step) => keys.has(step.key));
}
