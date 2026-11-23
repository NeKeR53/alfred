/**
 * Partie « Partage en équipe » de la fiche d’un module (Réglages → Modules) : les tables que le module partage, le
 * dépôt git de l’équipe auquel il est relié, l’état de la dernière synchronisation, et de quoi relier, synchroniser
 * ou arrêter le partage. Visible seulement pour un module qui déclare des tables à partager (`sync.tables`).
 * C'est une `SettingsSection` de Socle : titre, description et action de section viennent du gabarit.
 */
import { RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, PropertyRow, type SettingsSection, TextInput, useConfirm } from "socle-ui";
import { Row, Stack, Text } from "../../kit";
import { invoke, onNativeEvent } from "../../lib/native";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";

interface SyncLink {
  url: string;
  lastSync: string | null;
  lastError: string | null;
  received: number;
  sent: number;
  conflicts: number;
}

interface SyncStatus {
  module: string;
  tables: string[];
  problems: string[];
  link: SyncLink | null;
  outcome?: { received: number; sent: number; conflicts: number };
}

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lines(count: number) {
  return `${count} ligne${count > 1 ? "s" : ""}`;
}

/** Section « Partage en équipe » de la fiche d'un module ; `null` sans fiche ouverte ou si le module ne partage aucune table. */
export function useTeamSyncSection(fiche: ModuleSummary | undefined): SettingsSection | null {
  const [status, setStatus] = useState<SyncStatus>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"link" | "run" | "unlink">();
  const [error, setError] = useState<string>();
  const confirm = useConfirm();
  const shared = (fiche?.sync ?? []).length > 0;
  const moduleId = fiche?.id ?? "";

  const load = useCallback(async () => {
    try {
      setStatus(await invoke<SyncStatus>("teamSync.status", { module: moduleId }));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [moduleId]);

  useEffect(() => {
    // Une autre fiche s’ouvre : rien de la précédente ne reste.
    setStatus(undefined);
    setError(undefined);
    setUrl("");
    if (!shared) return;
    void load();
    return onNativeEvent("teamSync:changed", (payload) => {
      if ((payload as { module?: string } | null)?.module === moduleId) void load();
    });
  }, [shared, load, moduleId]);

  if (!fiche || !shared) return null;
  const module = fiche;

  const act = async (kind: "link" | "run" | "unlink", run: () => Promise<SyncStatus>) => {
    setBusy(kind);
    setError(undefined);
    try {
      const next = await run();
      setStatus(next);
      if (next.outcome) {
        const { received, sent, conflicts } = next.outcome;
        notify({
          title: `${module.name} synchronisé`,
          description: `${lines(received)} reçue(s), ${lines(sent)} envoyée(s)${conflicts ? `, ${conflicts} conflit(s) : version de l’équipe gardée` : ""}.`,
          tone: "success",
        });
      }
      await useShell.getState().refresh();
    } catch (failure) {
      setError(errorMessage(failure));
      await load();
    } finally {
      setBusy(undefined);
    }
  };

  const link = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    void act("link", () => invoke<SyncStatus>("teamSync.link", { module: module.id, url: url.trim() }));
  };

  const unlink = async () => {
    const accepted = await confirm({
      title: "Arrêter le partage ?",
      message:
        "Les données restent dans ce poste et dans le dépôt de l’équipe, mais elles ne se synchronisent plus. Vous pourrez relier le module de nouveau.",
      confirmLabel: "Arrêter le partage",
      tone: "default",
    });
    if (accepted) void act("unlink", () => invoke<SyncStatus>("teamSync.unlink", { module: module.id }));
  };

  const current = status?.link;
  const content = (
    <Stack gap="md">
      {status?.problems.map((problem) => (
        <Alert key={problem} tone="warning">
          {problem}
        </Alert>
      ))}
      {error ? (
        <Alert announce tone="danger">
          {error}
        </Alert>
      ) : null}
      {current ? (
        <>
          <div>
            <PropertyRow label="Dépôt de l’équipe" value={current.url} />
            <PropertyRow
              label="Dernière synchronisation"
              value={
                current.lastSync
                  ? `${dateTime.format(new Date(current.lastSync))} · ${lines(current.received)} reçue(s), ${lines(current.sent)} envoyée(s)${current.conflicts ? `, ${current.conflicts} conflit(s)` : ""}`
                  : "Jamais"
              }
            />
          </div>
          {current.lastError ? (
            <Text size="meta" tone="danger">
              Dernier échec : {current.lastError}
            </Text>
          ) : null}
          <Text size="meta" tone="muted">
            Synchronisé toutes les deux minutes tant qu’Alfred est ouvert. Si une même ligne change des deux côtés, la
            version de l’équipe est gardée et la vôtre est notée au journal.
          </Text>
          <Row>
            <Button isDisabled={busy !== undefined} onPress={() => void unlink()}>
              Arrêter le partage
            </Button>
          </Row>
        </>
      ) : (
        <form onSubmit={link}>
          <Stack gap="sm">
            <TextInput
              label="Adresse git du dépôt de l’équipe"
              isRequired
              value={url}
              onChange={setUrl}
              placeholder="git@exemple.fr:equipe/donnees-carnet.git"
              isDisabled={busy === "link"}
              description="Chaque membre de l’équipe indique la même adresse. Alfred s’y connecte avec les accès git de ce poste."
            />
            <Row>
              <Button
                type="submit"
                variant="primary"
                isPending={busy === "link"}
                isDisabled={
                  !url.trim() || (busy !== undefined && busy !== "link") || (status?.problems.length ?? 0) > 0
                }
              >
                Partager
              </Button>
            </Row>
          </Stack>
        </form>
      )}
    </Stack>
  );
  return {
    id: "team",
    title: "Partage en équipe",
    description: `Les données de ${(module.sync ?? []).join(", ")} se partagent avec votre équipe par un dépôt git : chacun voit ce que les autres ajoutent ou modifient.`,
    actions: current
      ? [
          {
            id: "sync",
            label: "Synchroniser maintenant",
            icon: <RefreshCw size={16} aria-hidden="true" />,
            isDisabled: busy !== undefined && busy !== "run",
            onPress: () => act("run", () => invoke<SyncStatus>("teamSync.run", { module: module.id })),
          },
        ]
      : undefined,
    content,
  };
}
