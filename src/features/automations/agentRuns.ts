/**
 * Passages agentiques des automatisations. Rust prépare le passage et le demande à la coquille
 * (`automation:agent`) ; la coquille envoie la consigne et les données du déclencheur, attend la fin du tour, le
 * coupe à la durée maximale, et rend le dernier message de l’agent.
 *
 * - Conversation neuve (par défaut) : Rust a réservé son identifiant, son périmètre et son dossier ; la coquille la
 *   crée.
 * - Conversation existante, choisie par l’utilisateur (`existing`) : le message s’y ajoute, marqué « Depuis
 *   l’automatisation … ». Si l’agent y travaille, il attend son tour dans la file, sans couper le travail en cours.
 *   Le périmètre A-15 n’est posé que pendant le tour de l’automatisation (`automations.agentScope`).
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
  /** Conversation neuve : son dossier de travail. */
  cwd?: string;
  /** Conversation existante choisie par l’utilisateur, et son titre. */
  existing?: boolean;
  title?: string;
  text: string;
  context: unknown;
  maxMinutes: number;
}

export interface AgentRunAnswer {
  conversation: string;
  /** `gone` : la conversation existante a été supprimée ou archivée. */
  status: "done" | "error" | "cancelled" | "timeout" | "gone";
  text: string;
  error?: string;
}

const handled = new Set<string>();

type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function triggerContext(context: unknown) {
  if (context === null || context === undefined) return [];
  return [
    {
      id: crypto.randomUUID(),
      title: "Données du déclencheur",
      text: typeof context === "string" ? context : JSON.stringify(context, null, 2),
    },
  ];
}

/** Marque du message posté dans une conversation existante. */
export const automationMarker = (name: string) => `Depuis l’automatisation « ${name} »`;

/** Passage dans une conversation existante : le message attend son tour, puis le tour est suivi jusqu’à sa fin. */
async function runInExisting(request: AgentRunRequest, wait: Wait): Promise<AgentRunAnswer> {
  const id = request.conversation;
  const title = request.title ?? id;
  const gone = (why: string): AgentRunAnswer => ({
    conversation: id,
    status: "gone",
    text: "",
    error: `Passage impossible : la conversation « ${title} » ${why}.`,
  });
  await useAgents
    .getState()
    .ensureLoaded(id)
    .catch(() => undefined);
  const conversation = useAgents.getState().loaded[id];
  if (!conversation) return gone("a été supprimée");
  if (conversation.archived) return gone("est archivée");
  const messageId = `automation-${request.requestId}`;
  // Le périmètre A-15 est posé quand le tour de l’automatisation commence, et rendu à sa fin.
  let scoped = false;
  const scope = (on: boolean) =>
    invoke("automations.agentScope", { conversation: id, automation: request.automation, on }).catch(() => undefined);
  const stop = useAgents.subscribe((state) => {
    if (!scoped && state.loaded[id]?.turns.at(-1)?.id === messageId) {
      scoped = true;
      void scope(true);
    }
  });
  // Le tour attendu est le sien : un tour de l’utilisateur peut finir avant.
  const ours = (async () => {
    for (;;) {
      const turn = await waitForTurn(id);
      if (turn.id === messageId) return turn;
    }
  })();
  try {
    await useAgents.getState().send(
      id,
      {
        text: `${automationMarker(request.name)} :\n\n${request.text}`,
        attachments: [],
        contexts: triggerContext(request.context),
      },
      { messageId },
    );
    const outcome = await Promise.race([ours, wait(request.maxMinutes * 60_000).then(() => "timeout" as const)]);
    if (outcome === "timeout") {
      // Encore dans la file : il en sort ; en cours : le tour de l’automatisation est arrêté.
      const store = useAgents.getState();
      if (!store.unqueue(id, messageId) && store.loaded[id]?.turns.at(-1)?.id === messageId)
        await store.cancel(id).catch(() => undefined);
      return { conversation: id, status: "timeout", text: "" };
    }
    const status = outcome.status === "error" ? "error" : outcome.status === "cancelled" ? "cancelled" : "done";
    return {
      conversation: id,
      status,
      text: lastAssistantText(outcome),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  } finally {
    stop();
    if (scoped) await scope(false);
  }
}

/** Lance la conversation demandée et rend son issue ; `wait` permet aux tests d’abréger la durée maximale. */
export async function runAgentRequest(request: AgentRunRequest, wait: Wait = sleep): Promise<AgentRunAnswer> {
  if (request.existing) return runInExisting(request, wait);
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
  await store.send(conversation.id, { text: request.text, attachments: [], contexts: triggerContext(request.context) });
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

/**
 * La conversation tourne-t-elle dans cette interface : un tour suivi ici, ou une file ici ? Seul l’état vivant de la
 * fenêtre compte : le dernier tour enregistré est « en cours » pour toutes les fenêtres, quelle que soit celle qui
 * le fait tourner.
 */
export function runsHere(id: string): boolean {
  const runtime = useAgents.getState().runtime[id];
  return runtime !== undefined && (runtime.status !== "idle" || runtime.queued.length > 0);
}

/** Délai laissé à l’interface qui fait tourner une conversation existante pour réserver la demande la première. */
export const OWNER_FIRST_MS = 1500;

async function handle(request: AgentRunRequest) {
  if (handled.has(request.requestId)) return;
  handled.add(request.requestId);
  // Une conversation existante ne se suit que là où elle tourne : la fenêtre principale et celle des agents ont
  // chacune leur copie de la conversation. Celle qui y fait tourner un tour réserve tout de suite ; les autres
  // attendent, pour ne pas lancer un tour à côté de celui de l’utilisateur.
  if (request.existing && !runsHere(request.conversation)) await sleep(OWNER_FIRST_MS);
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
