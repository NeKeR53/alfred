import { IconButton } from "@alfred/ui";
import { Archive, FileDiff } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "../../lib/native";
import type { Commit, FileLines } from "../../lib/types";
import { PROVIDER_LABEL } from "./harness";
import type { Conversation, ConversationHeader } from "./model";
import {
  InfoPanel,
  type InfoPanelCard,
  InfoPanelNote,
  InfoPanelRows,
  type InfoPanelState,
  useInfoPanelLayout,
} from "./panel/InfoPanel";
import { useAgents } from "./store";
import { CONVERSATION_STATE_LABEL, type ConversationState, conversationState } from "./summary";

const cardIds = ["conversations", "changes"] as const;

/** Disposition du suivi des conversations, partagée entre le panneau et le bouton de la barre qui le masque. */
export function useConversationListPanel() {
  return useInfoPanelLayout("agent", cardIds);
}

/**
 * Ordre du suivi, comme la liste des agents de OneApp (`useAgents`) : la plus récemment créée d’abord. Une
 * conversation garde sa place pendant qu’elle travaille ou attend une réponse.
 */
export function compareConversations(left: ConversationHeader, right: ConversationHeader) {
  return right.createdAt - left.createdAt;
}

/** État de la ligne, comme `panelAgentState` de OneApp : une conversation en attente compte comme au travail. */
function rowState(state: ConversationState): ConversationState {
  return state === "waiting" ? "working" : state;
}

/**
 * Pastille de l’état, posée dans la marge de la ligne comme dans le suivi des agents de OneApp : au travail, réponse
 * attendue, échec, terminé ; une conversation en veille garde une pastille neutre.
 */
function dotOf(state: ConversationState) {
  return { glyph: <span className={`agent-list__dot agent-list__dot--${state}`} /> };
}

