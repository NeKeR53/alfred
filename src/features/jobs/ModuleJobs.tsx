import { Play, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Action, SettingsSection } from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";

export interface JobItem {
  id: string;
  module: string;
  function: string;
  title: string;
  step: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number | null;
  message: string | null;
  error: string | null;
  attempts: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const STATUS = {
  queued: { label: "En attente", tone: "neutral" },
  running: { label: "En cours", tone: "pending" },
  done: { label: "Terminée", tone: "success" },
  failed: { label: "Échec", tone: "danger" },
  cancelled: { label: "Annulée", tone: "neutral" },
} as const;

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Avancement lisible : pourcentage s’il est connu, sinon le nombre d’étapes faites. */
export function advancement(job: JobItem): string {
  const steps = `${job.step} étape${job.step > 1 ? "s" : ""}`;
  return job.progress === null ? steps : `${percent.format(job.progress)} · ${steps}`;
}

/**
 * Section « Tâches de fond » de la fiche d’un module (Réglages → Modules) : ses travaux longs, leur progression,
 * annuler ou reprendre ; aucune section quand le module n’en a lancé aucun. `module` absent : aucune fiche ouverte.
 */
export function useJobsSection(module: string | undefined): SettingsSection | null {
  const [all, setJobs] = useState<JobItem[]>();
  const jobs = all?.filter((job) => job.module === module);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setJobs(await invoke<JobItem[]>("jobs.list", { limit: 200 }));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    if (!module) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onNativeEvent("jobs:changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [load, module]);

  if (!module) return null;
  const act = async (job: JobItem, command: "jobs.cancel" | "jobs.resume" | "jobs.remove", failure: string) => {
    try {
      await invoke(command, { id: job.id });
      await load();
    } catch (problem) {
      notify({ title: failure, description: errorMessage(problem), tone: "error" });
    }
  };
  const actionOf = (job: JobItem): Action =>
    job.status === "queued" || job.status === "running"
      ? {
          id: "cancel",
          label: `Annuler la tâche ${job.title}`,
          icon: <X size={16} aria-hidden="true" />,
          isDisabled: job.cancelRequested,
          onPress: () => act(job, "jobs.cancel", "La tâche n’a pas été annulée"),
        }
      : job.status === "failed" || job.status === "cancelled"
        ? {
            id: "resume",
            label: `Reprendre la tâche ${job.title}`,
            icon: <Play size={16} aria-hidden="true" />,
            onPress: () => act(job, "jobs.resume", "La tâche n’a pas repris"),
          }
        : {
            id: "remove",
            label: `Retirer la tâche ${job.title}`,
            icon: <Trash2 size={16} aria-hidden="true" />,
            onPress: () => act(job, "jobs.remove", "La tâche n’a pas été retirée"),
          };

  if (!jobs || jobs.length === 0) {
    return error
      ? { id: "jobs", title: "Tâches de fond", emptyMessage: `Les tâches n’ont pas pu être lues : ${error}` }
      : null;
  }
  return {
    id: "jobs",
    title: "Tâches de fond",
    description: "Travaux longs lancés par le module ; ils reprennent où ils en étaient à la réouverture d’Alfred.",
    settings: jobs.map((job) => ({
      type: "item",
      id: job.id,
      label: job.title,
      description: [
        `Fonction ${job.function}`,
        job.status === "failed" && job.error ? job.error : job.message,
        advancement(job),
        `lancée le ${dateTime.format(new Date(job.createdAt))}`,
      ]
        .filter(Boolean)
        .join(" · "),
      tags: [
        {
          label: job.cancelRequested ? "Annulation…" : STATUS[job.status].label,
          tone: STATUS[job.status].tone,
        },
      ],
      actions: [actionOf(job)],
    })),
  };
}
