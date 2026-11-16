/**
 * Compteurs des pages (`badge.set` du SDK), affichés en pastille sur l’entrée de la section dans le menu et sur
 * l’onglet de la page. Rust les garde par espace ; toutes les fenêtres suivent l’événement `badges:changed`.
 */
import { create } from "zustand";
import { invoke, onNativeEvent } from "../lib/native";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { useShell } from "./store";

interface BadgeState {
  /** `module/page` (ou `module/page@instance`) → compteur, toujours supérieur à zéro. */
  counts: Record<string, number>;
}

export const useBadges = create<BadgeState>(() => ({ counts: {} }));

let started = false;

/** Lit les compteurs de l’espace ouvert et les suit ; à appeler une fois au démarrage de la coquille. */
export function startBadges() {
  if (started) return;
  started = true;
  const load = () =>
    void invoke<Record<string, number>>("badges.list").then(
      (counts) => useBadges.setState({ counts: counts ?? {} }),
      () => useBadges.setState({ counts: {} }),
    );
  onNativeEvent("badges:changed", (payload) =>
    useBadges.setState({ counts: (payload as Record<string, number> | null) ?? {} }),
  );
  let path = useShell.getState().snapshot?.path;
  if (path) load();
  useShell.subscribe((state) => {
    if (state.snapshot?.path === path) return;
    path = state.snapshot?.path;
    if (path) load();
    else useBadges.setState({ counts: {} });
  });
}

/** Somme des compteurs des pages visibles d’une section. */
export function sectionCount(counts: Record<string, number>, pages: ResolvedPage[]): number {
  return pages.reduce((total, page) => total + (page.hidden ? 0 : (counts[page.reference] ?? 0)), 0);
}

/** Texte de la pastille : au-delà de 99, « 99+ ». */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Vrai si `reference` désigne une page de l’espace (menu ou Réglages), pas un panneau. */
export function isKnownPage(snapshot: Snapshot | null | undefined, reference: string): boolean {
  if (!snapshot) return false;
  return (
    snapshot.sections.some((section) => section.pages.some((page) => page.reference === reference)) ||
    snapshot.settingsPages.some((page) => page.reference === reference)
  );
}
