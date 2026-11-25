import { invoke } from "../../lib/native";

/** Déclencheur d’une automatisation (voir docs/automatisations.md). */
export type AutomationTrigger = { kind: "cron"; cron: string } | { kind: "webhook" } | { kind: "script" };

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
  | { kind: "agent"; instruction: string; maxMinutes: number };

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
      return `agent, ${action.maxMinutes} min au plus`;
  }
}
