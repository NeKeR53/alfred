import { useMemo } from "react";
import type { AgentSummary } from "../../shell/AppShell";
import { useAgents } from "./store";

/**
 * Résumé des conversations pour la pastille du menu, comme l’entrée Agents de OneApp : d’abord celles qui attendent
 * une réponse, sinon celles qui travaillent, sinon celles qui ont une réponse non lue.
 */
export function useAgentSummary(): AgentSummary | undefined {
  const headers = useAgents((state) => state.headers);
  const runtime = useAgents((state) => state.runtime);
  return useMemo(() => {
    const visible = headers.filter((header) => !header.archived && header.started);
    const attention = visible.filter(({ id }) => {
      const live = runtime[id];
      return Boolean(live && (live.approvals.length || live.questions.length));
    }).length;
    if (attention) return { state: "attention", count: attention };
    const working = visible.filter(({ id }) => runtime[id] && runtime[id].status !== "idle").length;
    if (working) return { state: "working", count: working };
    const unread = visible.filter((header) => header.unread).length;
    return unread ? { state: "done", count: unread } : undefined;
  }, [headers, runtime]);
}
