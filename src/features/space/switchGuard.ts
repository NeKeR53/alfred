import type { ConfirmOptions } from "@alfred/ui";
import { invoke } from "../../lib/native";
import { useAgents } from "../agent/store";
import { conversationState } from "../agent/summary";

/** Travail en cours que le passage à un autre espace interromprait. */
export interface BusyWork {
  /** Conversations d’agent au travail ou qui attendent une réponse : leur tour serait arrêté. */
  conversations: string[];
  /** Tâches de fond (imports, relevés) en cours ou en attente : elles s’arrêtent et reprennent au retour. */
  jobs: number;
}

/** Conversations au travail et tâches de fond de l’espace ouvert. */
export async function busyWork(): Promise<BusyWork> {
  const { headers, runtime } = useAgents.getState();
  const conversations = headers
    .filter((header) => !header.archived)
    .filter((header) => {
      const state = conversationState(header, runtime[header.id]);
      return state === "working" || state === "attention";
    })
    .map((header) => header.id);
  const count = (status: string) =>
    invoke<unknown[]>("jobs.list", { status, limit: 100 }).then(
      (jobs) => (Array.isArray(jobs) ? jobs.length : 0),
      () => 0,
    );
  const [running, queued] = await Promise.all([count("running"), count("queued")]);
  return { conversations, jobs: running + queued };
}

const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);

/** Confirmation à demander avant de quitter l’espace, ou `null` quand rien n’est en cours. */
export function switchConfirmation(busy: BusyWork, target: string): ConfirmOptions | null {
  const { conversations, jobs } = busy;
  if (!conversations.length && !jobs) return null;
  const parts: string[] = [];
  if (conversations.length) {
    parts.push(
      conversations.length > 1
        ? `${conversations.length} conversations de l’agent sont en cours : elles seront arrêtées.`
        : "Une conversation de l’agent est en cours : elle sera arrêtée.",
    );
  }
  if (jobs) {
    parts.push(
      `${jobs > 1 ? `${jobs} tâches de fond sont` : "Une tâche de fond est"} en route (un import, par exemple) : ${plural(jobs, "elle s’interrompt et reprendra", "elles s’interrompent et reprendront")} quand vous reviendrez dans cet espace de travail.`,
    );
  }
  return {
    title: `Passer à « ${target} » ?`,
    message: parts.join(" "),
    confirmLabel: "Changer d’espace de travail",
  };
}

/**
 * Vérifie qu’on peut quitter l’espace ouvert : rien en cours, ou l’utilisateur l’accepte. Les conversations au travail
 * sont alors arrêtées et toutes sont enregistrées, pour que rien ne s’enregistre dans l’espace suivant.
 */
export async function confirmLeaving(
  target: string,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  const busy = await busyWork();
  const options = switchConfirmation(busy, target);
  if (options && !(await confirm(options))) return false;
  const agents = useAgents.getState();
  await Promise.all(busy.conversations.map((id) => agents.cancel(id).catch(() => undefined)));
  // Les conversations s’enregistrent dans l’espace quitté avant que le suivant ne s’ouvre.
  await agents.flush().catch(() => undefined);
  return true;
}