/** Dernière activité, comme dans OneApp : l’heure aujourd’hui, le jour et le mois avant. */
export function lastActivity(at: number, now: number) {
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** État Git d’un dépôt, lu par `agentWorkspace.gitSummary` (repris de `agent_local_git_summary` de OneApp). */
export interface GitSummary {
  root: string;
  files: Array<{ path: string; state: string }>;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
}

export type GitGroup = { name: string; path: string; summary?: GitSummary; error?: boolean };
export type GitChanges = { loading: boolean; groups: GitGroup[] };

const emptyGit: GitChanges = { loading: false, groups: [] };
const loadingGit: GitChanges = { loading: true, groups: [] };

/**
 * État Git du dossier de travail de la conversation, repris de `useAgentGitChanges` de OneApp : relu au changement de
 * conversation et à chaque fin de tour.
 */
export function useWorkspaceGit(conversation?: Conversation): GitChanges {
  const [state, setState] = useState<GitChanges & { scope?: string }>(emptyGit);
  const id = conversation?.id;
  const cwd = conversation?.cwd ?? "";
  const completedTurnId = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.endedAt !== undefined)?.id;
  const scope = `${id}:${cwd}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: relire Git à la fin d’un tour ou au changement de conversation.
  useEffect(() => {
    if (!id || !cwd) return;
    let cancelled = false;
    setState((previous) => (previous.scope === scope ? previous : { scope, ...loadingGit }));
    const target = { name: conversation?.title ?? "", path: cwd };
    invoke<GitSummary>("agentWorkspace.gitSummary", { path: cwd }).then(
      (summary) => !cancelled && setState({ scope, loading: false, groups: [{ ...target, summary }] }),
      () => !cancelled && setState({ scope, loading: false, groups: [{ ...target, error: true }] }),
    );
    return () => {
      cancelled = true;
    };
  }, [scope, completedTurnId]);
  if (!id || !cwd) return emptyGit;
  return state.scope === scope ? state : loadingGit;
}

/** Totaux de la pastille sous la saisie, sur l’ensemble des dépôts lus. */
export function gitTotals(git: GitChanges) {
  const changed = git.groups.filter((group) => group.summary?.files.length);
  const lineTotals =
    changed.length > 0 && changed.every((group) => group.summary?.additions != null && group.summary.deletions != null);
  return {
    count: git.groups.reduce((sum, group) => sum + (group.summary?.files.length ?? 0), 0),
    additions: lineTotals ? changed.reduce((sum, group) => sum + (group.summary?.additions ?? 0), 0) : undefined,
    deletions: lineTotals ? changed.reduce((sum, group) => sum + (group.summary?.deletions ?? 0), 0) : undefined,
    incomplete: git.groups.some((group) => group.error || group.summary?.truncated),
  };
}

/** Résumé compact des changements Git sous la saisie, repris de `AgentGitSummaryPill` de OneApp. */
export function GitSummaryPill({ git }: { git: GitChanges }) {
  const { count, additions, deletions, incomplete } = gitTotals(git);
  if (!count) return null;
  return (
    <div
      className="agents-page__git-summary"
      role="status"
      title={
        incomplete
          ? "Certains dépôts sont indisponibles ou la liste est limitée ; ces chiffres sont partiels."
          : undefined
      }
    >
      {count} fichier{count > 1 ? "s" : ""} modifié{count > 1 ? "s" : ""}
      {additions !== undefined && deletions !== undefined ? (
        <>
          <span className="agent-changes__added">+{additions.toLocaleString("fr-FR")}</span>
          <span className="agent-changes__removed">−{deletions.toLocaleString("fr-FR")}</span>
        </>
      ) : null}
    </div>
  );
}

/** Un groupe par dépôt modifié, puis les dépôts illisibles s’il n’y a rien d’autre à montrer. */
function GitChangesContent({ groups }: { groups: GitGroup[] }) {
  const unavailable = groups.filter((group) => group.error).length;
  return (
    <div className="agent-changes">
      {groups
        .filter((group) => group.summary?.files.length)
        .map((group) => (
          <div key={group.path} className="agent-changes__group">
            <div className="agent-changes__summary">
              <FileDiff size={14} aria-hidden="true" />
              <span className="agent-changes__name" title={group.path}>
                Modifications
              </span>
              <span className="agent-changes__totals">
                {group.summary?.additions != null && group.summary.deletions != null ? (
                  <>
                    <span className="agent-changes__added">+{group.summary.additions.toLocaleString("fr-FR")}</span>{" "}
                    <span className="agent-changes__removed">−{group.summary.deletions.toLocaleString("fr-FR")}</span>
                  </>
                ) : (
                  `${group.summary?.files.length} fichiers`
                )}
              </span>
            </div>
          </div>
        ))}
      {unavailable && !groups.some((group) => group.summary?.files.length) ? (
        <InfoPanelNote>
          {unavailable} dépôt{unavailable > 1 ? "s" : ""} indisponible{unavailable > 1 ? "s" : ""}.
        </InfoPanelNote>
      ) : null}
    </div>
  );
}

type TurnLines = Record<string, FileLines>;

/**
 * Lignes des tours terminés avant qu’Alfred ne les enregistre : relues dans l’historique de l’espace à partir du
 * commit de chaque tour.
 */
function useMissingLines(conversation?: Conversation) {
  const missing = (conversation?.turns ?? []).flatMap((turn) =>
    turn.commit && !turn.changedLines ? [turn.commit] : [],
  );
  const key = missing.join(",");
  const [found, setFound] = useState<Record<string, TurnLines>>({});
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    invoke<Commit[]>("space.commits", { ids: key.split(",") })
      .then((commits) => {
        if (cancelled) return;
        const entries = commits.map((commit): [string, TurnLines] => [
          commit.id,
          Object.fromEntries(
            commit.files.flatMap((file, index) => {
              const lines = commit.lines?.[index];
              return lines ? [[file, lines]] : [];
            }),
          ),
        ]);
        setFound((current) => ({ ...current, ...Object.fromEntries(entries) }));
      })
      .catch(() => {
        // Sans historique lisible, ces tours gardent le seul nombre de fichiers.
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return found;
}

/**
 * Fichiers de l’espace modifiés par la conversation ouverte, tour après tour : Alfred enregistre chaque tour dans un
 * commit de l’espace, que l’état Git du dossier de travail ne montre donc plus une fois le tour fini.
 */
function SpaceChanges({ conversation }: { conversation: Conversation }) {
  const recovered = useMissingLines(conversation);
  const files = [...new Set(conversation.turns.flatMap((turn) => turn.changedFiles ?? []))];
  if (!files.length) return null;
  // Lignes cumulées sur tous les tours ; sans aucun compte (binaires, historique illisible), le nombre de fichiers.
  const counted = conversation.turns.flatMap((turn) =>
    Object.values(turn.changedLines ?? (turn.commit ? recovered[turn.commit] : undefined) ?? {}),
  );
  const totals = counted.reduce(
    (sum, counts) => ({ added: sum.added + counts.added, removed: sum.removed + counts.removed }),
    { added: 0, removed: 0 },
  );
  return (
    <div className="agent-changes">
      <div className="agent-changes__summary">
        <FileDiff size={14} aria-hidden="true" />
        <span className="agent-changes__name">Enregistrées dans l’espace de travail</span>
        <span className="agent-changes__totals">
          {counted.length ? <LineCounts {...totals} /> : `${files.length} fichier${files.length > 1 ? "s" : ""}`}
        </span>
      </div>
    </div>
  );
}

/** Carte « Modifications » : l’état Git du dossier de travail, comme dans OneApp, puis les tours enregistrés. */
function ChangedFiles({ conversation, git }: { conversation?: Conversation; git: GitChanges }) {
  if (!conversation) return <InfoPanelNote>Ouvrez une conversation.</InfoPanelNote>;
  const space = <SpaceChanges conversation={conversation} />;
  if (git.loading)
    return (
      <>
        <InfoPanelNote>Lecture de l’état Git…</InfoPanelNote>
        {space}
      </>
    );
  if (git.groups.some((group) => group.error || group.summary?.files.length))
    return (
      <>
        <GitChangesContent groups={git.groups} />
        {space}
      </>
    );
  return (
    <>
      <InfoPanelNote>Aucune modification Git.</InfoPanelNote>
      {space}
    </>
  );
}

/** Lignes ajoutées en vert et retirées en rouge, comme un bilan de diff. */
function LineCounts({ added, removed }: FileLines) {
  return (
    <span
      className="agent-changes__lines"
      title={`${added} ligne${added > 1 ? "s" : ""} ajoutée${added > 1 ? "s" : ""}, ${removed} retirée${removed > 1 ? "s" : ""}`}
    >
      <span className="agent-changes__added">+{added}</span> <span className="agent-changes__removed">−{removed}</span>
    </span>
  );
}

/**
 * Suivi des conversations dans le panneau de droite, repris de `AgentList` de OneApp : toutes les conversations dans
 * une seule liste, la plus récemment créée d’abord, chacune avec sa pastille d’état, l’heure de sa dernière activité
 * et « Archiver » au survol ; puis l’état Git du dossier de travail de la conversation ouverte.
 */
export function ConversationList({
  conversations,
  activeId,
  active,
  panel,
  git = emptyGit,
  onArchive,
}: {
  conversations: readonly ConversationHeader[];
  activeId: string | null;
  active?: Conversation;
  panel: InfoPanelState;
  /** État Git du dossier de travail de la conversation ouverte, lu par la page (`useWorkspaceGit`). */
  git?: GitChanges;
  /** Chaque conversation s’archive depuis sa ligne, même au travail, comme les agents de OneApp. */
  onArchive?: (header: ConversationHeader) => void;
}) {
  const open = useAgents((state) => state.open);
  const runtime = useAgents((state) => state.runtime);
  const now = Date.now();
  const states = new Map(
    conversations.map((header) => [header.id, rowState(conversationState(header, runtime[header.id]))]),
  );
  const sorted = [...conversations].sort(compareConversations);
  const attention = sorted.filter(({ id }) => ["attention", "error"].includes(states.get(id) ?? ""));
  const working = sorted.filter(({ id }) => states.get(id) === "working");
  const rows = sorted.map((header) => {
    const state = states.get(header.id) ?? "idle";
    const provider = PROVIDER_LABEL[header.provider];
    // Le harnais en sous-ligne ; une conversation qui attend une réponse ou a échoué le dit à côté, comme dans OneApp.
    // Une coordinatrice et ses délégués se reconnaissent dans la sous-ligne.
    const parent = header.parent ? conversations.find(({ id }) => id === header.parent) : undefined;
    const role = header.coordinator
      ? " · coordinatrice"
      : header.parent
        ? ` · délégué${parent ? ` de ${parent.title}` : ""}`
        : "";
    const details =
      state === "attention" || state === "error"
        ? `${provider}${role} · ${CONVERSATION_STATE_LABEL[state].toLowerCase()}`
        : `${provider}${role}`;
    const status = CONVERSATION_STATE_LABEL[state];
    return {
      key: header.id,
      ...dotOf(state),
      text: header.title,
      description: details,
      announcement: status,
      meta: lastActivity(header.updatedAt, now),
      title: `${header.title}\n${provider} · ${status}`,
      selected: header.id === activeId,
      onSelect: () => void open(header.id),
      action: onArchive ? (
        <IconButton label={`Archiver ${header.title}`} tooltip="Archiver" onClick={() => onArchive(header)}>
          <Archive size={14} aria-hidden="true" />
        </IconButton>
      ) : undefined,
    };
  });
  const cards: InfoPanelCard[] = [
    {
      // Une seule liste : la pastille donne l’état, le résumé ce qui demande l’utilisateur, sinon ce qui travaille.
      id: "conversations",
      title: "Conversations",
      summary: attention.length
        ? `${attention.length} à traiter`
        : working.length
          ? `${working.length} au travail`
          : undefined,
      summaryTone: attention.length ? "warning" : "neutral",
      content: <InfoPanelRows variant="detailed" empty="Aucune conversation." rows={rows} />,
    },
    {
      id: "changes",
      title: "Modifications",
      content: <ChangedFiles conversation={active} git={git} />,
    },
  ];
  // Sans conversation, la liste n’afficherait qu’une phrase « Aucune… » : le suivi reste vide, comme dans OneApp.
  return <InfoPanel label="Suivi des conversations" cards={conversations.length ? cards : []} panel={panel} />;
}
