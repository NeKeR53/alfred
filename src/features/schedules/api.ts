/** Commandes `schedules.*` du backend (voir `src-tauri/src/schedules.rs`). */
import { invoke } from "../../lib/native";

export interface ScheduleItem {
  module: string;
  id: string;
  description: string;
  function: string;
  everyMinutes: number | null;
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

/** Rythme lisible : « toutes les 15 minutes », « chaque jour à 08:00 ». */
export function cadence(item: Pick<ScheduleItem, "everyMinutes" | "at">): string {
  if (item.at) return `chaque jour à ${item.at}`;
  const minutes = item.everyMinutes ?? 0;
  if (minutes === 1) return "toutes les minutes";
  if (minutes % 1440 === 0) return minutes === 1440 ? "tous les jours" : `tous les ${minutes / 1440} jours`;
  if (minutes % 60 === 0) return minutes === 60 ? "toutes les heures" : `toutes les ${minutes / 60} heures`;
  return `toutes les ${minutes} minutes`;
}
