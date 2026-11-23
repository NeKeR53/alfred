import type { MenuEntryStatus } from "./menuZones";

/** Ligne d’une zone du menu, telle que la coquille l’affiche (entrées d’une page, conversations de l’agent). */
export interface ZoneRow {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  status?: MenuEntryStatus;
  badge?: number;
  /** Précision lue avec le libellé et en infobulle (« Codex · Au travail »). */
  details?: string;
  actions?: Array<{ id: string; label: string; icon: string }>;
}

export const STATUS_LABEL: Record<MenuEntryStatus, string> = {
  ok: "Bon",
  warning: "À surveiller",
  error: "En échec",
  running: "Au travail",
  waiting: "Réponse attendue",
};
