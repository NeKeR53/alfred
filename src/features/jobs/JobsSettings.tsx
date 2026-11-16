import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  LoadingSkeleton,
  Page,
  RefreshButton,
  Row,
  Section,
  Stack,
  StatusBadge,
  Text,
} from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";

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
  running: { label: "En cours", tone: "warning" },
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

/** Rubrique « Tâches de fond » des Réglages : travaux longs des modules, leur progression, annuler ou reprendre. */
export function JobsSettings() {
  const snapshot = useShell((state) => state.snapshot);
  const [jobs, setJobs] = useState<JobItem[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await invoke<JobItem[]>("jobs.list", { limit: 200 }));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
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
  }, [load]);

  const act = async (job: JobItem, command: "jobs.cancel" | "jobs.resume" | "jobs.remove", failure: string) => {
    setBusy(job.id);
    try {
      await invoke(command, { id: job.id });
      await load();
    } catch (problem) {
      notify({ title: failure, description: errorMessage(problem), tone: "error" });
    } finally {
      setBusy(undefined);
    }
  };

  const moduleName = (id: string) => snapshot?.modules.find((module) => module.id === id)?.name ?? id;

  const columns: DataTableColumn<JobItem>[] = [
    {
      key: "title",
      header: "Tâche",
      sortValue: (job) => job.title,
      render: (job) => (
        <Stack gap="none">
          <Text weight="medium">{job.title}</Text>
          <Text size="meta" tone="muted">
            Module {moduleName(job.module)} · fonction {job.function}
          </Text>
          {job.status === "failed" && job.error ? (
            <Text size="meta" tone="danger">
              {job.error}
            </Text>
          ) : job.message ? (
            <Text size="meta" tone="muted">
              {job.message}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "status",
      header: "État",
      width: "190px",
      sortValue: (job) => job.status,
      render: (job) => (
        <Stack gap="xs">
          <Row gap="xs" wrap>
            <StatusBadge tone={STATUS[job.status].tone} size="compact">
              {job.cancelRequested ? "Annulation…" : STATUS[job.status].label}
            </StatusBadge>
          </Row>
          <Text size="meta" tone="muted">
            {advancement(job)}
          </Text>
        </Stack>
      ),
    },
    {
      key: "createdAt",
      header: "Lancée",
      width: "150px",
      sortValue: (job) => job.createdAt,
      render: (job) => dateTime.format(new Date(job.createdAt)),
    },
    {
      key: "actions",
      header: "Actions",
      width: "120px",
      align: "end",
      sortable: false,
      render: (job) =>
        job.status === "queued" || job.status === "running" ? (
          <Button
            loading={busy === job.id}
            disabled={job.cancelRequested || (busy !== undefined && busy !== job.id)}
            aria-label={`Annuler la tâche ${job.title}`}
            onClick={() => void act(job, "jobs.cancel", "La tâche n’a pas été annulée")}
          >
            Annuler
          </Button>
        ) : job.status === "failed" || job.status === "cancelled" ? (
          <Button
            loading={busy === job.id}
            disabled={busy !== undefined && busy !== job.id}
            aria-label={`Reprendre la tâche ${job.title}`}
            onClick={() => void act(job, "jobs.resume", "La tâche n’a pas repris")}
          >
            Reprendre
          </Button>
        ) : (
          <Button
            loading={busy === job.id}
            disabled={busy !== undefined && busy !== job.id}
            aria-label={`Retirer la tâche ${job.title}`}
            onClick={() => void act(job, "jobs.remove", "La tâche n’a pas été retirée")}
          >
            Retirer
          </Button>
        ),
    },
  ];

  return (
    <Page width="text">
      <Section
        title="Tâches de fond"
        description="Travaux longs lancés par les modules (un import, un relevé complet). Ils avancent par étapes tant qu’Alfred est ouvert, et reprennent où ils en étaient à la réouverture."
        actions={<RefreshButton label="Actualiser les tâches" loading={loading} onClick={() => void load()} />}
      >
        {error ? (
          <FeedbackBanner
            tone="error"
            appearance="contained"
            action={<Button onClick={() => void load()}>Réessayer</Button>}
          >
            Les tâches n’ont pas pu être lues : {error}
          </FeedbackBanner>
        ) : null}
        {jobs === undefined ? (
          error ? null : (
            <LoadingSkeleton rows={3} label="Chargement des tâches…" />
          )
        ) : jobs.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucune tâche de fond"
            description="Quand un module lance un travail long, il apparaît ici avec sa progression."
          />
        ) : (
          <DataTable label="Tâches de fond" columns={columns} rows={jobs} rowKey={(job) => job.id} loading={loading} />
        )}
      </Section>
    </Page>
  );
}
