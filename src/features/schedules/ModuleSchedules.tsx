import { Button, DataTable, type DataTableColumn, Row, Stack, StatusBadge, SwitchControl, Text } from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { ModulePart } from "../modules/ModulePart";
import { errorMessage } from "../vault/api";
import {
  cadence,
  listSchedules,
  type RunResult,
  runScheduleNow,
  type ScheduleItem,
  scheduleKey,
  setScheduleEnabled,
} from "./api";

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

const STATUS = {
  running: { label: "En cours", tone: "neutral" },
  ok: { label: "Réussie", tone: "success" },
  error: { label: "Échec", tone: "danger" },
} as const;

/** Sortie d’une exécution, résumée sur une ligne. */
function summarize(output: unknown): string {
  if (output === undefined || output === null) return "Aucune sortie.";
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Partie « Planifications » de la fiche d’un module (Réglages → Modules) : ses fonctions déclenchées à heure fixe ou
 * à intervalle, Alfred ouvert ; rien quand le module n’en a pas.
 */
export function ModuleSchedules({ module }: { module: string }) {
  const [all, setItems] = useState<ScheduleItem[]>();
  const items = all?.filter((item) => item.module === module);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [runningNow, setRunningNow] = useState<string>();
  const [results, setResults] = useState<Record<string, RunResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listSchedules());
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
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
    setItems((current) => current?.map((other) => (scheduleKey(other) === key ? { ...other, enabled } : other)));
    try {
      await setScheduleEnabled(key, enabled);
      await load();
    } catch (failure) {
      setItems((current) =>
        current?.map((other) => (scheduleKey(other) === key ? { ...other, enabled: !enabled } : other)),
      );
      notify({
        title: enabled ? "La planification n’a pas repris" : "La planification n’a pas été mise en pause",
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

  if (items === undefined) {
    return error ? (
      <Text size="meta" tone="danger">
        Les planifications n’ont pas pu être lues. {error}
      </Text>
    ) : null;
  }
  if (items.length === 0) return null;

  const columns: DataTableColumn<ScheduleItem>[] = [
    {
      key: "description",
      header: "Planification",
      sortValue: (item) => item.description || item.id,
      render: (item) => (
        <Stack gap="none">
          <Text weight="medium">{item.description || item.id}</Text>
          <Text size="meta" tone="muted">
            Fonction {item.function}
          </Text>
          {item.functionExists ? null : (
            <Text size="meta" tone="danger">
              Fonction introuvable : les exécutions échoueront.
            </Text>
          )}
          {item.problem ? (
            <Text size="meta" tone="danger">
              {item.problem}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "cadence",
      header: "Rythme",
      width: "170px",
      sortValue: (item) => cadence(item),
      render: (item) => cadence(item).replace(/^./, (first) => first.toUpperCase()),
    },
    {
      key: "nextRunAt",
      header: "Prochaine exécution",
      width: "160px",
      align: "end",
      render: (item) => (!item.enabled ? "En pause" : item.nextRunAt ? dateTime.format(new Date(item.nextRunAt)) : "—"),
    },
    {
      key: "lastRunAt",
      header: "Dernière exécution",
      width: "190px",
      render: (item) => {
        const result = results[scheduleKey(item)];
        return (
          <Stack gap="xs">
            {item.lastRunAt ? (
              <Row gap="xs" wrap>
                <Text as="span">{dateTime.format(new Date(item.lastRunAt))}</Text>
                {item.lastStatus ? (
                  <StatusBadge tone={STATUS[item.lastStatus].tone} size="compact">
                    {STATUS[item.lastStatus].label}
                  </StatusBadge>
                ) : null}
              </Row>
            ) : (
              <Text tone="muted">Jamais</Text>
            )}
            {item.lastStatus === "error" && item.lastError ? (
              <Text size="meta" tone="danger">
                {item.lastError}
              </Text>
            ) : null}
            {result?.ok ? (
              <Text size="meta" tone="muted">
                Sortie : {summarize(result.output)}
              </Text>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      width: "220px",
      sortable: false,
      render: (item) => {
        const key = scheduleKey(item);
        const label = item.description || item.id;
        return (
          <Row gap="sm" justify="end" wrap>
            <SwitchControl
              label="Active"
              aria-label={`Planification ${label} active`}
              checked={item.enabled}
              onChange={(event) => void toggle(item, event.target.checked)}
            />
            <Button
              aria-label={`Exécuter maintenant ${label}`}
              loading={runningNow === key || item.running === true}
              loadingLabel="Exécution…"
              disabled={runningNow !== undefined && runningNow !== key}
              onClick={() => void runNow(item)}
            >
              Exécuter maintenant
            </Button>
          </Row>
        );
      },
    },
  ];

  return (
    <ModulePart
      part="schedules"
      title="Planifications"
      description="Fonctions du module lancées à heure fixe ou à intervalle, tant qu’Alfred est ouvert."
    >
      <DataTable
        label="Planifications du module"
        columns={columns}
        rows={items}
        rowKey={scheduleKey}
        loading={loading}
      />
    </ModulePart>
  );
}
