import { Archive } from "lucide-react";
import { useEffect, useState } from "react";
import { type DetailSection, DiffStat, Drawer, PropertyRow, type StatusTone } from "socle-ui";
import { invoke } from "../../lib/native";
import type { Commit, FileLines } from "../../lib/types";
import { PROVIDER_LABEL } from "./harness";
import type { Conversation, ConversationHeader } from "./model";
import { InfoPanelRows } from "./panel/InfoPanel";
import { planSection } from "./panel/PlanSteps";
import { useAgents } from "./store";
import { CONVERSATION_STATE_LABEL, type ConversationState, conversationState } from "./summary";

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

/** Ton du badge d’état de la ligne : au travail, réponse attendue, échec, à consulter ; en veille, neutre. */
export const STATE_TONE: Record<ConversationState, StatusTone> = {
  working: "info",
  waiting: "info",
  attention: "warning",
  error: "danger",
  done: "success",
  idle: "neutral",
};

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
    <span
      role="status"
      title={
        incomplete
          ? "Certains dépôts sont indisponibles ou la liste est limitée ; ces chiffres sont partiels."
          : undefined
      }
    >
      {count} fichier{count > 1 ? "s" : ""} modifié{count > 1 ? "s" : ""}{" "}
      {additions !== undefined && deletions !== undefined ? <DiffStat added={additions} removed={deletions} /> : null}
    </span>
  );
}

/** Valeur d’une ligne de modifications : lignes ajoutées et retirées, sinon le nombre de fichiers. */
function changesValue(files: number, lines?: { added: number; removed: number }) {
  return lines ? <DiffStat {...lines} /> : `${files} fichier${files > 1 ? "s" : ""}`;
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
    <PropertyRow
      label="Enregistrées dans l’espace"
      value={changesValue(files.length, counted.length ? totals : undefined)}
    />
  );
}

/**
 * Carte « Modifications » : l’état Git du dossier de travail (ce qui n’est pas encore enregistré), comme dans OneApp,
 * puis les tours enregistrés dans l’espace.
 */
function ChangedFiles({ conversation, git }: { conversation: Conversation; git: GitChanges }) {
  const changed = git.groups.filter((group) => group.summary?.files.length);
  const unavailable = git.groups.filter((group) => group.error).length;
  const pending = git.loading
    ? "Lecture de l’état Git…"
    : changed.length
      ? undefined
      : unavailable
        ? `${unavailable} dépôt${unavailable > 1 ? "s" : ""} indisponible${unavailable > 1 ? "s" : ""}.`
        : "Aucune";
  return (
    <>
      <PropertyRow label="Dossier de travail" value={conversation.cwd} />
      {pending !== undefined ? <PropertyRow label="Non enregistrées" value={pending} /> : null}
      {changed.map(({ path, summary }) => (
        <PropertyRow
          key={path}
          label="Non enregistrées"
          value={changesValue(
            summary?.files.length ?? 0,
            summary?.additions != null && summary.deletions != null
              ? { added: summary.additions, removed: summary.deletions }
              : undefined,
          )}
        />
      ))}
      <SpaceChanges conversation={conversation} />
    </>
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
  git = emptyGit,
  onArchive,
  withList = true,
}: {
  conversations: readonly ConversationHeader[];
  activeId: string | null;
  active?: Conversation;
  /** État Git du dossier de travail de la conversation ouverte, lu par la page (`useWorkspaceGit`). */
  git?: GitChanges;
  /** Chaque conversation s’archive depuis sa ligne, même au travail, comme les agents de OneApp. */
  onArchive?: (header: ConversationHeader) => void;
  /**
   * Faux dans la fenêtre principale : la sidebar montre déjà les conversations, le panneau ne garde que les détails
   * de la conversation ouverte. Vrai dans la fenêtre Agent détachée, qui n'a pas de sidebar.
   */
  withList?: boolean;
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
    return {
      key: header.id,
      text: header.title,
      description: `${provider}${role}`,
      announcement: CONVERSATION_STATE_LABEL[state],
      tone: STATE_TONE[state],
      meta: lastActivity(header.updatedAt, now),
      selected: header.id === activeId,
      onSelect: () => void open(header.id),
      action: onArchive
        ? { icon: <Archive size={14} />, label: `Archiver ${header.title}`, onPress: () => onArchive(header) }
        : undefined,
    };
  });
  const listSection: DetailSection[] = [
    {
      // Une seule liste : la pastille donne l’état, le résumé ce qui demande l’utilisateur, sinon ce qui travaille.
      id: "agent-conversations",
      title: "Conversations",
      summary: attention.length
        ? { label: `${attention.length} à traiter`, tone: "warning" }
        : working.length
          ? `${working.length} au travail`
          : undefined,
      content: <InfoPanelRows rows={rows} />,
    },
  ];
  const plan = planSection(active?.plan);
  const detailSections: DetailSection[] = active
    ? [
        ...(plan ? [plan] : []),
        {
          id: "conversation-changes",
          title: "Modifications",
          content: <ChangedFiles conversation={active} git={git} />,
        },
      ]
    : [];
  if (!withList) {
    // Fenêtre principale : seulement les détails de la conversation ouverte.
    return (
      <Drawer
        header={{ title: "Détails de la conversation" }}
        sections={detailSections}
        emptyMessage="Aucune conversation ouverte."
      />
    );
  }
  // Sans conversation, la liste n’afficherait qu’une phrase « Aucune… » : le suivi n’a pas de section.
  return (
    <Drawer
      header={{ title: "Suivi des conversations" }}
      sections={conversations.length ? [...listSection, ...detailSections] : []}
      emptyMessage="Aucune conversation."
    />
  );
}
