/**
 * Historique d’une page : les commits de l’espace qui ont touché son fichier (tours d’agent, réorganisations,
 * fusions…), du plus récent au plus ancien, chacun annulable. Ouvert depuis le menu d’un onglet et depuis l’écran
 * Navigation des Réglages.
 */

import { Button, Dialog, EmptyState, FeedbackBanner, Spinner, Text, useConfirm } from "@alfred/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import type { Commit, ResolvedPage } from "../../lib/types";
import { DialogHeader } from "../../shell/DialogHeader";
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

export function PageHistoryDialog({ page, onClose }: { page: ResolvedPage; onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

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
    });
    if (!accepted) return;
    setUndoing(commit.id);
    try {
      await invoke("space.undo", { commit: commit.id });
      await useShell.getState().refresh();
      notify({ title: "Modification annulée", description: commit.message, tone: "success" });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setUndoing(null);
    }
  };

  // La confirmation est rendue à côté du dialogue, pas dedans : sa fermeture (`close`) remonterait l’arbre React et
  // fermerait l’historique avec elle.
  return (
    <>
      <Dialog
        ref={dialog}
        className="nav-dialog nav-dialog--wide"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (undoing) event.preventDefault();
        }}
        onClose={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogHeader
          title={`Historique de « ${page.title} »`}
          subtitle={pageFile(page)}
          titleId={titleId}
          dialogRef={dialog}
        />
        <div className="nav-dialog__body">
          {error ? (
            <FeedbackBanner tone="error" appearance="contained">
              {error}
            </FeedbackBanner>
          ) : null}
          {commits === null && !error ? <Spinner label="Lecture de l’historique" /> : null}
          {commits?.length === 0 ? (
            <EmptyState
              size="compact"
              title="Aucune modification enregistrée"
              description="La page n’a pas encore été modifiée depuis sa création."
            />
          ) : null}
          {commits?.length ? (
            <ul className="nav-history" aria-label={`Modifications de ${page.title}`}>
              {commits.map((commit, index) => (
                <li key={commit.id} className="nav-history__row">
                  <span className="nav-history__text">
                    <Text as="span" weight="medium">
                      {commit.message}
                    </Text>
                    <Text as="span" tone="muted">
                      {when(commit.date)}
                      {index === 0 ? " · dernière" : ""}
                    </Text>
                  </span>
                  <Button
                    loading={undoing === commit.id}
                    loadingLabel="Annulation…"
                    disabled={undoing !== null}
                    onClick={() => void undo(commit)}
                    aria-label={`Annuler « ${commit.message} »`}
                  >
                    Annuler
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Dialog>
      {confirmDialog}
    </>
  );
}
