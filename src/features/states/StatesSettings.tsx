/**
 * Réglages → États : ce qui tourne dans le cœur. Chaque état suivi (un état et son jeu de paramètres, pour un compte),
 * ses abonnés (pages, fonctions, automatisations), sa politique de rafraîchissement et son dernier passage
 * (`states.overview`, `src-tauri/src/state_refresh.rs`). Lecture seule : un état s’arrête quand son dernier abonné
 * part.
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
  const last = refresher.running ? "En cours" : refresher.lastRunAt ? since(refresher.lastRunAt, now) : "Pas encore";
  const detail = [params(refresher.params), refresher.lastError ? `Erreur : ${refresher.lastError}` : ""]
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

  const load = useCallback(async () => {
    try {
      setRefreshers((await invoke<{ refreshers: Refresher[] }>("states.overview")).refreshers);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
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
  ];
}
