/**
 * Passages agentiques des automatisations : Rust réserve la conversation (identifiant, périmètre limité aux
 * fonctions, dossier de travail) et la demande à la coquille (`automation:agent`). La coquille la crée — une
 * conversation neuve, jamais une conversation existante —, envoie la consigne et les données du déclencheur, attend
 * la fin du tour, la coupe à la durée maximale, et rend son dernier message.
 */
import { invoke, onNativeEvent } from "../../lib/native";
import { useShell } from "../../shell/store";
import { lastAssistantText } from "../agent/model";
import { useAgents, waitForTurn } from "../agent/store";

export interface AgentRunRequest {
  requestId: string;
  conversation: string;
  automation: string;
  name: string;
  cwd: string;
  text: string;
  context: unknown;
  maxMinutes: number;
}

export interface AgentRunAnswer {
  conversation: string;
  status: "done" | "error" | "cancelled" | "timeout";
  text: string;
  error?: string;
}

const handled = new Set<string>();

/** Lance la conversation demandée et rend son issue ; `wait` permet aux tests d’abréger la durée maximale. */
export async function runAgentRequest(
  request: AgentRunRequest,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<AgentRunAnswer> {
  const store = useAgents.getState();
  const conversation = store.create({
    id: request.conversation,
    title: `${request.name} · automatisation`,
    cwd: request.cwd,
    // Seulement dans son dossier : ailleurs, le harnais refuse sans demander (personne ne regarde).
    autonomy: "workspace",
    origin: { reference: `automation:${request.automation}`, title: `l’automatisation « ${request.name} »` },
  });
  const done = waitForTurn(conversation.id);
  const hasContext = request.context !== null && request.context !== undefined;
  await store.send(conversation.id, {
    text: request.text,
    attachments: [],
    contexts: hasContext
      ? [
          {
            id: crypto.randomUUID(),
            title: "Données du déclencheur",
            text: typeof request.context === "string" ? request.context : JSON.stringify(request.context, null, 2),
          },
        ]
      : [],
  });
  const limit = wait(request.maxMinutes * 60_000).then(() => "timeout" as const);
  const outcome = await Promise.race([done, limit]);
  if (outcome === "timeout") {
    await useAgents
      .getState()
      .cancel(conversation.id)
      .catch(() => undefined);
    return { conversation: conversation.id, status: "timeout", text: "" };
  }
  const status = outcome.status === "error" ? "error" : outcome.status === "cancelled" ? "cancelled" : "done";
  return {
    conversation: conversation.id,
    status,
    text: lastAssistantText(outcome),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

async function handle(request: AgentRunRequest) {
  if (handled.has(request.requestId)) return;
  handled.add(request.requestId);
  // Diffusée à toutes les interfaces ouvertes : seule celle qui la réserve lance la conversation.
  const claimed = await invoke<boolean>("ui.claim", { requestId: request.requestId }).catch(() => false);
  if (!claimed) return;
  try {
    const answer = await runAgentRequest(request);
    await invoke("ui.resolve", { requestId: request.requestId, result: answer });
  } catch (error) {
    await invoke("ui.resolve", {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

let bound = false;

/** À appeler une fois au démarrage de la coquille ; reprend aussi les demandes faites avant son ouverture. */
export function bindAutomationAgents() {
  if (bound) return;
  bound = true;
  onNativeEvent("automation:agent", (payload) => void handle(payload as AgentRunRequest));
  void invoke<AgentRunRequest[]>("ui.waiting", { name: "automation:agent" }).then(
    (waiting) => {
      for (const request of waiting ?? []) void handle(request);
    },
    () => undefined,
  );
}

/** Ouvre une conversation dans la page Agent (lien depuis une automatisation). */
export async function openConversation(id: string) {
  await useAgents.getState().ensureLoaded(id);
  await useAgents.getState().open(id);
  useShell.getState().setView({ kind: "agent" });
}
