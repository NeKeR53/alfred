import {
  Button,
  EmptyState,
  FeedbackBanner,
  IconButton,
  InlineEdit,
  MenuItem,
  OverflowMenu,
  PageTopBar,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { Archive, Bot, Code2, FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/native";
import { NotificationBell } from "../../shell/NotificationCenter";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { ConversationList, GitSummaryPill, useConversationListPanel, useWorkspaceGit } from "./ConversationList";
import { PROVIDER_LABEL } from "./harness";
import type { ConversationRuntime } from "./model";
import { usePreferences } from "./panel/ModelPicker";
import { bindAgentQuestions, useAgents } from "./store";
import { Transcript } from "./Transcript";
import "./agent.css";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

/**
 * État d’enregistrement exposé par le magasin des conversations (lot du moteur) : lu seulement s’il existe, pour les
 * bandeaux repris de OneApp.
 */
type Persistence = { loadError?: string; saveError?: string; retrySave?: () => Promise<void> };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const noFolder = "Aucun dossier de travail";

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
  const loadError = useAgents((state) => (state as Persistence).loadError);
  const saveError = useAgents((state) => (state as Persistence).saveError);
  const retrySave = useAgents((state) => (state as Persistence).retrySave);
  const [renaming, setRenaming] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const git = useWorkspaceGit(conversation);
  const { textEditor } = usePreferences();

  /** Sans état d’erreur dans le magasin, l’échec reste signalé par une notification. */
  const reportLoad = (error: unknown) => {
    if (!(useAgents.getState() as Persistence).loadError)
      notify({ title: "Conversations non chargées", description: errorText(error), tone: "error" });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: les conversations sont celles de l’espace ouvert.
  useEffect(() => {
    bindAgentQuestions();
    void load().catch(reportLoad);
  }, [load, spacePath]);

  // F2 renomme la conversation ouverte, comme « Renommer {titre} » dans OneApp.
  useEffect(() => {
    if (!conversation?.started || renaming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      setRenaming(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversation?.started, renaming]);

  const openInEditor = async () => {
    if (!conversation?.cwd || !textEditor) return;
    try {
      await invoke("agentWorkspace.openEditor", { command: textEditor.command, path: conversation.cwd });
    } catch (error) {
      notify({ title: "Ouverture dans l’éditeur impossible", description: errorText(error), tone: "error" });
    }
  };
  const openInExplorer = async () => {
    if (!conversation?.cwd) return;
    try {
      await invoke("agentWorkspace.openExplorer", { path: conversation.cwd });
    } catch (error) {
      notify({ title: "Ouverture impossible", description: errorText(error), tone: "error" });
    }
  };

  const visible = useMemo(() => headers.filter((header) => !header.archived && header.started), [headers]);

  /** Archive, puis propose de revenir en arrière ; les conversations archivées se retrouvent dans Réglages › Agents. */
  const archiveConversation = async (id: string, title: string) => {
    await archive(id);
    notify({
      title: "Conversation archivée",
      description: `${title} · retrouvez-la dans Réglages, onglet Agent.`,
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
        {conversation ? (
          <>
            <IconButton
              label="Ouvrir le dossier dans l’éditeur"
              tooltip={
                !conversation.cwd
                  ? noFolder
                  : textEditor
                    ? `Ouvrir dans l’éditeur · ${conversation.cwd}`
                    : "Choisissez un éditeur dans les réglages"
              }
              disabled={!conversation.cwd || !textEditor}
              onClick={() => void openInEditor()}
            >
              <Code2 size={15} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Ouvrir le dossier dans l’explorateur"
              tooltip={conversation.cwd ? `Ouvrir dans l’explorateur · ${conversation.cwd}` : noFolder}
              disabled={!conversation.cwd}
              onClick={() => void openInExplorer()}
            >
              <FolderOpen size={15} aria-hidden="true" />
            </IconButton>
          </>
        ) : null}
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
            <MenuItem
              onClickCapture={() => setRenaming(true)}
              aria-keyshortcuts="F2"
              title={`Renommer ${conversation.title} (F2)`}
            >
              Renommer
            </MenuItem>
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
          {loadError ? (
            <div className="agents-page__state">
              <FeedbackBanner action={<Button onClick={() => void load().catch(reportLoad)}>Réessayer</Button>}>
                L’historique des agents n’a pas pu être chargé.
              </FeedbackBanner>
            </div>
          ) : conversation ? (
            <>
              {conversation.turns.length === 0 ? (
                <div className="agents-page__state">
                  <EmptyState
                    title="Que puis-je faire pour vous ?"
                    description="Dites-moi ce dont vous avez besoin : je le mets en place et je vous dis où le trouver."
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
                {saveError ? (
                  <FeedbackBanner
                    className="agents-page__save-error"
                    action={
                      retrySave ? (
                        <Button onClick={() => void retrySave().catch(() => undefined)}>Réessayer la sauvegarde</Button>
                      ) : undefined
                    }
                  >
                    {saveError}
                  </FeedbackBanner>
                ) : null}
                <Composer conversation={conversation} responding={runtime.status !== "idle"} />
                <GitSummaryPill git={git} />
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
            git={git}
            onArchive={(header) => void archiveConversation(header.id, header.title)}
          />
        )}
      </div>
    </section>
  );
}
