/** Commandes `schedules.*` du backend (voir `src-tauri/src/schedules.rs`). */
import { invoke } from "../../lib/native";

export interface ScheduleItem {
  module: string;
  id: string;
  description: string;
  function: string;
  everyMinutes: number | null;
  /** Relevé rapproché : intervalle en secondes (au moins 5). */
  everySeconds?: number | null;
  at: string | null;
  enabled: boolean;
  running?: boolean;
  lastRunAt: string | null;
  lastStatus: "running" | "ok" | "error" | null;
  lastError: string | null;
  /** `null` en pause ou si la déclaration est invalide. */
  nextRunAt: string | null;
  functionExists: boolean;
  /** Déclaration invalide (deux déclencheurs, heure mal écrite) : elle ne part pas. */
  problem?: string | null;
}

export type RunResult = { ok: true; output: unknown } | { ok: false; error: string };

export const scheduleKey = (item: Pick<ScheduleItem, "module" | "id">) => `${item.module}/${item.id}`;

export const listSchedules = () => invoke<ScheduleItem[]>("schedules.list");
export const setScheduleEnabled = (schedule: string, enabled: boolean) =>
  invoke<null>("schedules.setEnabled", { schedule, enabled });
export const runScheduleNow = (schedule: string) => invoke<RunResult>("schedules.runNow", { schedule });

/** Heure dite comme on la dit : « 7 h », « 7 h 30 », « 18 h 05 ». */
export function spokenTime(at: string): string {
  const [hours, minutes] = at.split(":").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(hours)) return at;
  return minutes ? `${hours} h ${String(minutes).padStart(2, "0")}` : `${hours} h`;
}

/** Rythme lisible : « toutes les 15 minutes », « toutes les 10 secondes », « tous les jours à 8 h ». */
export function cadence(item: Pick<ScheduleItem, "everyMinutes" | "at"> & { everySeconds?: number | null }): string {
  if (item.at) return `tous les jours à ${spokenTime(item.at)}`;
  if (item.everySeconds) return `toutes les ${item.everySeconds} secondes`;
  const minutes = item.everyMinutes ?? 0;
  if (minutes === 1) return "toutes les minutes";
  if (minutes % 1440 === 0) return minutes === 1440 ? "tous les jours" : `tous les ${minutes / 1440} jours`;
  if (minutes % 60 === 0) return minutes === 60 ? "toutes les heures" : `toutes les ${minutes / 60} heures`;
  return `toutes les ${minutes} minutes`;
}
