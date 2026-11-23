/**
 * Historique d’une page : les commits de l’espace qui ont touché son fichier (tours d’agent, réorganisations,
 * fusions…), du plus récent au plus ancien, chacun annulable. Ouvert depuis le menu d’un onglet et depuis l’écran
 * Navigation des Réglages.
 */

import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Dialog, EmptyState, Table, type TableColumn, useConfirm } from "socle-ui";
import { Notice } from "../../kit";
import { invoke } from "../../lib/native";
import type { Commit, ResolvedPage } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";

/** Fichier de la page dans l’espace, tel que git le connaît. */
export function pageFile(page: Pick<ResolvedPage, "module" | "id">): string {
  return `modules/${page.module}/pages/${page.id}.tsx`;
}

/** Ce que l’annulation emporte en plus de la page : rien à dire si la modification ne touchait qu’elle. */
export function undoScope(commit: Pick<Commit, "files">, file: string): string {
  const others = commit.files.filter((path) => path !== file).length;
  if (others === 0) return "";
  return others === 1
    ? " Il défait aussi l’autre fichier touché par cette modification."
    : ` Il défait aussi les ${others} autres fichiers touchés par cette modification.`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

const COLUMNS: TableColumn[] = [
  { id: "message", label: "Modification" },
  { id: "when", label: "Date", width: 190 },
];

export function PageHistoryDialog({ page, onClose }: { page: ResolvedPage; onClose: () => void }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      setCommits(await invoke<Commit[]>("space.history", { path: pageFile(page), limit: 100 }));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (commit: Commit) => {
    const accepted = await confirm({
      title: "Annuler cette modification ?",
      message: `« ${commit.message} » est défait par un nouveau commit.${undoScope(commit, pageFile(page))} L’annulation elle-même reste annulable.`,
      confirmLabel: "Annuler la modification",
      cancelLabel: "Garder",
      tone: "default",
    });
    if (!accepted) return;
    setUndoing(true);
    try {
      await invoke("space.undo", { commit: commit.id });
      await useShell.getState().refresh();
      notify({ title: "Modification annulée", description: commit.message, tone: "success" });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setUndoing(false);
    }
  };

  const rows = (commits ?? []).map((commit, index) => ({
    ...commit,
    when: `${when(commit.date)}${index === 0 ? " · dernière" : ""}`,
  }));

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      isBusy={undoing}
      title={`Historique de « ${page.title} »`}
      description={pageFile(page)}
    >
      {error ? (
        <Notice tone="danger" title="L’historique n’a pas pu être lu">
          {error}
        </Notice>
      ) : null}
      {commits?.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucune modification enregistrée"
          description="La page n’a pas encore été modifiée depuis sa création."
        />
      ) : error && commits === null ? null : (
        <Table
          label={`Modifications de ${page.title}`}
          columns={COLUMNS}
          rows={rows}
          density="compact"
          isLoading={commits === null}
          rowActions={(commit) => [
            {
              icon: <Undo2 size={16} aria-hidden="true" />,
              label: "Annuler",
              onPress: () => void undo(commit),
            },
          ]}
        />
      )}
    </Dialog>
  );
}
