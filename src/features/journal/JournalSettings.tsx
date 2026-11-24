import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, EmptyState, type LogLine, LogViewer, Select, type SettingsSection } from "socle-ui";
import { Stack } from "../../kit";
import { invoke, onNativeEvent } from "../../lib/native";

export interface JournalEntry {
  id: number;
  /** Horodatage ISO (UTC). */
  at: string;
  kind: string;
  /** Ce qui a été exécuté : `module/fonction`, identifiant du client… */
  subject: string;
  /** `ok` ou `error`. */
  status: string;
  durationMs: number | null;
  summary: string;
  detail: unknown;
}

export const JOURNAL_KINDS = [
  { value: "all", label: "Tout" },
  { value: "function", label: "Fonctions" },
  { value: "webhook", label: "Webhooks" },
  { value: "client", label: "Clients" },
  { value: "ai", label: "IA" },
  { value: "schedule", label: "Planification" },
  { value: "job", label: "Tâches de fond" },
  { value: "event", label: "Événements" },
  { value: "command", label: "Commandes" },
  { value: "agent", label: "Agents" },
  { value: "log", label: "Messages" },
] as const;

type KindFilter = (typeof JOURNAL_KINDS)[number]["value"];

/** Libellé d’une ligne : au singulier, pour la colonne Type. */
const KIND_LABEL: Record<string, string> = {
  function: "Fonction",
  webhook: "Webhook",
  client: "Client",
  ai: "IA",
  schedule: "Planification",
  job: "Tâche de fond",
  event: "Événement",
  command: "Commande",
  agent: "Agent",
  module: "Module",
  log: "Message",
};

const LIMIT = 200;

const numberFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${numberFormat.format(ms)} ms`;
  if (ms < 60_000) return `${numberFormat.format(ms / 1000)} s`;
  return `${numberFormat.format(ms / 60_000)} min`;
}

const isFailure = (entry: JournalEntry) => entry.status !== "ok";

function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  return JSON.stringify(detail, null, 2);
}

/** Une exécution en lignes du journal : une ligne de résumé, puis son détail technique, en retrait. */
export function journalLines(entries: JournalEntry[]): LogLine[] {
  // Le journal se lit du plus ancien au plus récent ; le backend rend le plus récent d’abord.
  return [...entries].reverse().flatMap((entry) => {
    const level = isFailure(entry) ? ("error" as const) : ("info" as const);
    const head = [
      KIND_LABEL[entry.kind] ?? entry.kind,
      entry.subject,
      isFailure(entry) ? "Échec" : "Réussi",
      formatDuration(entry.durationMs),
      entry.summary || "—",
    ].join(" · ");
    const hasDetail = entry.detail !== null && entry.detail !== undefined;
    const detail = hasDetail ? detailText(entry.detail).split("\n") : [];
    return [
      { text: head, time: entry.at, level },
      ...detail.map((line) => ({ text: `    ${line}`, time: entry.at, level })),
    ];
  });
}

/** « parmi les 12 dernières exécutions », ou « lors de la dernière exécution » quand il n’y en a qu’une. */
function recentRuns(count: number) {
  return count === 1 ? "lors de la dernière exécution" : `parmi les ${count} dernières exécutions`;
}

/**
 * Rubrique « Journal » des Réglages : ce qu’Alfred a exécuté pour l’espace (fonctions, webhooks, clients, IA,
 * planifications, agents), pour comprendre pourquoi une page ne fait pas ce qu’on attend. Une section, faite d’un
 * `LogViewer` : chaque exécution est une ligne, son détail technique suit en retrait ; le niveau « Erreurs » garde
 * les échecs.
 */
export function useJournalSections(): SettingsSection[] {
  const [kind, setKind] = useState<KindFilter>("all");
  const [entries, setEntries] = useState<JournalEntry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

  const load = useCallback(async (filter: KindFilter) => {
    const current = ++request.current;
    setLoading(true);
    try {
      const rows = await invoke<JournalEntry[]>(
        "journal.list",
        filter === "all" ? { limit: LIMIT } : { kind: filter, limit: LIMIT },
      );
      if (current !== request.current) return;
      setEntries(rows);
      setError(undefined);
    } catch (failure) {
      if (current !== request.current) return;
      setError(errorMessage(failure));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(kind);
    // Les exécutions arrivent en rafale : une seule relecture une fois au calme.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onNativeEvent("journal:changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(kind), 250);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [kind, load]);

  const reload = () => void load(kind);
  const failures = (entries ?? []).filter(isFailure).length;
  const kindLabel = JOURNAL_KINDS.find((item) => item.value === kind)?.label ?? kind;

  return [
    {
      id: "journal",
      description:
        entries && entries.length > 0
          ? failures > 0
            ? `${failures} échec${failures > 1 ? "s" : ""} ${recentRuns(entries.length)}.`
            : `Aucun échec ${recentRuns(entries.length)}.`
          : undefined,
      content: (
        <Stack gap="sm">
          {error ? (
            <Alert announce tone="danger" action={{ label: "Réessayer", onPress: reload }}>
              {entries ? `Le journal n’a pas pu être relu : ${error}` : `Le journal n’a pas pu être lu : ${error}`}
            </Alert>
          ) : null}
          <LogViewer
            label="Journal d’exécution"
            levels
            wrap
            loading={entries === undefined && !error}
            lines={entries ? journalLines(entries) : []}
            empty={
              <EmptyState
                size="compact"
                title={kind === "all" ? "Aucune exécution" : `Aucune exécution de type « ${kindLabel} »`}
                description="Chaque appel de fonction, webhook, client, IA, planification, tâche de fond, événement, commande ou agent fait par l’espace de travail s’inscrit ici, avec sa durée et son résultat."
              />
            }
            tools={
              <Select
                label="Type"
                hideLabel
                width="sm"
                value={kind}
                options={JOURNAL_KINDS.map((item) => ({ id: item.value, label: item.label }))}
                onChange={(id) => setKind((id as KindFilter | null) ?? "all")}
              />
            }
            actions={() => [
              {
                id: "refresh",
                label: "Actualiser",
                icon: <RefreshCw size={16} aria-hidden="true" />,
                isDisabled: loading,
                onPress: reload,
              },
            ]}
          />
        </Stack>
      ),
    },
  ];
}
