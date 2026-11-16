/**
 * Conversations archivées : masquées de la page Agent, rien n’est effacé. On les retrouve ici, comme les agents
 * archivés de OneApp dans Réglages › Agents (`ArchivedAgentsSettings`) : les plus récemment archivées d’abord, pour
 * les restaurer, les rouvrir ou les supprimer définitivement.
 */

import { Button, EmptyState, IconButton, List, ListItem, Row, Section, useConfirm } from "@alfred/ui";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { PROVIDER_LABEL } from "../agent/harness";
import type { ConversationHeader } from "../agent/model";
import { useAgents } from "../agent/store";

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

/** Date d’archivage, posée par le moteur des conversations ; les conversations archivées avant elle n’en ont pas. */
const archivedAt = (header: ConversationHeader) =>
  (header as ConversationHeader & { archivedAt?: number }).archivedAt ?? header.updatedAt;

const report = (error: unknown) =>
  notify({
    title: "Conversations archivées",
    description: error instanceof Error ? error.message : "L’action a échoué.",
    tone: "error",
  });

export function ArchivedConversations() {
  const headers = useAgents((state) => state.headers);
  const ready = useAgents((state) => state.ready);
  const load = useAgents((state) => state.load);
  const unarchive = useAgents((state) => state.unarchive);
  const open = useAgents((state) => state.open);
  const remove = useAgents((state) => state.remove);
  const setView = useShell((state) => state.setView);
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) void load().catch(() => undefined);
  }, [ready, load]);

  const archived = useMemo(
    () =>
      headers
        .filter((header) => header.archived && header.started)
        .sort((left, right) => archivedAt(right) - archivedAt(left)),
    [headers],
  );

  const restore = async (header: ConversationHeader) => {
    try {
      await unarchive(header.id);
      notify({
        title: "Conversation restaurée",
        description: `${header.title} est de nouveau dans la page Agent.`,
        tone: "success",
      });
    } catch (error) {
      report(error);
    }
  };

  const removeOne = async (header: ConversationHeader) => {
    const accepted = await confirm({
      title: `Supprimer définitivement « ${header.title} » ?`,
      message:
        "Son relevé et ses fichiers d’échange sont effacés et ne pourront pas être restaurés. Ce que l’agent a créé dans l’espace reste en place.",
      confirmLabel: "Supprimer définitivement",
      tone: "danger",
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await remove(header.id);
      notify({ title: "Conversation supprimée", description: header.title, tone: "success" });
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    const targets = [...archived];
    const accepted = await confirm({
      title: `Supprimer les ${targets.length} conversations archivées ?`,
      message:
        "Leurs relevés et leurs fichiers d’échange sont effacés et ne pourront pas être restaurés. Ce que les agents ont créé dans l’espace reste en place.",
      confirmLabel: "Tout supprimer",
      tone: "danger",
    });
    if (!accepted) return;
    setBusy(true);
    try {
      for (const header of targets) await remove(header.id);
      notify({
        title: "Conversations supprimées",
        description: `${targets.length} conversation${targets.length > 1 ? "s" : ""} effacée${targets.length > 1 ? "s" : ""}.`,
        tone: "success",
      });
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={archived.length ? `Conversations archivées · ${archived.length}` : "Conversations archivées"}
      description="Masquées de la page Agent, sans rien effacer. Les restaurer les remet dans la liste."
      actions={
        archived.length > 1 ? (
          <Button variant="danger" disabled={!ready || busy} onClick={() => void removeAll()}>
            Tout supprimer
          </Button>
        ) : undefined
      }
    >
      {archived.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucune conversation archivée"
          description="Archivez une conversation depuis la page Agent."
        />
      ) : (
        <List label="Conversations archivées">
          {archived.map((header) => (
            <ListItem
              key={header.id}
              title={header.title}
              description={[
                PROVIDER_LABEL[header.provider],
                header.origin ? `depuis ${header.origin.title}` : "",
                `archivée le ${dateTime.format(archivedAt(header))}`,
              ]
                .filter(Boolean)
                .join(" · ")}
              trailing={
                <Row gap="xs">
                  <IconButton
                    size="small"
                    label={`Restaurer ${header.title}`}
                    tooltip="Restaurer"
                    disabled={!ready || busy}
                    onClick={() => void restore(header)}
                  >
                    <ArchiveRestore size={15} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="small"
                    label={`Supprimer définitivement ${header.title}`}
                    tooltip="Supprimer définitivement"
                    disabled={!ready || busy}
                    onClick={() => void removeOne(header)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </IconButton>
                  <Button
                    variant="primary"
                    aria-label={`Ouvrir ${header.title}`}
                    disabled={busy}
                    onClick={async () => {
                      await unarchive(header.id);
                      await open(header.id);
                      setView({ kind: "agent" });
                    }}
                  >
                    Ouvrir
                  </Button>
                </Row>
              }
            />
          ))}
        </List>
      )}
      {confirmDialog}
    </Section>
  );
}
