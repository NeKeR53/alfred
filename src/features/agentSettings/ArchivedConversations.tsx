/**
 * Conversations archivées : masquées de la page Agent, rien n’est effacé. On les retrouve ici, comme les agents
 * archivés de OneApp dans Réglages › Agents (`ArchivedAgentsSettings`) : les plus récemment archivées d’abord, pour
 * les restaurer ou les supprimer définitivement, avec leur brouillon.
 */

import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { List, SettingsPage, type SettingsSection, useConfirm } from "socle-ui";
import { notify } from "../../shell/notifications";
import { useComposerDrafts } from "../agent/drafts";
import { PROVIDER_LABEL } from "../agent/harness";
import type { ConversationHeader } from "../agent/model";
import { useAgents } from "../agent/store";

/** « 4 nov. 2026, 09:12 », comme `formatDateTime` de OneApp. */
const dateTime = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Supprime la conversation puis son brouillon, comme OneApp (`deleteChatDraft`) ; un brouillon illisible part sans bruit. */
async function removeWithDraft(remove: (id: string) => Promise<void>, id: string) {
  await remove(id);
  const drafts = useComposerDrafts.getState();
  drafts.clear(id);
  await drafts.discardUnreadable(id).catch(() => undefined);
}

/** Date d’archivage, posée par le moteur des conversations ; les conversations archivées avant elle n’en ont pas. */
const archivedAt = (header: ConversationHeader) =>
  (header as ConversationHeader & { archivedAt?: number }).archivedAt ?? header.updatedAt;

const report = (error: unknown) =>
  notify({
    title: "Conversations archivées",
    description: error instanceof Error ? error.message : "L’action a échoué.",
    tone: "error",
  });

/** Section « Conversations archivées » de la rubrique Agent : les restaurer, ou les supprimer définitivement. */
export function useArchivedSection(): SettingsSection {
  const headers = useAgents((state) => state.headers);
  const ready = useAgents((state) => state.ready);
  const load = useAgents((state) => state.load);
  const unarchive = useAgents((state) => state.unarchive);
  const remove = useAgents((state) => state.remove);
  const confirm = useConfirm();

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
        "Son relevé et ses fichiers d’échange sont effacés et ne pourront pas être restaurés. Ce que l’agent a créé dans l’espace de travail reste en place.",
      confirmLabel: "Supprimer définitivement",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await removeWithDraft(remove, header.id);
      notify({ title: "Conversation supprimée", description: header.title, tone: "success" });
    } catch (error) {
      report(error);
    }
  };

  const removeAll = async () => {
    const targets = [...archived];
    try {
      for (const header of targets) await removeWithDraft(remove, header.id);
      notify({
        title: "Conversations supprimées",
        description: `${targets.length} conversation${targets.length > 1 ? "s" : ""} effacée${targets.length > 1 ? "s" : ""}.`,
        tone: "success",
      });
    } catch (error) {
      report(error);
    }
  };

  const byId = new Map(archived.map((header) => [header.id, header]));

  return {
    id: "archived",
    title: archived.length ? `Conversations archivées · ${archived.length}` : "Conversations archivées",
    description: "Masquées de la page Agent, sans rien effacer. Les restaurer les remet dans la liste.",
    actions: [
      {
        id: "remove-all",
        label: "Tout supprimer",
        danger: true,
        isHidden: archived.length < 2,
        isDisabled: !ready,
        confirm: {
          title: `Supprimer les ${archived.length} conversations archivées ?`,
          message:
            "Leurs relevés et leurs fichiers d’échange sont effacés et ne pourront pas être restaurés. Ce que les agents ont créé dans l’espace de travail reste en place.",
          confirmLabel: "Tout supprimer",
        },
        onPress: removeAll,
      },
    ],
    emptyMessage: archived.length
      ? undefined
      : "Aucune conversation archivée. Archivez une conversation depuis la page Agent.",
    content: archived.length ? (
      <List
        label="Conversations archivées"
        items={archived.map((header) => ({
          id: header.id,
          title: header.title,
          subtitle: `${PROVIDER_LABEL[header.provider]} · archivée le ${dateTime.format(archivedAt(header))}`,
        }))}
        itemActions={(item) => {
          const header = byId.get(item.id);
          if (!header) return [];
          return [
            {
              icon: <ArchiveRestore size={16} aria-hidden="true" />,
              label: `Restaurer ${header.title}`,
              onPress: () => void restore(header),
            },
            {
              icon: <Trash2 size={16} aria-hidden="true" />,
              label: `Supprimer définitivement ${header.title}`,
              onPress: () => void removeOne(header),
            },
          ];
        }}
      />
    ) : undefined,
  };
}

/** La section seule, dans un gabarit de réglages : pour un hôte qui ne passe pas par la rubrique Agent. */
export function ArchivedConversations() {
  const section = useArchivedSection();
  return (
    <SettingsPage
      groups={[
        {
          id: "agent",
          categories: [
            {
              id: "archived",
              label: "Conversations archivées",
              icon: <Archive size={16} aria-hidden="true" />,
              sections: [section],
            },
          ],
        },
      ]}
    />
  );
}
