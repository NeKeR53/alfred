/**
 * Délégation entre agents : une conversation coordinatrice confie des tâches à d’autres agents (outil `delegate`).
 * Rust valide le lot, garde les tâches et décide lesquelles sont prêtes (`src-tauri/src/agents/delegation.rs`) ; la
 * coquille lance la conversation de chaque tâche prête, lit son contrat de retour à la fin du tour, le rend à Rust
 * et relance la coordinatrice avec le rapport.
 *
 * Toute conversation ouverte par l’utilisateur peut déléguer : elle devient coordinatrice à son premier
 * `alfred delegate` (événement `agent:coordinator`). L’utilisateur peut aussi la marquer (« Répartir le travail »),
 * et une page la lance avec `coordinator: true`. Un délégué ne délègue jamais.
 *
 * Un délégué reprend le harnais, le modèle et l’effort de la coordinatrice, sauf ce que sa tâche précise : Rust les
 * résout quand la tâche part (`claim`), la conversation du délégué les affiche et sa session les reçoit.
 *
 * Les tâches partent dans l’interface qui tient la coordinatrice : `claim` donne l’interface (`INTERFACE_ID`) et les
 * tâches qu’elle fait déjà avancer. Une tâche dont la session s’est fermée avant son rapport (rechargement, CLI
 * arrêté) revient « à reprendre » : son délégué reçoit un message de reprise dans sa conversation, qui garde sa
 * session de CLI ; s’il avait déjà fini, son contrat est lu sans le relancer.
 */
import { extractJson } from "../../lib/jsonSchema";
import { invoke, onNativeEvent } from "../../lib/native";
import type { Autonomy, Provider } from "./harness";
import { INTERFACE_ID, releaseOrphans } from "./harness/native";
import { lastAssistantText, type Turn } from "./model";
import { useAgents, waitForTurn } from "./store";

interface ClaimedTask {
  id: string;
  coordinator: string;
  /** `start` : nouvelle conversation ; `resume` : reprise dans `conversation` ; `report` : `message` à déposer. */
  launch?: "start" | "resume" | "report";
  conversation?: string | null;
  message?: string;
  key: string;
  goal: string;
  cwd: string;
  autonomy: Autonomy;
  /** Harnais, modèle et effort résolus par Rust : ceux de la tâche, sinon ceux de la coordinatrice. */
  provider?: Provider | null;
  model?: string | null;
  effort?: string | null;
  /** Modèle et effort repris de la coordinatrice : gardés tels quels, même absents (choix par défaut du CLI). */
  inherited?: boolean;
}

/** Consigne de fin d’un délégué : le contrat de retour que la coordinatrice reçoit. */
export const RETURN_CONTRACT = [
  "Tu es un agent délégué : une coordinatrice t’a confié cette tâche et attend ton rapport.",
  "Quand tu as terminé (ou si tu ne peux pas continuer), finis ta réponse par un bloc ```json qui suit ce contrat :",
  '{ "status": "success" | "partial" | "failed" | "needs_information" | "cancelled", "summary": "600 caractères au plus", "artifacts": ["chemins relatifs à ton dossier de travail"], "questions": ["ce qu’il te manque"] }',
].join("\n");

/** Message de reprise d’un délégué dont la session a été coupée avant son rapport. */
export const RESUME_MESSAGE = [
  "Ta session a été coupée avant ton rapport (Alfred a été rechargé ou ton CLI s’est arrêté).",
  "Reprends ta tâche là où tu t’es arrêté, sans refaire ce qui est déjà fait.",
].join(" ");

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

/** Contrat de retour d’un tour fini du délégué. */
function contractOf(turn: Turn) {
  const message = lastAssistantText(turn);
  const contract =
    turn.status === "error" || turn.status === "cancelled"
      ? { status: turn.status === "cancelled" ? "cancelled" : "failed", summary: turn.error ?? "Tour interrompu." }
      : readContract(message);
  return { contract, message };
}

