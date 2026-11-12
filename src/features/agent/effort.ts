/** Libellés des niveaux d’effort annoncés par les CLI ; un niveau inconnu garde son identifiant. */
const EFFORT_LABEL: Record<string, string> = {
  none: "Aucun",
  minimal: "Minimal",
  low: "Faible",
  medium: "Moyen",
  high: "Élevé",
  xhigh: "Très élevé",
  max: "Maximal",
  ultra: "Ultra",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort;
}
