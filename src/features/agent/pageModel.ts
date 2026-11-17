/**
 * Modèle des pages et des fonctions de l’espace (`ai.oneShot`, `ai.startAgent`) : celui réglé dans Réglages → Agent,
 * section « Dans les pages » (préférence `agents.pageModel`), sinon celui de l’agent. Un harnais réglé pour les pages
 * qui n’est plus installé cède la place à celui de l’agent, et le choix est expliqué (`fallback`).
 */
import { installedOf, usableProvider, useHarnesses } from "./harness/installed";
import { PROVIDER_LABEL } from "./harness/types";
import { type ModelChoice, useAgentPreferences } from "./panel/ModelPicker";
import { type AgentDefaults, useAgents } from "./store";

export interface PageModel extends ModelChoice {
  /** Pourquoi ce n’est pas le modèle réglé pour les pages qui sert ; absent quand c’est lui (ou « Comme l’agent »). */
  fallback?: string;
}

/** Harnais, modèle et effort de l’agent : ceux d’une nouvelle conversation. */
export function agentModel(defaults: AgentDefaults): ModelChoice {
  const provider = usableProvider(defaults.provider);
  return { provider, ...(defaults.models[provider] ?? {}) };
}

/**
 * Modèle des pages : le réglage s’il est installé, sinon celui de l’agent. Un harnais choisi sans modèle prend le
 * modèle et l’effort réglés pour lui dans « Modèle et raisonnement ».
 */
export function pageModelOf(defaults: AgentDefaults, setting: ModelChoice | null | undefined): PageModel {
  const agent = agentModel(defaults);
  if (!setting?.provider) return agent;
  const installed = installedOf(useHarnesses.getState().probes);
  if (installed && !installed.includes(setting.provider))
    return {
      ...agent,
      fallback: `${PROVIDER_LABEL[setting.provider]}, réglé pour les pages, n’est plus installé : ${PROVIDER_LABEL[agent.provider]}, celui de l’agent, le remplace`,
    };
  if (!setting.model) return { provider: setting.provider, ...(defaults.models[setting.provider] ?? {}) };
  return { provider: setting.provider, model: setting.model, ...(setting.effort ? { effort: setting.effort } : {}) };
}

/** Lit les réglages au besoin, puis rend le modèle des pages et celui de l’agent (le repli). */
export async function resolvePageModel(): Promise<{ page: PageModel; agent: ModelChoice }> {
  if (!useAgents.getState().ready) await useAgents.getState().load();
  const preferences = useAgentPreferences.getState();
  if (preferences.status !== "ready") await preferences.load();
  const { defaults } = useAgents.getState();
  return {
    page: pageModelOf(defaults, useAgentPreferences.getState().values.pageModel),
    agent: agentModel(defaults),
  };
}

export function sameModel(left: ModelChoice, right: ModelChoice): boolean {
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort;
}

/** « Claude Code · sonnet », ou « Claude Code · modèle par défaut ». */
export function modelSummary(choice: ModelChoice): string {
  return `${PROVIDER_LABEL[choice.provider]} · ${choice.model ?? "modèle par défaut"}`;
}
