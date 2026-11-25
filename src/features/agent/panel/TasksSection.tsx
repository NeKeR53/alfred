import { useEffect, useState } from "react";
import { type BackgroundTask, BackgroundTasks, type DetailSection } from "socle-ui";
import { notify } from "../../../shell/notifications";
import type { AgentTask } from "../harness";

/** Une commande qui bloque la réponse ne compte comme tâche qu’au-delà de cette durée : un `ls` n’est pas une tâche. */
export const LONG_COMMAND_MS = 5000;

/**
 * Tâches montrées : les commandes lancées en arrière-plan et les sous-agents, toujours ; une commande qui bloque la
 * réponse, seulement si elle dure (en cours depuis `LONG_COMMAND_MS`, ou finie après au moins autant).
 */
export function shownTasks(tasks: readonly AgentTask[], now: number) {
  const long = (task: AgentTask) => (task.endedAt ?? now) - task.startedAt >= LONG_COMMAND_MS;
  const shown = tasks.filter((task) => task.background || task.kind === "agent" || long(task));
  const running = shown.filter((task) => task.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  const finished = shown.filter((task) => task.status !== "running");
  return { running, finished: finished.length, failed: finished.filter((task) => task.status === "failed").length };
}

/**
 * Heure du panneau des tâches : elle avance chaque seconde tant qu’une commande en cours n’a pas encore atteint
 * `LONG_COMMAND_MS`, pour qu’elle apparaisse dès qu’elle dure. Les durées affichées avancent seules (`BackgroundTasks`).
 */
export function useTaskClock(tasks: readonly AgentTask[]) {
  const [, tick] = useState(0);
  const waiting = tasks.some(
    (task) =>
      task.status === "running" &&
      !task.background &&
      task.kind !== "agent" &&
      Date.now() - task.startedAt < LONG_COMMAND_MS,
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  return Date.now();
}

/**
 * Section « Tâches en arrière-plan » du panneau de la conversation : commandes de fond, sous-agents et commandes
 * longues, chacune avec sa durée et son bouton d’arrêt quand l’agent sait l’arrêter seule (Claude Code) ; puis le
 * compte des tâches finies et des échecs. Rien tant qu’aucune tâche n’a été vue.
 */
export function tasksSection(
  tasks: readonly AgentTask[],
  now: number,
  onStop: (taskId: string) => Promise<void>,
): DetailSection | undefined {
  const { running, finished, failed } = shownTasks(tasks, now);
  if (!running.length && !finished) return undefined;
  const stop = (task: AgentTask) => () =>
    onStop(task.taskId).catch((error: unknown) => {
      notify({
        title: "Tâche non arrêtée",
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    });
  const items: BackgroundTask[] = running.map((task) => ({
    id: task.taskId,
    title: task.title,
    kind: task.kind,
    startedAt: task.startedAt,
    ...(task.stoppable ? { onStop: stop(task) } : {}),
  }));
  return {
    id: "conversation-tasks",
    title: "Tâches en arrière-plan",
    summary: running.length ? { label: `${running.length} en cours`, tone: "info" } : undefined,
    content: <BackgroundTasks tasks={items} finished={finished} failed={failed} />,
  };
}
