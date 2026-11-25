import { invoke } from "../../lib/native";

/** Déclencheur d’une automatisation (voir docs/automatisations.md). */
export type AutomationTrigger =
  | { kind: "cron"; cron: string }
  | { kind: "webhook" }
  | { kind: "script" }
  /** Un état partagé change (`docs/lectures-partagees.md`) : « module/etat », ses paramètres, son compte. */
  | { kind: "state"; state: string; params?: Record<string, unknown>; instance?: string };

/** État déclaré par un module, qu’une automatisation peut suivre (`states.catalog`). */
export interface DeclaredState {
  name: string;
  module: string;
  description: string;
  params: string[];
}

export async function listDeclaredStates(): Promise<DeclaredState[]> {
  return (await invoke<{ states: DeclaredState[] }>("states.catalog")).states;
}

export type AutomationStatus = "active" | "paused" | "toValidate" | "invalid";

export interface AutomationStep {
  /** `module/fonction`. */
  function: string;
  input: Record<string, unknown>;
  instance?: string;
  /** L’étape ne part que si cette comparaison est vraie (« $prev.total > 0 »). */
  when?: string;
  /** Après l’étape, le passage s’arrête si cette comparaison est vraie. */
  stopIf?: string;
  onError?: "stop" | "continue";
}

export type AutomationAction =
  | { kind: "steps"; steps: AutomationStep[] }
  | { kind: "script"; function: string; input?: Record<string, unknown> }
  | {
      kind: "agent";
      instruction: string;
      maxMinutes: number;
      /** Conversation existante qui reçoit chaque passage ; absente : une conversation neuve à chaque passage. */
      conversation?: string;
    };

/** Conversation de l’espace qu’une automatisation peut viser. */
export interface ConversationChoice {
  id: string;
  title: string;
  archived?: boolean;
  autonomy?: string;
}

export const listConversations = () => invoke<ConversationChoice[]>("conversations.list");

export interface AutomationItem {
  id: string;
  name: string;
  action: AutomationAction;
  /** L’action en clair : la fonction, « 3 étapes : … », « script … », « agent ». */
  summary: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  status: AutomationStatus;
  problem: string | null;
  createdBy: "user" | "agent";
  running: boolean;
  lastRunAt: string | null;
  lastStatus: "running" | "ok" | "error" | null;
  lastError: string | null;
  lastTrigger: string | null;
  /** Conversation du dernier passage agentique. */
  lastConversation: string | null;
  nextRunAt: string | null;
  /** Conversation existante visée par un agent : son titre, et pourquoi un passage échouerait. */
  target?: { id: string; title: string; problem: string | null } | null;
  /** Fichier du script, pour l’ouvrir. */
  scriptFile: string | null;
  url: string | null;
}

export interface AutomationFunction {
  reference: string;
  module: string;
  moduleName: string;
  id: string;
  description: string;
  runtime?: string;
  instances: Array<{ client: string; id: string; label: string }>;
}

export interface AutomationsList {
  automations: AutomationItem[];
  functions: AutomationFunction[];
  baseUrl: string | null;
  maxAgentMinutes?: number;
}

export interface AutomationDraft {
  id?: string;
  name: string;
  action: AutomationAction;
  trigger: AutomationTrigger;
  enabled: boolean;
}

export type RunResult = { ok: true; output: unknown } | { ok: false; error: string };

export const listAutomations = () => invoke<AutomationsList>("automations.list");
export const saveAutomation = (draft: AutomationDraft) => invoke<{ id: string }>("automations.save", { ...draft });
export const validateAutomation = (id: string) => invoke<null>("automations.validate", { id });
export const setAutomationEnabled = (id: string, enabled: boolean) =>
  invoke<null>("automations.setEnabled", { id, enabled });
export const removeAutomation = (id: string) => invoke<null>("automations.remove", { id });
export const runAutomationNow = (id: string) => invoke<RunResult>("automations.runNow", { id });
export const automationSecret = (id: string) =>
  invoke<{ secret: string; url: string | null }>("automations.secret", { id });
export const newAutomationScript = (name: string, runtime: "python" | "ts") =>
  invoke<{ reference: string; file: string }>("automations.newScript", { name, runtime });
export const rotateAutomationSecret = (id: string) => invoke<{ secret: string }>("automations.rotate", { id });

/** Commande prête à copier pour qu’un autre processus lance l’automatisation. */
export function curlCommand(url: string, secret: string): string {
  return `curl -X POST '${url}' -H 'X-Alfred-Secret: ${secret}' -H 'Content-Type: application/json' -d '{}'`;
}

/** Le déclencheur, en clair. */
export function triggerLabel(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return `Planning ${trigger.cron}`;
    case "webhook":
      return "Appel HTTP local";
    case "script":
      return "Script";
    case "state": {
      const params = Object.entries(trigger.params ?? {})
        .map(([name, value]) => `${name} = ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(", ");
      return `Quand ${trigger.state} change${params ? ` (${params})` : ""}`;
    }
  }
}

/** L’action, en clair. */
export function actionLabel(action: AutomationAction): string {
  switch (action.kind) {
    case "steps":
      return action.steps.length === 1
        ? `fonction ${action.steps[0]?.function ?? ""}`
        : `${action.steps.length} étapes : ${action.steps.map((step) => step.function).join(" → ")}`;
    case "script":
      return `script ${action.function}`;
    case "agent":
      return `agent${action.conversation ? " dans une conversation existante" : ""}, ${action.maxMinutes} min au plus`;
  }
}
