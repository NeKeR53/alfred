import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { ModuleSummary } from "../../lib/types";
import { useShell } from "../../shell/store";
import { type ModuleUpdate, marketplaceApi } from "./api";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

interface ModuleUpdatesState {
  updates: ModuleUpdate[];
  /** Une vérification avec accès réseau est en cours. */
  checking: boolean;
  /** Relit l’état des modules installés ; `refresh` interroge d’abord les marketplaces distants. */
  load: (refresh: boolean) => Promise<void>;
}

let latestRequest = 0;

/** État partagé par la pastille de la coquille et l’écran Modules : une mise à jour appliquée ici disparaît là. */
export const useModuleUpdatesStore = create<ModuleUpdatesState>((set) => ({
  updates: [],
  checking: false,
  async load(refresh) {
    const request = ++latestRequest;
    if (refresh) set({ checking: true });
    try {
      const updates = await marketplaceApi.updates(refresh);
      // Une réponse dépassée par une demande plus récente ne doit pas l’écraser.
      if (request === latestRequest) set({ updates });
    } finally {
      if (refresh) set({ checking: false });
    }
  },
}));

/** Mises à jour que l’utilisateur peut appliquer : disponibles, hors modules figés. */
export function countPendingUpdates(updates: ModuleUpdate[]): number {
  return updates.filter((update) => update.available !== null && !update.pinned).length;
}

/** Ce qui, dans la liste des modules, change l’état des mises à jour ; `null` sans espace ouvert. */
function installedSignature(modules: ModuleSummary[] | undefined): string | null {
  if (!modules) return null;
  return modules
    .filter((module) => module.origin && !module.origin.detached)
    .map((module) => `${module.id}@${module.origin?.version}:${module.origin?.pinned ? "figé" : ""}`)
    .join("|");
}

let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function check() {
  // Vérification de fond : un marketplace injoignable est signalé dans l’écran Modules, pas par une alerte.
  void useModuleUpdatesStore
    .getState()
    .load(true)
    .catch(() => undefined);
}

/**
 * Nombre de mises à jour disponibles, hors modules figés. Vérifie à l’ouverture puis toutes les 30 minutes ; quel
 * que soit le nombre de composants qui l’utilisent, une seule vérification périodique tourne.
 */
export function useModuleUpdates(): number {
  const signature = useShell((state) => installedSignature(state.snapshot?.modules));
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    watchers += 1;
    if (watchers === 1) {
      check();
      timer = setInterval(check, CHECK_INTERVAL_MS);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = signature;
    // Premier rendu : la vérification d’ouverture s’en charge.
    if (before === undefined || before === signature) return;
    if (before === null) {
      // Un espace vient de s’ouvrir : ses modules n’ont encore jamais été vérifiés.
      check();
    } else {
      // Installation, mise à jour, annulation : l’état se relit sur place, sans réseau.
      void useModuleUpdatesStore
        .getState()
        .load(false)
        .catch(() => undefined);
    }
  }, [signature]);

  return useModuleUpdatesStore((state) => countPendingUpdates(state.updates));
}
