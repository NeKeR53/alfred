import { CircleAlert, CircleCheck, FileDiff, LoaderCircle } from "lucide-react";
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

function stateOf(header: ConversationHeader, runtime: ConversationRuntime | undefined, failed: boolean): State {
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
  return new Date(at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Pictogramme et ton de l’état, posés dans la marge de la ligne comme dans le suivi des agents de OneApp. */
function glyphOf(state: State) {
  if (state === "working") return { glyph: <LoaderCircle size={13} className="is-spinning" /> };
  if (state === "attention")
    return { glyph: <span className="agent-list__question">?</span>, tone: "warning" as const };
  if (state === "error") return { glyph: <CircleAlert size={13} />, tone: "danger" as const };
  if (state === "unread") return { glyph: <CircleCheck size={13} />, tone: "success" as const };
  return { glyph: <span className="agent-list__idle" /> };
}

/** Fichiers de l’espace modifiés par la conversation ouverte, tour après tour. */
function ChangedFiles({ conversation }: { conversation?: Conversation }) {
  if (!conversation) return <InfoPanelNote>Ouvrez une conversation.</InfoPanelNote>;
  const files = [...new Set(conversation.turns.flatMap((turn) => turn.changedFiles ?? []))];
  if (!files.length) return <InfoPanelNote>Aucune modification de l’espace.</InfoPanelNote>;
  return (
    <div className="agent-changes">
      <div className="agent-changes__summary">
        <FileDiff size={14} aria-hidden="true" />
        <span className="agent-changes__name">Modifications</span>
        <span className="agent-changes__totals">
          {files.length} fichier{files.length > 1 ? "s" : ""}
        </span>
      </div>
      <ul className="agent-changes__files">
        {files.map((file) => (
          <li key={file} title={file}>
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Suivi des conversations dans le panneau de droite, repris de `AgentList` de OneApp : regroupées par état dans des
 * cartes repliables, puis les fichiers de l’espace modifiés par la conversation ouverte.
 */
export function ConversationList({
  conversations,
  activeId,
  active,
  panel,
}: {
  conversations: readonly ConversationHeader[];
  activeId: string | null;
  active?: Conversation;
  panel: InfoPanelState;
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
  const attention = conversations.filter(({ id }) => ["attention", "error"].includes(states.get(id) ?? ""));
  const working = conversations.filter(({ id }) => states.get(id) === "working");
  const done = conversations.filter((header) => !attention.includes(header) && !working.includes(header));
  const rows = (list: readonly ConversationHeader[], empty: string) => (
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
      content: rows(done, "Aucune conversation terminée."),
    },
    { id: "changes", title: "Modifications", content: <ChangedFiles conversation={active} /> },
  ];
  return <InfoPanel label="Suivi des conversations" cards={cards} panel={panel} />;
}
