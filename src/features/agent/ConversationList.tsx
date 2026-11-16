import { IconButton } from "@alfred/ui";
import { Archive, CircleAlert, CircleCheck, FileDiff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "../../lib/native";
import type { Commit, FileLines } from "../../lib/types";
import { PROVIDER_LABEL } from "./harness";
import type { Conversation, ConversationHeader, ConversationRuntime } from "./model";
import {
  InfoPanel,
  type InfoPanelCard,
  InfoPanelNote,
  InfoPanelRows,
  type InfoPanelState,
  useInfoPanelLayout,
} from "./panel/InfoPanel";
import { useAgents } from "./store";

const cardIds = ["attention", "working", "done", "changes"] as const;

/** Disposition du suivi des conversations, partagée entre le panneau et le bouton de la barre qui le masque. */
export function useConversationListPanel() {
  return useInfoPanelLayout("agent", cardIds);
}

type State = "attention" | "working" | "error" | "unread" | "idle";

// Rang de chaque état dans le suivi, repris de `agentMonitor` de OneApp.
const PRIORITY: Record<State, number> = { attention: 0, error: 1, working: 2, unread: 4, idle: 5 };

/**
 * Ordre du suivi, repris de `compareAgents` de OneApp : par état, puis le plus récent d’abord. Une conversation au
 * travail se met à jour à chaque fragment : elle est classée par sa création, pour que deux conversations en cours ne
 * permutent pas sans cesse dans la liste.
 */
export function compareConversations(
  left: ConversationHeader,
  leftState: State,
  right: ConversationHeader,
  rightState: State,
) {
  const byState = PRIORITY[leftState] - PRIORITY[rightState];
  if (byState) return byState;
  return leftState === "working" ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt;
}

export function stateOf(header: ConversationHeader, runtime: ConversationRuntime | undefined, failed: boolean): State {
  if (runtime && (runtime.approvals.length || runtime.questions.length)) return "attention";
  if (runtime && runtime.status !== "idle") return "working";
  if (failed) return "error";
  return header.unread ? "unread" : "idle";
}

const STATE_LABEL: Record<State, string> = {
  attention: "Attend votre réponse",
  working: "En cours",
  error: "En erreur",
  unread: "À consulter",
  idle: "",
};

function relativeTime(at: number, now: number) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return new Date(at).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
  });
}

/** Pictogramme et ton de l’état, posés dans la marge de la ligne comme dans le suivi des agents de OneApp. */
function glyphOf(state: State) {
  if (state === "working") return { glyph: <LoaderCircle size={13} className="is-spinning" /> };
  if (state === "attention")
    return {
      glyph: <span className="agent-list__question">?</span>,
      tone: "warning" as const,
    };
  if (state === "error") return { glyph: <CircleAlert size={13} />, tone: "danger" as const };
  if (state === "unread") return { glyph: <CircleCheck size={13} />, tone: "success" as const };
  return { glyph: <span className="agent-list__idle" /> };
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
        <span className="agent-changes__name">Enregistrées dans l’espace</span>
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
 * Suivi des conversations dans le panneau de droite, repris de `AgentList` de OneApp : regroupées par état dans des
 * cartes repliables et triées comme dans OneApp, puis l’état Git du dossier de travail de la conversation ouverte.
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
  /** Les conversations terminées s’archivent depuis leur ligne, comme les agents de OneApp. */
  onArchive?: (header: ConversationHeader) => void;
}) {
  const open = useAgents((state) => state.open);
  const runtime = useAgents((state) => state.runtime);
  const loaded = useAgents((state) => state.loaded);
  const now = Date.now();
  const states = new Map(
    conversations.map((header) => [
      header.id,
      stateOf(header, runtime[header.id], loaded[header.id]?.turns.at(-1)?.status === "error"),
    ]),
  );
  const sorted = [...conversations].sort((left, right) =>
    compareConversations(left, states.get(left.id) ?? "idle", right, states.get(right.id) ?? "idle"),
  );
  const attention = sorted.filter(({ id }) => ["attention", "error"].includes(states.get(id) ?? ""));
  const working = sorted.filter(({ id }) => states.get(id) === "working");
  const done = sorted.filter((header) => !attention.includes(header) && !working.includes(header));
  const rows = (list: readonly ConversationHeader[], empty: string, archivable = false) => (
    <InfoPanelRows
      empty={empty}
      rows={list.map((header) => {
        const state = states.get(header.id) ?? "idle";
        const details = [
          PROVIDER_LABEL[header.provider],
          header.origin ? `depuis ${header.origin.title}` : "",
          STATE_LABEL[state] || relativeTime(header.updatedAt, now),
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          key: header.id,
          ...glyphOf(state),
          text: header.title,
          description: details,
          title: `${header.title}\n${details}`,
          selected: header.id === activeId,
          onSelect: () => void open(header.id),
          action:
            archivable && onArchive ? (
              <IconButton
                size="small"
                label={`Archiver ${header.title}`}
                tooltip="Archiver"
                onClick={() => onArchive(header)}
              >
                <Archive size={14} aria-hidden="true" />
              </IconButton>
            ) : undefined,
        };
      })}
    />
  );
  const cards: InfoPanelCard[] = [
    {
      id: "attention",
      title: "À traiter",
      summary: attention.length ? String(attention.length) : undefined,
      summaryTone: attention.length ? "warning" : "neutral",
      content: rows(attention, "Aucune réponse attendue."),
    },
    {
      id: "working",
      title: "En cours",
      summary: working.length ? String(working.length) : undefined,
      content: rows(working, "Aucune conversation en cours."),
    },
    {
      id: "done",
      title: "Terminées",
      summary: done.length ? String(done.length) : undefined,
      content: rows(done, "Aucune conversation terminée.", true),
    },
    {
      id: "changes",
      title: "Modifications",
      content: <ChangedFiles conversation={active} git={git} />,
    },
  ];
  return <InfoPanel label="Suivi des conversations" cards={cards} panel={panel} />;
}
