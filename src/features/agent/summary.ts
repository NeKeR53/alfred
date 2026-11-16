import { useMemo } from "react";
import type { AgentSummary } from "../../shell/AppShell";
import type { ConversationHeader, ConversationRuntime } from "./model";
import { useAgents } from "./store";

/**
 * État visible d’une conversation, repris de OneApp : réponse attendue, en échec, au travail, en attente (messages en
 * file), à consulter. Un tour arrêté resté non lu compte comme un échec ; une conversation lue est en veille.
 */
export type ConversationState = "attention" | "error" | "working" | "waiting" | "done" | "idle";

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  attention: "Réponse attendue",
  error: "En échec",
  working: "Au travail",
  waiting: "En attente",
  done: "À consulter",
  idle: "En veille",
};

/** État d’une conversation d’après son en-tête (statut du dernier tour compris) et sa session vivante. */
export function conversationState(
  header: Pick<ConversationHeader, "unread" | "lastStatus">,
  runtime: ConversationRuntime | undefined,
): ConversationState {
  const lastTurn = header.lastStatus;
  if (runtime && (runtime.approvals.length || runtime.questions.length)) return "attention";
  if (runtime && runtime.status !== "idle") return "working";
  if (lastTurn === "running") return "working";
  if (runtime?.queued.length) return "waiting";
  if (!header.unread) return "idle";
  if (lastTurn === "error" || lastTurn === "cancelled") return "error";
  return "done";
}

/**
 * Résumé des conversations pour la pastille du menu, comme l’entrée Agents de OneApp : d’abord celles qui attendent
 * une réponse, sinon celles qui travaillent ou attendent leur tour, sinon celles à consulter (terminées ou en échec).
 */
export function useAgentSummary(): AgentSummary | undefined {
  const headers = useAgents((state) => state.headers);
  const runtime = useAgents((state) => state.runtime);
  return useMemo(() => {
    const visible = headers.filter((header) => !header.archived && header.started);
    const states = visible.map((header) => conversationState(header, runtime[header.id]));
    const count = (...wanted: ConversationState[]) => states.filter((state) => wanted.includes(state)).length;
    const attention = count("attention");
    if (attention) return { state: "attention", count: attention };
    const working = count("working", "waiting");
    if (working) return { state: "working", count: working };
    const unread = count("done", "error");
    return unread ? { state: "done", count: unread } : undefined;
  }, [headers, runtime]);
}
