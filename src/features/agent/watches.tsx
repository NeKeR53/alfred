/**
 * Suivis : une conversation qui attend un événement de module (fin d’une CI, d’une automatisation) est relancée
 * quand il arrive, ou à l’échéance. Rust garde les suivis dans la base de l’espace et les déclenche
 * (`src-tauri/src/agents/watches.rs`) ; la coquille dépose le message dans la conversation, une seule fois, puis le
 * marque livré. Une ligne au-dessus de la saisie montre ce que la conversation attend, avec sa croix.
 */
import { BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { useAgents } from "./store";
import "./agent-composer.css";

export interface AgentWatch {
  id: string;
  conversation: string;
  event: string;
  label: string;
  deadline: number;
  status: "waiting" | "fired";
  reason?: "event" | "timeout" | null;
  message?: string;
}

let bound = false;
let delivering: Promise<void> | undefined;

/** Relance les conversations dont un suivi s’est déclenché, chacune une fois (`watch:<id>`). */
export function deliverWatches(): Promise<void> {
  delivering ??= (async () => {
    try {
      const pending = await invoke<AgentWatch[] | null>("agents.watches.pending");
      for (const watch of pending ?? []) {
        await useAgents.getState().ensureLoaded(watch.conversation);
        const conversation = useAgents.getState().loaded[watch.conversation];
        if (!conversation || conversation.archived) {
          await invoke("agents.watches.cancelConversation", { conversation: watch.conversation });
          continue;
        }
        await useAgents
          .getState()
          .send(
            watch.conversation,
            { text: watch.message ?? "", attachments: [], contexts: [] },
            { messageId: `watch:${watch.id}` },
          );
        await invoke("agents.watches.delivered", { id: watch.id });
      }
    } finally {
      delivering = undefined;
    }
  })();
  return delivering;
}

/** À appeler une fois, quand les conversations sont chargées : relance ce qui s’est déclenché, puis écoute. */
export function bindAgentWatches() {
  if (bound) return;
  bound = true;
  onNativeEvent("agent:watches", (payload) => {
    if ((payload as { fired?: boolean } | null)?.fired) void deliverWatches().catch(() => undefined);
  });
  void deliverWatches().catch(() => undefined);
}

function useWatches(conversationId: string): AgentWatch[] {
  const [watches, setWatches] = useState<AgentWatch[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void invoke<AgentWatch[] | null>("agents.watches.list", { conversation: conversationId })
        .then((list) => alive && setWatches((list ?? []).filter((watch) => watch.status === "waiting")))
        .catch(() => undefined);
    load();
    const stop = onNativeEvent("agent:watches", load);
    return () => {
      alive = false;
      stop();
    };
  }, [conversationId]);
  return watches;
}

const time = (ms: number) =>
  new Date(ms).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** « Relance à la fin de … · au plus tard … », au-dessus de la saisie. */
export function WatchLines({ conversationId }: { conversationId: string }) {
  const watches = useWatches(conversationId);
  if (!watches.length) return null;
  return (
    <ul className="agent-watches" aria-label="Relances prévues">
      {watches.map((watch) => (
        <li key={watch.id} className="agent-watches__item">
          <BellRing size={13} aria-hidden="true" />
          <span>
            Relance à la fin de {watch.label} · au plus tard {time(watch.deadline)}
          </span>
          <IconButton
            icon={<X size={13} />}
            label="Annuler la relance"
            onPress={() => void invoke("agents.watches.cancel", { id: watch.id }).catch(() => undefined)}
          />
        </li>
      ))}
    </ul>
  );
}
