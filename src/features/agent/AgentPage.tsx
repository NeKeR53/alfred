import { AppWindow, Archive, Bot, Code2, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type Action,
  Alert,
  ChatPage,
  ChatTranscript,
  EmptyState,
  InlineEdit,
  NotificationCenter,
  Skeleton,
  SkeletonGroup,
} from "socle-ui";
import { Row, Text } from "../../kit";
import { inTauri, invoke } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { openAgentsWindow } from "./agentsWindow";
import { Composer } from "./Composer";
import { ConversationList, GitSummaryPill, useWorkspaceGit } from "./ConversationList";
import { setCoordinator } from "./delegation";
import { PROVIDER_LABEL } from "./harness";
import { type ConversationHeader, type ConversationRuntime, MAX_TITLE_LENGTH } from "./model";
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

/** Conversations montrées dans le suivi : commencées et non archivées. */
const visibleConversations = (headers: readonly ConversationHeader[]) =>
  headers.filter((header) => !header.archived && header.started);

/**
 * Archive, puis propose de revenir en arrière ; les conversations archivées se retrouvent dans Réglages › Agents.
 * Comme dans OneApp, l’affichage n’attend ni l’arrêt du travail en cours ni l’enregistrement.
 */
function useArchiveConversation() {
  const archive = useAgents((state) => state.archive);
  const unarchive = useAgents((state) => state.unarchive);
  return (id: string, title: string) => {
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
}

/**
 * Panneau de détail de la page Agent. Fenêtre principale (`withList={false}`) : les détails de la conversation
 * ouverte (modifications), car la sidebar montre déjà les conversations. Fenêtre Agent détachée, sans sidebar :
 * la liste des conversations en plus.
 */
export function ConversationTracking({ withList = true }: { withList?: boolean } = {}) {
  const headers = useAgents((state) => state.headers);
  const activeId = useAgents((state) => state.activeId);
  const conversation = useAgents((state) => (state.activeId ? state.loaded[state.activeId] : undefined));
  const visible = useMemo(() => visibleConversations(headers), [headers]);
  const git = useWorkspaceGit(conversation);
  const archiveConversation = useArchiveConversation();
  return (
    <ConversationList
      conversations={visible}
      activeId={activeId}
      active={conversation}
      git={git}
      onArchive={(header) => archiveConversation(header.id, header.title)}
      withList={withList}
    />
  );
}

/** Page Agent : la conversation ouverte ; ses détails vont dans le panneau de détail (`ConversationTracking`). */
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

  const visible = useMemo(() => visibleConversations(headers), [headers]);
  const archiveConversation = useArchiveConversation();

  // Une conversation est toujours ouverte : la saisie est disponible dès l’arrivée sur la page.
  useEffect(() => {
    if (ready && !activeId) void open(visible[0]?.id ?? create().id);
  }, [ready, activeId, visible, open, create]);

  // Un brouillon abandonné ne s’accumule pas : « Nouvelle conversation » réutilise celui qui est ouvert.
  const draft = conversation && !conversation.started ? conversation : undefined;
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
      {/* Colonne de la conversation : son titre et ses actions, puis le relevé ; dans la fenêtre détachée, le suivi
        des conversations est à côté. */}
      <div className="agents-page__lead">
        <ChatPage
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
          // Le dépôt de fichiers arrive par le système (Tauri) : la saisie le signale, la page montre le cadre.
          isDraggingFiles={dragging}
          alerts={
            saveError ? (
              <Alert
                tone="danger"
                action={
                  retrySave
                    ? { label: "Réessayer la sauvegarde", onPress: () => void retrySave().catch(() => undefined) }
                    : undefined
                }
              >
                {saveError}
              </Alert>
            ) : undefined
          }
          // Comme OneApp : la question de l’agent ou l’autorisation attendue se pose au-dessus de la saisie.
          question={conversation ? <ConversationQuestion conversation={conversation} runtime={runtime} /> : undefined}
          composer={
            conversation ? (
              <Composer
                conversation={conversation}
                responding={runtime.status !== "idle"}
                status={<GitSummaryPill git={git} />}
                onDraggingChange={setDragging}
              />
            ) : undefined
          }
        >
          {/* Chargement, échec et conversation vide : l’emplacement vide du relevé de Socle. */}
          {!ready && !loadError ? (
            <ChatTranscript
              empty={
                <SkeletonGroup label="Chargement des conversations…">
                  <Skeleton width="60%" />
                  <Skeleton />
                  <Skeleton width="80%" />
                  <Skeleton width="40%" />
                </SkeletonGroup>
              }
            />
          ) : loadError ? (
            <ChatTranscript
              empty={
                <Alert tone="danger" action={{ label: "Réessayer", onPress: () => void load().catch(reportLoad) }}>
                  L’historique des agents n’a pas pu être chargé.
                </Alert>
              }
            />
          ) : conversation?.turns.length ? (
            <Transcript
              conversation={conversation}
              runtime={runtime}
              context={{
                modelLabel: modelChoiceLabel(
                  { provider: conversation.provider, model: conversation.model, effort: conversation.effort },
                  models,
                ),
              }}
            />
          ) : (
            <ChatTranscript
              label={conversation ? `Conversation de ${conversation.title}` : undefined}
              empty={
                <EmptyState
                  title="Que puis-je faire pour vous ?"
                  description="Dites-moi ce dont vous avez besoin : je le mets en place et je vous dis où le trouver."
                />
              }
            />
          )}
        </ChatPage>
      </div>
      {detached ? (
        // Fenêtre Agent détachée : pas d’AppShell, le suivi reste à côté de la conversation.
        <aside className="agents-page__side" aria-label="Suivi des conversations">
          <ConversationTracking />
        </aside>
      ) : null}
    </section>
  );
}