/** Dépose le rapport dans la coordinatrice, si elle n’est pas archivée. */
async function notifyCoordinator(coordinator: string, message: string, taskId: string) {
  await useAgents.getState().ensureLoaded(coordinator);
  if (useAgents.getState().loaded[coordinator]?.archived === false)
    await useAgents
      .getState()
      .send(
        coordinator,
        { text: message, attachments: [], contexts: [] },
        { messageId: `task:${taskId}:${Date.now()}` },
      );
}

/** Rend le contrat à Rust et relance la coordinatrice avec le rapport. */
async function reportTask(task: ClaimedTask, contract: Record<string, unknown>, text: string) {
  const reported = await invoke<{ coordinator: string; message: string }>("agents.tasks.report", {
    id: task.id,
    contract,
    text,
  });
  await notifyCoordinator(reported.coordinator, reported.message, task.id);
}

/** Envoie `text` au délégué, attend la fin de son tour et rend son contrat. */
async function runTurn(task: ClaimedTask, conversation: string, text: string) {
  const done = waitForTurn(conversation);
  await useAgents.getState().send(conversation, { text, attachments: [], contexts: [] });
  const { contract, message } = contractOf(await done);
  await reportTask(task, contract, message);
}

async function startTask(task: ClaimedTask) {
  const store = useAgents.getState();
  const coordinator = store.loaded[task.coordinator];
  const conversation = store.create({
    title: `${task.key} · délégué`,
    cwd: task.cwd,
    autonomy: task.autonomy,
    ...(task.provider ? { provider: task.provider } : coordinator ? { provider: coordinator.provider } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
  });
  store.update(conversation.id, {
    parent: task.coordinator,
    taskKey: task.key,
    // Le modèle par défaut du CLI, repris de la coordinatrice, le reste : les choix des réglages ne le remplacent pas.
    ...(task.inherited ? { model: task.model ?? undefined, effort: task.effort ?? undefined } : {}),
  });
  if (coordinator && !coordinator.coordinator) store.update(task.coordinator, { coordinator: true });
  await invoke("agents.tasks.attach", { id: task.id, conversation: conversation.id });
  await runTurn(task, conversation.id, `${task.goal}\n\n${RETURN_CONTRACT}`);
}

/**
 * Reprend la tâche d’un délégué coupé : son tour arrêté avait-il fini (contrat lisible) ? Son contrat part tel quel.
 * Sinon il reçoit le message de reprise. Sa conversation absente ou archivée : la tâche est rendue en échec.
 */
async function resumeTask(task: ClaimedTask) {
  const id = task.conversation ?? "";
  await useAgents.getState().ensureLoaded(id);
  const conversation = useAgents.getState().loaded[id];
  if (!conversation || conversation.archived) {
    await reportTask(
      task,
      { status: "failed", summary: "La conversation du délégué a été archivée ou supprimée." },
      "",
    );
    return;
  }
  const last = conversation.turns.at(-1);
  const finished = last && last.status === "done" ? lastAssistantText(last) : "";
  const contract = finished ? readContract(finished) : undefined;
  if (contract && contract.status !== "failed") {
    await reportTask(task, contract, finished);
    return;
  }
  await runTurn(task, id, `${RESUME_MESSAGE}\n\n${RETURN_CONTRACT}`);
}

async function runTask(task: ClaimedTask) {
  if (running.has(task.id)) return;
  running.add(task.id);
  try {
    if (task.launch === "report") await notifyCoordinator(task.coordinator, task.message ?? "", task.id);
    else if (task.launch === "resume") await resumeTask(task);
    else await startTask(task);
  } finally {
    running.delete(task.id);
  }
}

/**
 * Lance les tâches prêtes et reprend les tâches interrompues de cette interface. Les sessions du chargement précédent
 * sont fermées d’abord : leurs tâches passent « interrompues » et repartent ici.
 */
export async function runReadyTasks() {
  await releaseOrphans();
  const ready = await invoke<ClaimedTask[] | null>("agents.tasks.claim", { owner: INTERFACE_ID, busy: [...running] });
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
