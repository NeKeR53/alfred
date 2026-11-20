/**
 * Résumé qu’une page place dans la barre du haut, après son titre (`useTopBarSummary` du SDK) : « 3 personnes ·
 * 2 en écart · 6 environnements », comme la barre d’une page de OneApp. Une ligne de texte, par page affichée ; il
 * disparaît avec son cadre.
 */
import { create } from "zustand";

const MAX = 160;

export const useTopBarSummaries = create<{ summaries: Record<string, string> }>(() => ({ summaries: {} }));

/** Pose (ou retire, avec un texte vide) le résumé de la page `reference`. */
export function setTopBarSummary(reference: string, value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX) : "";
  const { summaries } = useTopBarSummaries.getState();
  if ((summaries[reference] ?? "") === text) return;
  const { [reference]: _, ...rest } = summaries;
  useTopBarSummaries.setState({ summaries: text ? { ...rest, [reference]: text } : rest });
}

export function TopBarSummary({ reference }: { reference: string }) {
  const summary = useTopBarSummaries((state) => state.summaries[reference]);
  return summary ? <span className="shell-topbar__summary">{summary}</span> : null;
}
