import {
  Button,
  ChoiceButton,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  FormField,
  IconButton,
  KeyValueList,
  LoadingSkeleton,
  Markdown,
  Page,
  PageToolbar,
  RefreshButton,
  Row,
  Section,
  SelectControl,
  Stack,
  StatusDot,
  Text,
} from "@alfred/ui";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import "./journal.css";

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
};

const LIMIT = 200;

const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fullFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "medium" });
const numberFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? timeFormat.format(date) : `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

function formatFull(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : fullFormat.format(date);
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${numberFormat.format(ms)} ms`;
  if (ms < 60_000) return `${numberFormat.format(ms / 1000)} s`;
  return `${numberFormat.format(ms / 60_000)} min`;
}

const isFailure = (entry: JournalEntry) => entry.status !== "ok";

/** Bloc de code Markdown dont la clôture ne peut pas être refermée par le contenu. */
function codeBlock(content: string, language = ""): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  return JSON.stringify(detail, null, 2);
}

function EntryStatus({ entry }: { entry: JournalEntry }) {
  return isFailure(entry) ? (
    <Row gap="xs">
      <StatusDot tone="danger" />
      <Text as="span" tone="danger" weight="strong">
        Échec
      </Text>
    </Row>
  ) : (
    <Row gap="xs">
      <StatusDot tone="success" />
      <Text as="span">Réussi</Text>
    </Row>
  );
}

const columns: DataTableColumn<JournalEntry>[] = [
  {
    key: "at",
    header: "Heure",
    width: "120px",
    render: (entry) => <Text as="span">{formatTime(entry.at)}</Text>,
    sortValue: (entry) => entry.at,
  },
  {
    key: "kind",
    header: "Type",
    width: "110px",
    render: (entry) => KIND_LABEL[entry.kind] ?? entry.kind,
    sortValue: (entry) => KIND_LABEL[entry.kind] ?? entry.kind,
  },
  {
    key: "subject",
    header: "Sujet",
    width: "22%",
    render: (entry) => <span className="journal-cell">{entry.subject}</span>,
    sortValue: (entry) => entry.subject,
  },
  {
    key: "status",
    header: "État",
    width: "88px",
    render: (entry) => <EntryStatus entry={entry} />,
    sortValue: (entry) => (isFailure(entry) ? 0 : 1),
  },
  {
    key: "durationMs",
    header: "Durée",
    width: "64px",
    align: "end",
    render: (entry) => formatDuration(entry.durationMs),
    sortValue: (entry) => entry.durationMs,
  },
  {
    key: "summary",
    header: "Résumé",
    render: (entry) => (
      <span className="journal-cell">
        <Text as="span" tone={isFailure(entry) ? "danger" : "default"}>
          {entry.summary || "—"}
        </Text>
      </span>
    ),
    sortValue: (entry) => entry.summary,
  },
];

function EntryDetail({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const hasDetail = entry.detail !== null && entry.detail !== undefined;
  return (
    <Section
      title={`Détail : ${entry.subject}`}
      description={formatFull(entry.at)}
      actions={
        <IconButton label={`Fermer le détail de ${entry.subject}`} tooltip="Fermer" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      }
    >
      <Stack gap="md">
        <KeyValueList
          items={[
            { label: "Type", value: KIND_LABEL[entry.kind] ?? entry.kind },
            { label: "État", value: <EntryStatus entry={entry} /> },
            { label: "Durée", value: formatDuration(entry.durationMs) },
            { label: "Résumé", value: entry.summary || "—" },
          ]}
        />
        {hasDetail ? (
          <Markdown>{codeBlock(detailText(entry.detail), typeof entry.detail === "string" ? "" : "json")}</Markdown>
        ) : (
          <Text tone="muted">Aucun détail technique n’a été enregistré pour cette exécution.</Text>
        )}
      </Stack>
    </Section>
  );
}

/**
 * Onglet « Journal » des Réglages : ce qu’Alfred a exécuté pour l’espace (fonctions, webhooks, clients, IA,
 * planifications, agents), pour comprendre pourquoi une page ne fait pas ce qu’on attend.
 */
/** « parmi les 12 dernières exécutions », ou « lors de la dernière exécution » quand il n’y en a qu’une. */
function recentRuns(count: number) {
  return count === 1 ? "lors de la dernière exécution" : `parmi les ${count} dernières exécutions`;
}

export function JournalSettings() {
  const [kind, setKind] = useState<KindFilter>("all");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [entries, setEntries] = useState<JournalEntry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
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
    // Les exécutions arrivent en rafale : une seule relecture une fois au calme. La ligne ouverte reste ouverte.
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
  const rows = (entries ?? []).filter((entry) => !failuresOnly || isFailure(entry));
  const failures = (entries ?? []).filter(isFailure).length;
  const open = entries?.find((entry) => entry.id === openId) ?? null;
  const kindLabel = JOURNAL_KINDS.find((item) => item.value === kind)?.label ?? kind;

  const toolbar = (
    <PageToolbar
      start={
        <Row gap="md">
          <FormField label="Type" layout="inline">
            <SelectControl
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as KindFilter);
                setOpenId(null);
              }}
            >
              {JOURNAL_KINDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </SelectControl>
          </FormField>
          <ChoiceButton
            variant="label"
            selectionMode="toggle"
            label="Échecs seulement"
            selected={failuresOnly}
            onClick={() => setFailuresOnly((value) => !value)}
          >
            Échecs seulement
          </ChoiceButton>
        </Row>
      }
    >
      <RefreshButton loading={loading} onClick={reload} />
    </PageToolbar>
  );

  if (entries === undefined) {
    return (
      <Page toolbar={toolbar}>
        {error ? (
          <FeedbackBanner tone="error" appearance="contained" action={<Button onClick={reload}>Réessayer</Button>}>
            Le journal n’a pas pu être lu : {error}
          </FeedbackBanner>
        ) : (
          <LoadingSkeleton variant="page" label="Chargement du journal…" />
        )}
      </Page>
    );
  }

  return (
    <Page toolbar={toolbar}>
      {error ? (
        <FeedbackBanner tone="error" appearance="contained" action={<Button onClick={reload}>Réessayer</Button>}>
          Le journal n’a pas pu être relu : {error}
        </FeedbackBanner>
      ) : null}
      {entries.length === 0 ? (
        <EmptyState
          title={kind === "all" ? "Aucune exécution" : `Aucune exécution de type « ${kindLabel} »`}
          description="Chaque appel de fonction, webhook, client, IA, planification, tâche de fond, événement, commande ou agent fait par l’espace de travail s’inscrit ici, avec sa durée et son résultat."
        />
      ) : (
        <>
          <Text tone={failures > 0 ? "danger" : "muted"} weight={failures > 0 ? "medium" : "normal"}>
            {failures > 0
              ? `${failures} échec${failures > 1 ? "s" : ""} ${recentRuns(entries.length)}.`
              : `Aucun échec ${recentRuns(entries.length)}.`}{" "}
            Sélectionner une ligne pour afficher son détail technique.
          </Text>
          {open ? <EntryDetail entry={open} onClose={() => setOpenId(null)} /> : null}
          <DataTable
            label="Journal d’exécution"
            columns={columns}
            rows={rows}
            rowKey={(entry) => entry.id}
            selectedKey={openId}
            onRowClick={(entry) => setOpenId((current) => (current === entry.id ? null : entry.id))}
            loading={loading}
            emptyTitle="Aucun échec"
            emptyDescription="Aucune des exécutions affichées n’a échoué."
          />
        </>
      )}
    </Page>
  );
}
