/** État de configuration des modules, relu à chaque changement des services, du coffre ou de l’espace. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onNativeEvent } from "../../lib/native";
import type { Uses } from "../../lib/types";
import { useShell } from "../../shell/store";
import { getSetup, type ModuleSetup, type SetupStep } from "./api";

/**
 * État lu, commun à tous les écrans (pages, leur page d’attente, Réglages) : une seule lecture à la fois, et une
 * seule par changement, quel que soit le nombre de pages ouvertes. Rangé par espace : celui d’un autre espace ne
 * s’affiche jamais.
 */
let shared: { space: string | null; modules: ModuleSetup[] } | undefined;
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;
/** Une lecture demandée pendant une autre : elle repart une fois, à la fin de celle en cours. */
let again = false;
let listeners = 0;
let stopEvents: (() => void) | null = null;

const currentSpace = () => useShell.getState().snapshot?.path ?? null;

function publish() {
  for (const notify of subscribers) notify();
}

function loadShared(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  const space = currentSpace();
  inflight = getSetup()
    .then(
      (modules) => {
        shared = { space, modules };
      },
      () => {
        // Pas d’espace ouvert ou backend indisponible : rien à signaler, les écrans gardent leur état (aucun module
        // connu à la première lecture, pour que les pages s’affichent quand même).
        if (!shared || shared.space !== space) shared = { space, modules: [] };
      },
    )
    .finally(() => {
      inflight = null;
      publish();
      if (again) {
        again = false;
        void loadShared();
      }
    });
  return inflight;
}

/** Les événements qui changent la configuration, écoutés une seule fois tant qu’un écran les suit. */
function follow(): () => void {
  listeners += 1;
  if (listeners === 1) {
    const stops = ["clients:changed", "vault:changed", "space:changed"].map((event) =>
      onNativeEvent(event, () => void loadShared()),
    );
    stopEvents = () => {
      for (const stop of stops) stop();
    };
  }
  return () => {
    listeners -= 1;
    if (listeners === 0) {
      stopEvents?.();
      stopEvents = null;
    }
  };
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** Pour les tests : oublie l’état lu. */
export function resetModuleSetup() {
  shared = undefined;
  inflight = null;
  again = false;
}

/**
 * `listen: false` : l’écran relit lui-même l’état quand ses services changent (`load`), sans s’abonner aux
 * événements. L’état déjà lu s’affiche tout de suite ; une relecture part en arrière-plan à l’ouverture de l’écran.
 */
export function useModuleSetup({ listen = true }: { listen?: boolean } = {}) {
  const space = useShell((state) => state.snapshot?.path ?? null);
  const read = useSyncExternalStore(subscribe, () => shared);
  const modules = read && read.space === space ? read.modules : undefined;
  const load = useCallback(() => loadShared(), []);
  useEffect(() => {
    void loadShared();
    return listen ? follow() : undefined;
  }, [listen]);
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
