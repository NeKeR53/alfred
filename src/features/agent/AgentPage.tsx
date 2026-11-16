import {
  Button,
  EmptyState,
  FeedbackBanner,
  IconButton,
  InlineEdit,
  LoadingSkeleton,
  MenuItem,
  OverflowMenu,
  PageTopBar,
  TextInput,
} from "@alfred/ui";
import { Archive, Bot, Code2, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/native";
import { NotificationBell } from "../../shell/NotificationCenter";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { ConversationList, GitSummaryPill, useConversationListPanel, useWorkspaceGit } from "./ConversationList";
import { PROVIDER_LABEL } from "./harness";
import { type ConversationRuntime, MAX_TITLE_LENGTH } from "./model";
import { modelChoiceLabel, useHarnessModels, usePreferences } from "./panel/ModelPicker";
import { bindAgentQuestions, useAgents } from "./store";
import { ConversationQuestion, Transcript } from "./Transcript";
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
  const rename = useAgents((state) => state.rename);
  const archive = useAgents((state) => state.archive);
  const unarchive = useAgents((state) => state.unarchive);
  const markUnread = useAgents((state) => state.markUnread);
  const loadError = useAgents((state) => (state as Persistence).loadError);
  const saveError = useAgents((state) => (state as Persistence).saveError);
  const retrySave = useAgents((state) => (state as Persistence).retrySave);
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
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

  /**
   * Archive, puis propose de revenir en arrière ; les conversations archivées se retrouvent dans Réglages › Agents.
   * Comme dans OneApp, l’affichage n’attend ni l’arrêt du travail en cours ni l’enregistrement.
   */
  const archiveConversation = (id: string, title: string) => {
    void archive(id).catch((error) =>
      notify({ title: "Conversation non archivée", description: errorText(error), tone: "error" }),
    );
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
  // Comme la portée de l’agent dans OneApp : le harnais en contexte du titre ; l’origine va au-dessus du relevé.
  const context = conversation ? PROVIDER_LABEL[conversation.provider] : undefined;
  const models = useHarnessModels(conversation?.provider ?? "claude", conversation?.cwd || spacePath || "");

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
                maxLength={MAX_TITLE_LENGTH}
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
            onClick={() => archiveConversation(conversation.id, conversation.title)}
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
        <NotificationBell />
      </PageTopBar>
      <div className="agents-page__body">
        <section
          className={`agents-page__main${dragging ? " is-file-dragging" : ""}`}
          aria-label="Conversation et saisie"
        >
          {!ready && !loadError ? (
            <div className="agents-page__state" aria-busy="true">
              <LoadingSkeleton variant="page" rows={4} label="Chargement des conversations…" />
            </div>
          ) : loadError ? (
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
                  dockQuestion={false}
                  header={
                    <p
                      className="agents-page__context"
                      title={modelChoiceLabel(
                        { provider: conversation.provider, model: conversation.model, effort: conversation.effort },
                        models,
                      )}
                    >
                      {conversation.origin ? `Depuis ${conversation.origin.title} · ` : ""}
                      {startedAt.format(conversation.createdAt)}
                    </p>
                  }
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
                {/* Comme OneApp : la question de l’agent ou l’autorisation attendue se pose au-dessus de la saisie. */}
                <div className="agents-page__question">
                  <ConversationQuestion
                    conversation={conversation}
                    runtime={runtime}
                    onOther={() =>
                      document
                        .querySelector<HTMLElement>(
                          '.agents-page__footer textarea, .agents-page__footer [contenteditable="true"]',
                        )
                        ?.focus()
                    }
                  />
                </div>
                <Composer
                  conversation={conversation}
                  responding={runtime.status !== "idle"}
                  status={<GitSummaryPill git={git} />}
                  onDraggingChange={setDragging}
                />
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
            onArchive={(header) => archiveConversation(header.id, header.title)}
          />
        )}
      </div>
    </section>
  );
}
