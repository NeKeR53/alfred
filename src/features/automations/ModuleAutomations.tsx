/**
 * « Automatisations », dans la fiche d’un module (Réglages → Modules) : ce que le module lance de lui-même, à heure
 * fixe ou à intervalle (planifications), ou à chaque appel d’une adresse locale (webhooks). Le tableau tient en trois
 * colonnes, une ligne par automatisation : son nom, son déclencheur en clair et son état (active ou en pause, dernier
 * résultat). Un clic sur la ligne ouvre son détail : la fonction lancée, les dates, la sortie de la dernière
 * exécution, l’identifiant, et ce qu’on peut y faire (mettre en pause, exécuter maintenant, l’adresse et le secret
 * d’un webhook). Rien quand le module n’a aucune automatisation.
 */
import {
  Button,
  DataTable,
  type DataTableColumn,
  FeedbackBanner,
  IconButton,
  KeyValueList,
  LoadingSkeleton,
  Modal,
  Row,
  Stack,
  StatusBadge,
  SwitchControl,
  Text,
  useConfirm,
} from "@alfred/ui";
import { Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { ModulePart } from "../modules/ModulePart";
import {
  cadence,
  listSchedules,
  type RunResult,
  runScheduleNow,
  type ScheduleItem,
  scheduleKey,
  setScheduleEnabled,
} from "../schedules/api";
import { errorMessage } from "../vault/api";
import { getWebhookSecret, hookKey, listWebhooks, rotateWebhookSecret, type WebhookItem } from "../webhooks/api";
import "./automations.css";

export const MASK = "••••••••••••••••••••••••";

const full = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

/** « 14:42 » aujourd’hui, « 18 nov., 14:42 » avant. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? time.format(date) : `${day.format(date)}, ${time.format(date)}`;
}

/** Une ligne du tableau : une planification ou un webhook. */
export type Automation = { kind: "schedule"; item: ScheduleItem } | { kind: "webhook"; item: WebhookItem };

const keyOf = (entry: Automation) =>
  entry.kind === "schedule" ? `planification:${scheduleKey(entry.item)}` : `webhook:${hookKey(entry.item)}`;
const nameOf = (entry: Automation) => entry.item.description || entry.item.id;

/** Le déclencheur, en clair : « Toutes les 15 minutes », « Tous les jours à 8 h », « À chaque appel de son adresse ». */
export function trigger(entry: Automation): string {
  const text = entry.kind === "schedule" ? cadence(entry.item) : "à chaque appel de son adresse";
  return text.replace(/^./, (first) => first.toUpperCase());
}

/** L’état d’une automatisation : un ton, un mot, et le dernier résultat en court. */
export function stateOf(entry: Automation): {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
  detail: string;
} {
  if (entry.kind === "webhook") {
    const hook = entry.item;
    if (!hook.functionExists) return { tone: "danger", label: "À corriger", detail: "Fonction introuvable" };
    return {
      tone: "success",
      label: "Active",
      detail: hook.lastReceivedAt ? `appelée à ${when(hook.lastReceivedAt)}` : "jamais appelée",
    };
  }
  const item = entry.item;
  if (item.problem || !item.functionExists)
    return {
      tone: "danger",
      label: "À corriger",
      detail: item.problem ? "Déclaration invalide" : "Fonction introuvable",
    };
  const last = !item.lastRunAt
    ? "jamais lancée"
    : item.lastStatus === "error"
      ? `échec à ${when(item.lastRunAt)}`
      : item.lastStatus === "running" || item.running
        ? "en cours"
        : `réussie à ${when(item.lastRunAt)}`;
  if (!item.enabled) return { tone: "neutral", label: "En pause", detail: last };
  if (item.lastStatus === "error") return { tone: "danger", label: "Échec", detail: last };
  return { tone: "success", label: "Active", detail: last };
}

/** Sortie d’une exécution, résumée. */
function summarize(output: unknown): string {
  if (output === undefined || output === null) return "Aucune sortie.";
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function copy(text: string, done: string, failed: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify({ title: done, tone: "success" });
  } catch (failure) {
    notify({ title: failed, description: errorMessage(failure), tone: "error" });
  }
}

/** Secret d’un webhook : masqué par défaut, copiable, régénérable après confirmation. */
function WebhookSecret({ hook }: { hook: WebhookItem }) {
  const key = hookKey(hook);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setSecret((await getWebhookSecret(key)).secret);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async () => {
    const confirmed = await confirm({
      title: `Régénérer le secret du webhook « ${hook.description || key} » ?`,
      message: "L’ancien secret cesse aussitôt de fonctionner : l’émetteur sera refusé tant qu’il n’a pas le nouveau.",
      confirmLabel: "Régénérer",
      tone: "danger",
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      setSecret((await rotateWebhookSecret(key)).secret);
      notify({ title: "Secret régénéré", description: "Copiez-le chez l’émetteur du webhook.", tone: "success" });
    } catch (failure) {
      notify({ title: "Le secret n’a pas été régénéré", description: errorMessage(failure), tone: "error" });
    } finally {
      setRotating(false);
    }
  };

  if (error)
    return (
      <FeedbackBanner
        tone="danger"
        appearance="contained"
        action={<Button onClick={() => void load()}>Réessayer</Button>}
      >
        Le secret n’a pas pu être lu. {error}
      </FeedbackBanner>
    );
  if (secret === undefined) return <LoadingSkeleton rows={1} label="Chargement du secret…" />;
  return (
    <Stack gap="sm">
      <Row gap="xs" wrap>
        <Text as="span" weight="medium">
          {revealed ? secret : MASK}
        </Text>
        <IconButton
          label="Copier le secret"
          tooltip="Copier"
          size="small"
          onClick={() => void copy(secret, "Secret copié", "Le secret n’a pas été copié")}
        >
          <Copy size={16} aria-hidden="true" />
        </IconButton>
      </Row>
      <Row gap="sm" wrap>
        <Button variant="outline" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
          {revealed ? "Masquer le secret" : "Révéler le secret"}
        </Button>
        <Button variant="danger" loading={rotating} loadingLabel="Régénération…" onClick={() => void rotate()}>
          Régénérer
        </Button>
      </Row>
      <Text size="meta" tone="muted">
        Il se transmet dans l’en-tête X-Alfred-Secret, en Authorization: Bearer, dans le paramètre ?secret=, ou sert de
        clé à une signature HMAC-SHA256 du corps (X-Hub-Signature-256, format GitHub).
      </Text>
      {confirmDialog}
    </Stack>
  );
}

function Detail({
  entry,
  result,
  running,
  onClose,
  onToggle,
  onRun,
}: {
  entry: Automation;
  result?: RunResult;
  running: boolean;
  onClose: () => void;
  onToggle: (item: ScheduleItem, enabled: boolean) => void;
  onRun: (item: ScheduleItem) => void;
}) {
  const name = nameOf(entry);
  const state = stateOf(entry);
  const common = [
    { label: "Déclencheur", value: trigger(entry) },
    { label: "Fonction lancée", value: entry.item.function },
  ];
  let items: Array<{ label: string; value: ReactNode }>;
  if (entry.kind === "schedule") {
    const item = entry.item;
    items = [
      ...common,
      {
        label: "Prochaine exécution",
        value: !item.enabled ? "En pause" : item.nextRunAt ? full.format(new Date(item.nextRunAt)) : "—",
      },
      {
        label: "Dernière exécution",
        value: item.lastRunAt
          ? `${full.format(new Date(item.lastRunAt))} · ${item.lastStatus === "error" ? "échec" : item.lastStatus === "running" ? "en cours" : "réussie"}`
          : "Jamais",
      },
      { label: "Identifiant", value: scheduleKey(item) },
    ];
  } else {
    const hook = entry.item;
    items = [
      ...common,
      {
        label: "Adresse locale",
        value: hook.url ? (
          <Row gap="xs" wrap>
            <Text as="span">{hook.url}</Text>
            <IconButton
              label={`Copier l’adresse du webhook ${name}`}
              tooltip="Copier"
              size="small"
              onClick={() => void copy(hook.url ?? "", "Adresse copiée", "L’adresse n’a pas été copiée")}
            >
              <Copy size={16} aria-hidden="true" />
            </IconButton>
          </Row>
        ) : (
          "Serveur local arrêté"
        ),
      },
      { label: "Dernier appel", value: hook.lastReceivedAt ? full.format(new Date(hook.lastReceivedAt)) : "Jamais" },
      { label: "Méthodes", value: "POST, et GET pour les services qui vérifient l’adresse" },
      { label: "Réponse", value: "200 avec la sortie de la fonction, ou 202 si elle dure plus de 25 secondes" },
      { label: "Identifiant", value: hookKey(hook) },
    ];
  }
  const problems =
    entry.kind === "schedule"
      ? [
          entry.item.problem ?? null,
          entry.item.functionExists ? null : "Fonction introuvable : les exécutions échoueront.",
          entry.item.lastStatus === "error" ? entry.item.lastError : null,
        ]
      : [entry.item.functionExists ? null : "Fonction introuvable : les appels échoueront."];
  return (
    <Modal open onClose={onClose} title={name} description={`${state.label} · ${state.detail}`}>
      <Stack gap="md">
        {problems.filter(Boolean).map((problem) => (
          <Text key={problem} tone="danger">
            {problem}
          </Text>
        ))}
        {entry.kind === "schedule" ? (
          <Row gap="md" wrap>
            <SwitchControl
              label="Active"
              aria-label={`Automatisation ${name} active`}
              checked={entry.item.enabled}
              onChange={(event) => onToggle(entry.item, event.target.checked)}
            />
            <Button
              variant="outline"
              aria-label={`Exécuter maintenant ${name}`}
              loading={running || entry.item.running === true}
              loadingLabel="Exécution…"
              onClick={() => onRun(entry.item)}
            >
              Exécuter maintenant
            </Button>
          </Row>
        ) : null}
        <KeyValueList items={items} />
        {result ? (
          <Text size="meta" tone={result.ok ? "muted" : "danger"}>
            {result.ok ? `Sortie : ${summarize(result.output)}` : result.error}
          </Text>
        ) : null}
        {entry.kind === "webhook" ? (
          <>
            <WebhookSecret hook={entry.item} />
            <Text size="meta" tone="muted">
              Alfred n’écoute que sur cet ordinateur (127.0.0.1) et seulement tant qu’il est ouvert : pour un service
              sur Internet, exposez l’adresse locale par le tunnel de votre choix (Cloudflare Tunnel, Tailscale Funnel,
              ngrok).
            </Text>
          </>
        ) : null}
      </Stack>
    </Modal>
  );
}

export function ModuleAutomations({ module }: { module: string }) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>();
  const [hooks, setHooks] = useState<WebhookItem[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState<string>();
  const [runningNow, setRunningNow] = useState<string>();
  const [results, setResults] = useState<Record<string, RunResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSchedules, nextHooks] = await Promise.all([listSchedules(), listWebhooks()]);
      setSchedules(nextSchedules);
      setHooks(nextHooks);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Une exécution ou une réception écrit au journal : l’état et la date du dernier résultat changent.
    const stops = ["space:changed", "journal:changed", "schedules:changed"].map((name) =>
      onNativeEvent(name, () => void load()),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [load]);

  const toggle = async (item: ScheduleItem, enabled: boolean) => {
    const key = scheduleKey(item);
    // Réglage immédiat : la valeur change tout de suite, et revient en arrière si l’écriture échoue.
    const set = (value: boolean) =>
      setSchedules((current) =>
        current?.map((other) => (scheduleKey(other) === key ? { ...other, enabled: value } : other)),
      );
    set(enabled);
    try {
      await setScheduleEnabled(key, enabled);
      await load();
    } catch (failure) {
      set(!enabled);
      notify({
        title: enabled ? "L’automatisation n’a pas repris" : "L’automatisation n’a pas été mise en pause",
        description: errorMessage(failure),
        tone: "error",
      });
    }
  };

  const runNow = async (item: ScheduleItem) => {
    const key = scheduleKey(item);
    const label = item.description || key;
    setRunningNow(key);
    try {
      const result = await runScheduleNow(key);
      setResults((current) => ({ ...current, [key]: result }));
      notify(
        result.ok
          ? { title: `${label} : exécution réussie`, tone: "success" }
          : { title: `${label} : l’exécution a échoué`, description: result.error, tone: "error" },
      );
    } catch (failure) {
      notify({ title: `${label} : l’exécution n’a pas démarré`, description: errorMessage(failure), tone: "error" });
    } finally {
      setRunningNow(undefined);
      void load();
    }
  };

  if (schedules === undefined || hooks === undefined) {
    return error ? (
      <Text size="meta" tone="danger">
        Les automatisations n’ont pas pu être lues. {error}
      </Text>
    ) : null;
  }
  const rows: Automation[] = [
    ...schedules.filter((item) => item.module === module).map((item) => ({ kind: "schedule" as const, item })),
    ...hooks.filter((item) => item.module === module).map((item) => ({ kind: "webhook" as const, item })),
  ];
  if (rows.length === 0) return null;
  const current = rows.find((entry) => keyOf(entry) === opened);

  const columns: DataTableColumn<Automation>[] = [
    {
      key: "name",
      header: "Automatisation",
      sortValue: nameOf,
      render: (entry) => (
        <span className="automation-cell" title={nameOf(entry)}>
          {nameOf(entry)}
        </span>
      ),
    },
    { key: "trigger", header: "Déclencheur", width: "200px", sortValue: trigger, render: trigger },
    {
      key: "state",
      header: "État",
      width: "220px",
      sortValue: (entry) => stateOf(entry).label,
      render: (entry) => {
        const state = stateOf(entry);
        return (
          <Row gap="xs" wrap>
            <StatusBadge tone={state.tone} size="compact">
              {state.label}
            </StatusBadge>
            <Text as="span" size="meta" tone="muted">
              {state.detail}
            </Text>
          </Row>
        );
      },
    },
  ];

  return (
    <ModulePart
      part="automations"
      title="Automatisations"
      description="Ce que le module lance de lui-même, tant qu’Alfred est ouvert. Ouvrez une ligne pour la mettre en pause, l’exécuter ou voir son détail."
    >
      <DataTable
        label="Automatisations du module"
        columns={columns}
        rows={rows}
        rowKey={keyOf}
        loading={loading}
        onRowClick={(entry) => setOpened(keyOf(entry))}
      />
      {current ? (
        <Detail
          entry={current}
          result={current.kind === "schedule" ? results[scheduleKey(current.item)] : undefined}
          running={current.kind === "schedule" && runningNow === scheduleKey(current.item)}
          onClose={() => setOpened(undefined)}
          onToggle={(item, enabled) => void toggle(item, enabled)}
          onRun={(item) => void runNow(item)}
        />
      ) : null}
    </ModulePart>
  );
}
