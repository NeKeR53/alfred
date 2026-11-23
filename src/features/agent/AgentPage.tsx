import { AppWindow, Archive, Bot, Code2, FolderOpen, PanelRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type Action,
  Button,
  EmptyState,
  IconButton,
  InlineEdit,
  NotificationCenter,
  Page,
  Skeleton,
  SkeletonGroup,
} from "socle-ui";
import { Notice, Row, Text } from "../../kit";
import { inTauri, invoke } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { openAgentsWindow } from "./agentsWindow";
import { Composer } from "./Composer";
import { ConversationList, GitSummaryPill, useConversationListPanel, useWorkspaceGit } from "./ConversationList";
import { setCoordinator } from "./delegation";
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

const startedAt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

/** Page Agent : les conversations de l’espace à gauche, la conversation ouverte au centre. */
/** `detached` : la page Agent seule, dans sa fenêtre (`agentsWindow.ts`). */
export function AgentPage({ detached = false }: { detached?: boolean } = {}) {
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

  const failed = (title: string) => (error: unknown) =>
    notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
  const actions: Action[] = [
    {
      id: "new",
      label: "Nouvelle conversation",
      icon: <Bot size={16} />,
      isDisabled: draft !== undefined,
      onPress: () => void open(create().id),
    },
    {
      id: "editor",
      label: "Ouvrir le dossier dans l’éditeur",
      icon: <Code2 size={15} />,
      isHidden: !conversation,
      isDisabled: !conversation?.cwd || !textEditor,
      onPress: () => void openInEditor(),
    },
    {
      id: "explorer",
      label: "Ouvrir le dossier dans l’explorateur",
      icon: <FolderOpen size={15} />,
      isHidden: !conversation,
      isDisabled: !conversation?.cwd,
      onPress: () => void openInExplorer(),
    },
    {
      id: "archive",
      label: `Archiver ${conversation?.title ?? ""}`,
      icon: <Archive size={16} />,
      isHidden: !conversation?.started,
      onPress: () => conversation && archiveConversation(conversation.id, conversation.title),
    },
    {
      id: "window",
      label: "Ouvrir la page Agent dans une fenêtre",
      icon: <AppWindow size={15} />,
      isHidden: detached || !inTauri,
      onPress: () => void openAgentsWindow().catch(failed("Fenêtre Agent non ouverte")),
    },
    {
      id: "panel",
      label: panel.layout.hidden ? "Afficher le suivi des conversations" : "Masquer le suivi des conversations",
      icon: <PanelRight size={15} />,
      onPress: () => panel.setHidden(!panel.layout.hidden),
    },
    {
      id: "rename",
      label: "Renommer",
      shortcut: "F2",
      isHidden: !conversation?.started,
      onPress: () => setRenaming(true),
    },
    {
      id: "unread",
      label: "Marquer comme non lue",
      isHidden: !conversation?.started,
      onPress: () => conversation && void markUnread(conversation.id),
    },
    {
      // Une coordinatrice confie des tâches à d’autres agents ; un délégué ne délègue pas.
      id: "coordinator",
      label: conversation?.coordinator ? "Ne plus répartir le travail" : "Répartir le travail entre des agents",
      isHidden: !conversation || Boolean(conversation.parent),
      onPress: () =>
        conversation &&
        void setCoordinator(conversation.id, !conversation.coordinator).catch(failed("Répartition impossible")),
    },
  ];

  return (
    <section className="agents-page" aria-label="Agent">
      <div className="agents-page__body">
        {/* Colonne de la conversation : son titre et ses actions, puis le relevé. La barre du haut est celle de la
          coquille ; la liste des conversations est à côté. */}
        <div className="agents-page__lead">
          <Page
            fill
            actionsLabel="la conversation"
            actions={actions}
            toolbar={
              <Row gap="sm">
                <div className="agents-page__title">
                  <InlineEdit
                    key={conversation?.id}
                    label="Nom de la conversation"
                    value={conversation?.title ?? "Agent"}
                    isDisabled={!conversation?.started}
                    isEditing={renaming}
                    onEditingChange={setRenaming}
                    maxLength={MAX_TITLE_LENGTH}
                    // Vide, l’ancien nom est gardé.
                    onSave={(title) => {
                      if (conversation && title.trim() && title.trim() !== conversation.title)
                        void rename(conversation.id, title);
                    }}
                  />
                </div>
                {context ? (
                  <Text as="span" tone="muted" size="meta">
                    {context}
                  </Text>
                ) : null}
                {detached ? <NotificationCenter /> : null}
              </Row>
            }
          >
            <section
              className={`agents-page__main${dragging ? " is-file-dragging" : ""}`}
              aria-label="Conversation et saisie"
            >
              {!ready && !loadError ? (
                <div className="agents-page__state">
                  <SkeletonGroup label="Chargement des conversations…">
                    <Skeleton width="60%" />
                    <Skeleton />
                    <Skeleton width="80%" />
                    <Skeleton width="40%" />
                  </SkeletonGroup>
                </div>
              ) : loadError ? (
                <div className="agents-page__state">
                  <Notice
                    tone="danger"
                    action={<Button onPress={() => void load().catch(reportLoad)}>Réessayer</Button>}
                  >
                    L’historique des agents n’a pas pu être chargé.
                  </Notice>
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
                      <Notice
                        tone="danger"
                        action={
                          retrySave ? (
                            <Button onPress={() => void retrySave().catch(() => undefined)}>
                              Réessayer la sauvegarde
                            </Button>
                          ) : undefined
                        }
                      >
                        {saveError}
                      </Notice>
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
          </Page>
        </div>
        {panel.layout.hidden ? null : (
          // Liste des conversations, sur toute la hauteur.
          <aside className="agents-page__side">
            <div className="agents-page__side-head">
              <Row gap="sm" justify="between">
                <Text as="span" weight="strong">
                  Suivi des conversations
                </Text>
                <IconButton
                  icon={<X size={15} />}
                  label="Masquer le suivi des conversations"
                  onPress={() => panel.setHidden(true)}
                />
              </Row>
            </div>
            <ConversationList
              conversations={visible}
              activeId={activeId}
              active={conversation}
              panel={panel}
              git={git}
              onArchive={(header) => archiveConversation(header.id, header.title)}
            />
          </aside>
        )}
      </div>
    </section>
  );
}
