/**
 * Harnais installés sur ce poste (Claude Code, Codex, OpenCode), vérifiés une fois au démarrage d’Alfred puis à la
 * demande (Réglages → Agent). Un harnais absent n’est proposé nulle part ; sans aucun harnais, l’entrée Agent du
 * menu disparaît.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { type ProbeResult, probe } from "./native";
import type { Provider } from "./types";

export const ALL_PROVIDERS: readonly Provider[] = ["claude", "codex", "opencode"];

export type Probe =
  | { status: "loading" }
  | { status: "ready"; value: ProbeResult }
  | { status: "error"; message: string };

interface HarnessesState {
  probes: Partial<Record<Provider, Probe>>;
}

export const useHarnesses = create<HarnessesState>(() => ({ probes: {} }));

/** Vérifie chaque harnais ; l’état de chacun s’affiche dès qu’il est connu. */
export function checkHarnesses(): Promise<void> {
  return Promise.all(
    ALL_PROVIDERS.map(async (provider) => {
      useHarnesses.setState((state) => ({ probes: { ...state.probes, [provider]: { status: "loading" } } }));
      let result: Probe;
      try {
        result = { status: "ready", value: await probe(provider) };
      } catch (error) {
        result = { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
      useHarnesses.setState((state) => ({ probes: { ...state.probes, [provider]: result } }));
    }),
  ).then(() => undefined);
}

/**
 * Harnais à proposer : ceux qui sont installés. Un harnais dont l’état n’a pas pu être vérifié reste proposé (mieux
 * vaut un échec explicite au lancement qu’un harnais caché à tort). `null` tant qu’un harnais n’a jamais été vérifié.
 */
export function installedOf(probes: Partial<Record<Provider, Probe>>): Provider[] | null {
  const known = ALL_PROVIDERS.every((provider) => {
    const state = probes[provider];
    return state && state.status !== "loading";
  });
  if (!known) {
    // Pendant une nouvelle vérification, on garde ce qu’on savait déjà.
    const previous = ALL_PROVIDERS.filter((provider) => {
      const state = probes[provider];
      return state?.status === "ready" && state.value.installed;
    });
    return previous.length > 0 ? previous : null;
  }
  return ALL_PROVIDERS.filter((provider) => {
    const state = probes[provider];
    return state?.status === "error" || (state?.status === "ready" && state.value.installed);
  });
}

/** Harnais installés, ou `null` tant que la première vérification n’est pas finie. */
export function useInstalledProviders(): Provider[] | null {
  const probes = useHarnesses((state) => state.probes);
  return useMemo(() => installedOf(probes), [probes]);
}

/** Harnais à utiliser pour une nouvelle conversation : celui demandé s’il est installé, sinon le premier installé. */
export function usableProvider(wanted: Provider): Provider {
  const installed = installedOf(useHarnesses.getState().probes);
  if (!installed || installed.length === 0 || installed.includes(wanted)) return wanted;
  return installed[0];
}
