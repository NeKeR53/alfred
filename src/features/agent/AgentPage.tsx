import {
  EmptyState,
  IconButton,
  InlineEdit,
  MenuItem,
  OverflowMenu,
  PageTopBar,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { Archive, Bot, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NotificationBell } from "../../shell/NotificationCenter";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { ConversationList, useConversationListPanel } from "./ConversationList";
import { PROVIDER_LABEL } from "./harness";
import type { ConversationRuntime } from "./model";
import { bindAgentQuestions, useAgents } from "./store";
import { Transcript } from "./Transcript";
import "./agent.css";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [] };

const startedAt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

/** Page Agent : les conversations de l’espace à gauche, la conversation ouverte au centre. */
export function AgentPage() {
  const spacePath = useShell((state) => state.snapshot?.path);
  const headers = useAgents((state) => state.headers);
  const activeId = useAgents((state) => state.activeId);
  const conversation = useAgents((state) => (state.activeId ? state.loaded[state.activeId] : undefined));
  const runtime = useAgents((state) => (state.activeId ? state.runtime[state.activeId] : undefined)) ?? idle;
  const ready = useAgents((state) => state.ready);
  const load = useAgents((state) => state.load);
  const open = useAgents((state) => state.open);
  const create = useAgents((state) => state.create);
  const remove = useAgents((state) => state.remove);
  const rename = useAgents((state) => state.rename);
  const archive = useAgents((state) => state.archive);
  const unarchive = useAgents((state) => state.unarchive);
  const markUnread = useAgents((state) => state.markUnread);
  const [renaming, setRenaming] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  // biome-ignore lint/correctness/useExhaustiveDependencies: les conversations sont celles de l’espace ouvert.
  useEffect(() => {
    bindAgentQuestions();
    void load().catch((error) =>
      notify({
        title: "Conversations non chargées",
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
    );
  }, [load, spacePath]);

  const visible = useMemo(() => headers.filter((header) => !header.archived && header.started), [headers]);

  /** Archive, puis propose de revenir en arrière ; les conversations archivées se retrouvent dans Réglages › Agents. */
  const archiveConversation = async (id: string, title: string) => {
    await archive(id);
    notify({
      title: "Conversation archivée",
      description: `${title} · retrouvez-la dans Réglages, onglet Agents.`,
      tone: "info",
      action: { label: "Annuler", run: () => void unarchive(id) },
    });
  };

  // Une conversation est toujours ouverte : la saisie est disponible dès l’arrivée sur la page.
  useEffect(() => {
    if (ready && !activeId) void open(visible[0]?.id ?? create().id);
  }, [ready, activeId, visible, open, create]);

  // Un brouillon abandonné ne s’accumule pas : « Nouvelle conversation » réutilise celui qui est ouvert.
  const draft = conversation && !conversation.started ? conversation : undefined;
  const panel = useConversationListPanel();
  const context = conversation
    ? [PROVIDER_LABEL[conversation.provider], conversation.origin ? `depuis ${conversation.origin.title}` : ""]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <section className="agents-page" aria-label="Agent">
      <PageTopBar
        className="agents-page__bar"
        title={
          <InlineEdit
            key={conversation?.id}
            className="agents-page__title-edit"
            label="Nom de la conversation"
            value={conversation?.title ?? ""}
            disabled={!conversation?.started}
            editing={renaming}
            onEditingChange={setRenaming}
            // Vide, l’ancien nom est gardé.
            onSave={(title) => {
              if (conversation && title.trim() && title.trim() !== conversation.title)
                void rename(conversation.id, title);
            }}
            renderEditor={(editor) => (
              <TextInput
                className="agents-page__title-input"
                aria-label={editor.label}
                value={editor.value}
                maxLength={120}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => editor.setValue(event.target.value)}
              />
            )}
          >
            <h1>{conversation?.title ?? "Agent"}</h1>
          </InlineEdit>
        }
        context={context}
        panelToggle={{
          hidden: panel.layout.hidden,
          onToggle: () => panel.setHidden(!panel.layout.hidden),
          subject: "le suivi des conversations",
        }}
      >
        <IconButton
          className="agents-page__new-agent"
          label="Nouvelle conversation"
          disabled={draft !== undefined}
          onClick={() => void open(create().id)}
        >
          <Bot size={16} aria-hidden="true" />
        </IconButton>
        {conversation?.started ? (
          <IconButton
            label={`Archiver ${conversation.title}`}
            tooltip="Archiver la conversation"
            onClick={() => void archiveConversation(conversation.id, conversation.title)}
          >
            <Archive size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        {conversation?.started ? (
          <OverflowMenu label="Autres actions sur la conversation">
            <MenuItem onClickCapture={() => setRenaming(true)}>Renommer</MenuItem>
            <MenuItem onClickCapture={() => void markUnread(conversation.id)}>Marquer comme non lue</MenuItem>
          </OverflowMenu>
        ) : null}
        {conversation && conversation.turns.length > 0 ? (
          <IconButton
            label="Supprimer la conversation"
            tooltip="Supprimer la conversation"
            onClick={async () => {
              const accepted = await confirm({
                title: "Supprimer cette conversation ?",
                message:
                  "Son relevé et ses fichiers d’échange sont supprimés d’Alfred. Ce que l’agent a créé dans l’espace reste en place.",
                confirmLabel: "Supprimer",
                tone: "danger",
              });
              if (accepted) await remove(conversation.id);
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <NotificationBell />
      </PageTopBar>
      {confirmDialog}
      <div className="agents-page__body">
        <section className="agents-page__main" aria-label="Conversation et saisie">
          {conversation ? (
            <>
              {conversation.turns.length === 0 ? (
                <div className="agents-page__state">
                  <EmptyState
                    title="Que voulez-vous construire ?"
                    description="Décrivez une page, un panneau ou une fonction : l’agent demande où la placer, l’écrit, et elle apparaît dans l’application."
                  />
                </div>
              ) : (
                <Transcript
                  conversation={conversation}
                  runtime={runtime}
                  header={<p className="agents-page__context">{startedAt.format(conversation.createdAt)}</p>}
                />
              )}
              <div className="agents-page__footer">
                <Composer conversation={conversation} responding={runtime.status !== "idle"} />
              </div>
            </>
          ) : null}
        </section>
        {panel.layout.hidden ? null : (
          <ConversationList
            conversations={visible}
            activeId={activeId}
            active={conversation}
            panel={panel}
            onArchive={(header) => void archiveConversation(header.id, header.title)}
          />
        )}
      </div>
    </section>
  );
}
