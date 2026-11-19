/**
 * Partie « Partage en équipe » de la fiche d’un module (Réglages → Modules) : les tables que le module partage, le
 * dépôt git de l’équipe auquel il est relié, l’état de la dernière synchronisation, et de quoi relier, synchroniser
 * ou arrêter le partage. Visible seulement pour un module qui déclare des tables à partager (`sync.tables`).
 */
import {
  Button,
  FeedbackBanner,
  FormControlGroup,
  FormField,
  KeyValueList,
  RefreshButton,
  Text,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { ModulePart } from "../modules/ModulePart";

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

export function TeamSync({ module }: { module: ModuleSummary }) {
  const [status, setStatus] = useState<SyncStatus>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"link" | "run" | "unlink">();
  const [error, setError] = useState<string>();
  const { confirm, confirmDialog } = useConfirm();
  const shared = (module.sync ?? []).length > 0;

  const load = useCallback(async () => {
    try {
      setStatus(await invoke<SyncStatus>("teamSync.status", { module: module.id }));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [module.id]);

  useEffect(() => {
    if (!shared) return;
    void load();
    return onNativeEvent("teamSync:changed", (payload) => {
      if ((payload as { module?: string } | null)?.module === module.id) void load();
    });
  }, [shared, load, module.id]);

  if (!shared) return null;

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
    });
    if (accepted) void act("unlink", () => invoke<SyncStatus>("teamSync.unlink", { module: module.id }));
  };

  const current = status?.link;
  return (
    <ModulePart
      part="team-sync"
      title="Partage en équipe"
      description={`Les données de ${(module.sync ?? []).join(", ")} se partagent avec votre équipe par un dépôt git : chacun voit ce que les autres ajoutent ou modifient.`}
      actions={
        current ? (
          <RefreshButton
            label="Synchroniser maintenant"
            loading={busy === "run"}
            disabled={busy !== undefined}
            onClick={() => void act("run", () => invoke<SyncStatus>("teamSync.run", { module: module.id }))}
          />
        ) : undefined
      }
    >
      {status?.problems.map((problem) => (
        <FeedbackBanner key={problem} tone="warning" appearance="contained">
          {problem}
        </FeedbackBanner>
      ))}
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
      {current ? (
        <>
          <KeyValueList
            items={[
              { label: "Dépôt de l’équipe", value: current.url },
              {
                label: "Dernière synchronisation",
                value: current.lastSync
                  ? `${dateTime.format(new Date(current.lastSync))} · ${lines(current.received)} reçue(s), ${lines(current.sent)} envoyée(s)${current.conflicts ? `, ${current.conflicts} conflit(s)` : ""}`
                  : "Jamais",
              },
            ]}
          />
          {current.lastError ? (
            <Text size="meta" tone="danger">
              Dernier échec : {current.lastError}
            </Text>
          ) : null}
          <Text size="meta" tone="muted">
            Synchronisé toutes les deux minutes tant qu’Alfred est ouvert. Si une même ligne change des deux côtés, la
            version de l’équipe est gardée et la vôtre est notée au journal.
          </Text>
          <div>
            <Button variant="outline" disabled={busy !== undefined} onClick={() => void unlink()}>
              Arrêter le partage
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={link}>
          <FormControlGroup>
            <FormField label="Adresse git du dépôt de l’équipe">
              <TextInput
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="git@exemple.fr:equipe/donnees-carnet.git"
                spellCheck={false}
                autoCapitalize="off"
                disabled={busy === "link"}
              />
            </FormField>
            <Button
              type="submit"
              variant="primary"
              loading={busy === "link"}
              loadingLabel="Connexion…"
              disabled={!url.trim() || busy !== undefined || (status?.problems.length ?? 0) > 0}
            >
              Partager
            </Button>
          </FormControlGroup>
          <Text size="meta" tone="muted">
            Chaque membre de l’équipe indique la même adresse. Alfred s’y connecte avec les accès git de ce poste.
          </Text>
        </form>
      )}
      {confirmDialog}
    </ModulePart>
  );
}
