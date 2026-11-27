/**
 * Réglages → États : ce qui tourne dans le cœur. Chaque état suivi (un état et son jeu de paramètres, pour un compte),
 * ses abonnés (pages, fonctions, automatisations), sa politique de rafraîchissement et son dernier passage
 * (`states.overview`, `src-tauri/src/state_refresh.rs`). Un état s’arrête quand son dernier abonné part.
 *
 * Fraîcheur : l’âge maximal de chaque état déclaré (`states.freshness`). Une valeur plus jeune s’affiche sans être
 * relue ; plus vieille, elle se relit à l’ouverture et au retour sur une page. La valeur du fournisseur est le défaut ;
 * l’utilisateur en choisit une autre (`states.setMaxAge`).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, EmptyState, type SettingsSection, Table, type TableColumn } from "socle-ui";
import { Stack } from "../../kit";
import { invoke, onNativeEvent } from "../../lib/native";

export interface Refresher {
  key: string;
  state: string;
  description: string;
  params: Record<string, unknown>;
  instance: string;
  examples: boolean;
  subscribers: string[];
  every: number | null;
  incremental: boolean;
  mode: "subscribed" | "always" | null;
  function: string | null;
  running: boolean;
  runs: number;
  lastRunAt: number | null;
  lastError: string | null;
  failures: number;
  /** Âge maximal appliqué, en secondes. */
  maxAge?: number;
  /** Dernière lecture réussie (ms). */
  checkedAt?: number | null;
}

/** Un état déclaré, son âge maximal chez le fournisseur et celui choisi par l’utilisateur. */
export interface Freshness {
  state: string;
  module: string;
  description: string;
  defaultMaxAge: number;
  maxAge: number | null;
  every: number | null;
}

/** Âges proposés, en secondes. */
const AGES = [30, 60, 300, 900, 1800, 3600, 4 * 3600, 86_400];

/** « 30 s », « 5 min », « 1 h », « 1 jour ». */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  const days = Math.round(seconds / 86_400);
  return `${days} jour${days > 1 ? "s" : ""}`;
}

/** Choix de l’âge maximal d’un état : le défaut du fournisseur, puis les âges proposés. */
export function ageOptions(freshness: Freshness) {
  const ages = [...new Set([...AGES, ...(freshness.maxAge ? [freshness.maxAge] : [])])].sort((a, b) => a - b);
  return [
    { id: "default", label: `Défaut du fournisseur (${duration(freshness.defaultMaxAge)})` },
    ...ages.map((age) => ({ id: String(age), label: duration(age) })),
  ];
}

const COLUMNS: TableColumn[] = [
  { id: "state", label: "État" },
  { id: "account", label: "Compte", width: 120 },
  { id: "subscribers", label: "Abonnés" },
  { id: "policy", label: "Rafraîchissement", width: 200 },
  { id: "last", label: "Dernier passage", width: 150 },
  { id: "failures", label: "Échecs", align: "end", width: 80 },
];

const relative = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

/** « il y a 12 secondes », « il y a 3 minutes ». */
export function since(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  return relative.format(Math.round(minutes / 60), "hour");
}

function params(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name} = ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/** Une ligne du tableau : du texte, dans la langue de l’utilisateur. */
export function refresherRow(refresher: Refresher, now = Date.now()) {
  const subscribers = refresher.subscribers.length;
  const policy = refresher.every
    ? `Toutes les ${refresher.every} s${refresher.incremental ? ", incrémental" : ""}${refresher.mode === "always" ? ", toujours" : ""}`
    : "À la demande";
  const read = refresher.lastRunAt ?? refresher.checkedAt ?? null;
  const last = refresher.running ? "En cours" : read ? since(read, now) : "Pas encore";
  const detail = [
    params(refresher.params),
    refresher.maxAge ? `Relu au-delà de ${duration(refresher.maxAge)}` : "",
    refresher.lastError ? `Erreur : ${refresher.lastError}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: refresher.key,
    state: `${refresher.state}${refresher.examples ? " (exemple)" : ""}`,
    account: refresher.instance || "Par défaut",
    subscribers: subscribers === 1 ? (refresher.subscribers[0] ?? "") : `${subscribers} abonnés`,
    policy,
    last,
    failures: String(refresher.failures),
    detail,
  };
}

export function useStatesSections(): SettingsSection[] {
  const [refreshers, setRefreshers] = useState<Refresher[]>();
  const [error, setError] = useState<string>();

  const [freshness, setFreshness] = useState<Freshness[]>();
  const load = useCallback(async () => {
    try {
      const [overview, ages] = await Promise.all([
        invoke<{ refreshers: Refresher[] }>("states.overview"),
        invoke<{ states: Freshness[] }>("states.freshness"),
      ]);
      setRefreshers(overview.refreshers);
      setFreshness(ages.states);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  const choose = useCallback(async (state: string, id: string | null) => {
    const seconds = !id || id === "default" ? null : Number(id);
    setFreshness((await invoke<{ states: Freshness[] }>("states.setMaxAge", { name: state, seconds })).states);
  }, []);

  useEffect(() => {
    void load();
    // Après chaque rafraîchissement, le cœur prévient : le tableau se relit.
    const stop = onNativeEvent("states:refreshers", () => void load());
    return stop;
  }, [load]);

  const rows = (refreshers ?? []).map((refresher) => refresherRow(refresher));
  const failing = (refreshers ?? []).filter((refresher) => refresher.lastError).length;

  return [
    {
      id: "states",
      title: "États rafraîchis",
      description:
        refreshers && refreshers.length > 0
          ? failing > 0
            ? `${refreshers.length} état${refreshers.length > 1 ? "s" : ""} suivi${refreshers.length > 1 ? "s" : ""}, dont ${failing} en échec.`
            : `${refreshers.length} état${refreshers.length > 1 ? "s" : ""} suivi${refreshers.length > 1 ? "s" : ""}.`
          : undefined,
      content: (
        <Stack gap="sm">
          {error ? (
            <Alert announce tone="danger" action={{ label: "Réessayer", onPress: () => void load() }}>
              {`Les états suivis n’ont pas pu être lus : ${error}`}
            </Alert>
          ) : null}
          {refreshers && rows.length === 0 ? (
            <EmptyState
              size="compact"
              title="Aucun état suivi"
              description="Un état tourne ici dès qu’une page, une fonction ou une automatisation s’y abonne, ou s’il est rafraîchi toujours. Il s’arrête quand son dernier abonné part. Alfred fermé, rien ne tourne."
            />
          ) : (
            <Table
              label="États suivis par le cœur"
              columns={COLUMNS}
              rows={rows}
              density="compact"
              selectionMode="none"
              isLoading={refreshers === undefined && !error}
              rowDescription={(row) => (row as { detail: string }).detail || undefined}
            />
          )}
        </Stack>
      ),
    },
    {
      id: "states-freshness",
      title: "Fraîcheur",
      description:
        "Une valeur plus jeune que son âge maximal s’affiche sans être relue. Plus vieille, elle s’affiche aussi tout de suite, puis se relit en arrière-plan.",
      emptyMessage: freshness ? "Aucun module ne déclare d’état." : "Lecture des états…",
      settings: (freshness ?? []).map((row) => ({
        id: row.state,
        type: "select" as const,
        label: row.description || row.state,
        description: `${row.module} · ${row.state}`,
        value: row.maxAge ? String(row.maxAge) : "default",
        options: ageOptions(row),
        onChange: (id: string | null) => choose(row.state, id),
      })),
    },
  ];
}
