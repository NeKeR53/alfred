/**
 * Zone de la page Agent dans le menu de gauche, sur le modèle de la section Agents de OneApp : les conversations
 * non archivées, réponse attendue et échec en tête, puis la plus récemment créée d’abord. Chacune porte son état en
 * pastille et trois actions au survol : Renommer (dans la ligne), Ouvrir dans une fenêtre, Archiver.
 */
import { useMemo } from "react";
import { PROVIDER_LABEL } from "../features/agent/harness/types";
import type { ConversationHeader } from "../features/agent/model";
import { useAgents } from "../features/agent/store";
import { CONVERSATION_STATE_LABEL, type ConversationState, conversationState } from "../features/agent/summary";
import type { ZoneRow } from "./MenuZone";
import type { MenuEntryStatus } from "./menuZones";
import { notify } from "./notifications";
import { useShell } from "./store";
import type { AgentZone } from "./types";

/** État d’une conversation rendu par la pastille d’une entrée du menu ; une conversation en veille n’en a pas. */
const STATUS: Record<ConversationState, MenuEntryStatus | undefined> = {
  attention: "waiting",
  error: "error",
  working: "running",
  waiting: "running",
  done: "ok",
  idle: undefined,
};

/** Rang dans la zone : réponse attendue, puis échec, puis le reste. */
const RANK: Record<ConversationState, number> = { attention: 0, error: 1, working: 2, waiting: 2, done: 2, idle: 2 };

export function agentZoneRows(
  headers: readonly ConversationHeader[],
  stateOf: (header: ConversationHeader) => ConversationState,
  windowAction = true,
): ZoneRow[] {
  return headers
    .filter((header) => !header.archived && header.started)
    .map((header) => ({ header, state: stateOf(header) }))
    .sort((left, right) => RANK[left.state] - RANK[right.state] || right.header.createdAt - left.header.createdAt)
    .map(({ header, state }) => ({
      id: header.id,
      label: header.title || "Nouvelle conversation",
      status: STATUS[state],
      details: `${PROVIDER_LABEL[header.provider] ?? header.provider} · ${CONVERSATION_STATE_LABEL[state]}`,
      actions: [
        { id: "rename", label: "Renommer", icon: "pencil" },
        ...(windowAction ? [{ id: "window", label: "Ouvrir dans une fenêtre", icon: "app-window" }] : []),
        { id: "archive", label: "Archiver", icon: "archive" },
      ],
    }));
}

const failed = (title: string) => (error: unknown) =>
  notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });

/** Zone de l’entrée Agent ; `openWindow` ouvre une conversation seule dans sa fenêtre (absent : pas d’action). */
export function useAgentZone(openWindow?: (conversation: string) => void): AgentZone {
  const headers = useAgents((state) => state.headers);
  const runtime = useAgents((state) => state.runtime);
  const activeId = useAgents((state) => state.activeId);
  return useMemo(
    () => ({
      rows: agentZoneRows(headers, (header) => conversationState(header, runtime[header.id]), Boolean(openWindow)),
      activeId: activeId ?? undefined,
      visible: 8,
      onOpen: (id) => void useAgents.getState().open(id).catch(failed("La conversation n’a pas pu s’ouvrir")),
      onAction: (id, action, value) => {
        const agents = useAgents.getState();
        if (action === "rename" && value)
          void agents.rename(id, value).catch(failed("La conversation n’a pas pu être renommée"));
        else if (action === "archive")
          void agents.archive(id).catch(failed("La conversation n’a pas pu être archivée"));
        else if (action === "window") openWindow?.(id);
      },
      onNew: () => {
        const agents = useAgents.getState();
        const open = agents.activeId ? agents.loaded[agents.activeId] : undefined;
        const id = open && !open.started ? open.id : agents.create().id;
        void agents.open(id).catch(failed("La conversation n’a pas pu s’ouvrir"));
        useShell.getState().setView({ kind: "agent" });
      },
    }),
    [headers, runtime, activeId, openWindow],
  );
}
