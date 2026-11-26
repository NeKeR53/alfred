/**
 * Délégation entre agents : une conversation coordinatrice confie des tâches à d’autres agents (outil `delegate`).
 * Rust valide le lot, garde les tâches et décide lesquelles sont prêtes (`src-tauri/src/agents/delegation.rs`) ; la
 * coquille lance la conversation de chaque tâche prête, lit son contrat de retour à la fin du tour, le rend à Rust
 * et relance la coordinatrice avec le rapport.
 *
 * Toute conversation ouverte par l’utilisateur peut déléguer : elle devient coordinatrice à son premier
 * `alfred delegate` (événement `agent:coordinator`). L’utilisateur peut aussi la marquer (« Répartir le travail »),
 * et une page la lance avec `coordinator: true`. Un délégué ne délègue jamais.
 */
import { extractJson } from "../../lib/jsonSchema";
import { invoke, onNativeEvent } from "../../lib/native";
import type { Autonomy, Provider } from "./harness";
import { lastAssistantText } from "./model";
import { useAgents, waitForTurn } from "./store";

interface ClaimedTask {
  id: string;
  coordinator: string;
  key: string;
  goal: string;
  cwd: string;
  autonomy: Autonomy;
  provider?: Provider | null;
  model?: string | null;
}

/** Consigne de fin d’un délégué : le contrat de retour que la coordinatrice reçoit. */
export const RETURN_CONTRACT = [
  "Tu es un agent délégué : une coordinatrice t’a confié cette tâche et attend ton rapport.",
  "Quand tu as terminé (ou si tu ne peux pas continuer), finis ta réponse par un bloc ```json qui suit ce contrat :",
  '{ "status": "success" | "partial" | "failed" | "needs_information" | "cancelled", "summary": "600 caractères au plus", "artifacts": ["chemins relatifs à ton dossier de travail"], "questions": ["ce qu’il te manque"] }',
].join("\n");

/** Contrat lu dans le dernier message ; sans bloc lisible, la tâche est en échec. */
export function readContract(message: string): Record<string, unknown> {
  try {
    const value = extractJson(message);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Pas de bloc JSON : la tâche est rendue en échec, avec le texte comme rapport.
  }
  return { status: "failed", summary: "Le délégué n’a pas rendu de contrat de retour lisible." };
}

const running = new Set<string>();

async function runTask(task: ClaimedTask) {
  if (running.has(task.id)) return;
  running.add(task.id);
  try {
    const store = useAgents.getState();
    const coordinator = store.loaded[task.coordinator];
    const conversation = store.create({
      title: `${task.key} · délégué`,
      cwd: task.cwd,
      autonomy: task.autonomy,
      ...(task.provider ? { provider: task.provider } : coordinator ? { provider: coordinator.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
    });
    store.update(conversation.id, { parent: task.coordinator, taskKey: task.key });
    if (coordinator && !coordinator.coordinator) store.update(task.coordinator, { coordinator: true });
    await invoke("agents.tasks.attach", { id: task.id, conversation: conversation.id });
    const done = waitForTurn(conversation.id);
    await store.send(conversation.id, { text: `${task.goal}\n\n${RETURN_CONTRACT}`, attachments: [], contexts: [] });
    const turn = await done;
    const message = lastAssistantText(turn);
    const contract =
      turn.status === "error" || turn.status === "cancelled"
        ? { status: turn.status === "cancelled" ? "cancelled" : "failed", summary: turn.error ?? "Tour interrompu." }
        : readContract(message);
    const reported = await invoke<{ coordinator: string; message: string }>("agents.tasks.report", {
      id: task.id,
      contract,
      text: message,
    });
    await useAgents.getState().ensureLoaded(reported.coordinator);
    if (useAgents.getState().loaded[reported.coordinator]?.archived === false)
      await useAgents
        .getState()
        .send(
          reported.coordinator,
          { text: reported.message, attachments: [], contexts: [] },
          { messageId: `task:${task.id}:${Date.now()}` },
        );
  } finally {
    running.delete(task.id);
  }
}

/** Lance les tâches prêtes. */
export async function runReadyTasks() {
  const ready = await invoke<ClaimedTask[] | null>("agents.tasks.claim");
  await Promise.all((ready ?? []).map((task) => runTask(task).catch(() => undefined)));
}

let bound = false;

export function bindDelegation() {
  if (bound) return;
  bound = true;
  // Une conversation ouverte par l’utilisateur devient coordinatrice à son premier `alfred delegate`.
  onNativeEvent("agent:coordinator", (payload) => {
    const conversation = (payload as { conversation?: string } | null)?.conversation;
    if (conversation && useAgents.getState().loaded[conversation])
      useAgents.getState().update(conversation, { coordinator: true });
  });
  onNativeEvent("agent:tasks", () => void runReadyTasks().catch(() => undefined));
  void runReadyTasks().catch(() => undefined);
}

/** Désigne (ou non) la conversation comme coordinatrice : elle reçoit les outils de délégation. */
export async function setCoordinator(
  conversationId: string,
  on: boolean,
  maxMode: "complet" | "espace-de-travail" = "complet",
) {
  const conversation = useAgents.getState().loaded[conversationId];
  if (!conversation) return;
  await invoke("agents.coordinator.set", { conversation: conversationId, on, cwd: conversation.cwd, maxMode });
  useAgents.getState().update(conversationId, { coordinator: on || undefined });
}

/** La coordinatrice est arrêtée ou archivée : ses tâches non finies sont annulées et ses délégués arrêtés. */
export async function stopDelegates(coordinatorId: string) {
  const running = await invoke<string[] | null>("agents.tasks.stop", { coordinator: coordinatorId }).catch(() => null);
  for (const conversation of running ?? [])
    await useAgents
      .getState()
      .cancel(conversation)
      .catch(() => undefined);
}
