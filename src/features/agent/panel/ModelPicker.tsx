import { useEffect, useState } from "react";
import { ChatOptionButton, Popover, RadioButtonGroup, Select } from "socle-ui";
import { create } from "zustand";
import { Stack } from "../../../kit";
import { invoke } from "../../../lib/native";
import { effortLabel } from "../effort";
import {
  ALL_PROVIDERS,
  type HarnessModel,
  listModels,
  PROVIDER_LABEL,
  type Provider,
  useInstalledProviders,
} from "../harness";
import { EffortSlider } from "./EffortSlider";

export interface ModelChoice {
  provider: Provider;
  model?: string;
  effort?: string;
}

/** Modèles proposés dans les sélecteurs, par harnais ; absent pour un harnais : tous ses modèles sont proposés. */
export type ShownModels = Partial<Record<Provider, string[]>>;

/**
 * Préférences des agents enregistrées hors des choix par défaut, comme dans les réglages des agents de OneApp
 * (`agentSettings.ts`) : modèles affichés par harnais, modèle qui nomme les conversations (absent : celui des
 * conversations), modèle des pages et des fonctions (`ai.oneShot`, `ai.startAgent` ; absent : celui de l’agent),
 * éditeur de texte qui ouvre le dossier de travail.
 */
export interface AgentPreferences {
  shownModels: ShownModels;
  titling: ModelChoice | null;
  pageModel: ModelChoice | null;
  textEditor: { command: string } | null;
}

const PREFERENCE_KEYS: Record<keyof AgentPreferences, string> = {
  shownModels: "agents.shownModels",
  titling: "agents.titling",
  pageModel: "agents.pageModel",
  textEditor: "agents.textEditor",
};

const EMPTY_PREFERENCES: AgentPreferences = { shownModels: {}, titling: null, pageModel: null, textEditor: null };

interface PreferencesState {
  values: AgentPreferences;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  load: () => Promise<void>;
  /** Enregistre aussitôt ; un échec remet la valeur précédente et remonte l’erreur. */
  save: <Key extends keyof AgentPreferences>(key: Key, value: AgentPreferences[Key]) => Promise<void>;
}

export const useAgentPreferences = create<PreferencesState>((set, get) => ({
  values: EMPTY_PREFERENCES,
  status: "idle",
  async load() {
    set({ status: "loading", error: undefined });
    try {
      const keys = Object.keys(PREFERENCE_KEYS) as Array<keyof AgentPreferences>;
      const read = await Promise.all(keys.map((key) => invoke<unknown>("settings.get", { key: PREFERENCE_KEYS[key] })));
      const values = { ...EMPTY_PREFERENCES };
      keys.forEach((key, index) => {
        if (read[index] !== null && read[index] !== undefined) Object.assign(values, { [key]: read[index] });
      });
      set({ values, status: "ready" });
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async save(key, value) {
    const previous = get().values;
    set({ values: { ...previous, [key]: value } });
    try {
      await invoke("settings.set", { key: PREFERENCE_KEYS[key], value });
    } catch (error) {
      set({ values: { ...get().values, [key]: previous[key] } });
      throw error;
    }
  },
}));

/** Préférences des agents, chargées à la première lecture. */
export function usePreferences(): AgentPreferences {
  const values = useAgentPreferences((state) => state.values);
  const status = useAgentPreferences((state) => state.status);
  useEffect(() => {
    if (status === "idle") void useAgentPreferences.getState().load();
  }, [status]);
  return values;
}

/** Modèles affichés d’un harnais ; un modèle déjà choisi reste proposé même masqué, comme dans OneApp. */
export function shownModelsOf(
  models: readonly HarnessModel[],
  shown: readonly string[] | undefined,
  selected?: string,
): HarnessModel[] {
  return models.filter((model) => !shown || shown.includes(model.id) || model.id === selected);
}

/** Modèles d’un harnais, relus quand le harnais ou le dossier change. */
export function useHarnessModels(provider: Provider, cwd: string) {
  const [models, setModels] = useState<HarnessModel[]>([]);
  useEffect(() => {
    let active = true;
    setModels([]);
    listModels(provider, cwd).then(
      (catalog) => active && setModels(catalog),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [provider, cwd]);
  return models;
}

/** Libellé court du choix, comme « gpt-6.1 · élevé » dans OneApp. */
export function modelChoiceLabel(choice: ModelChoice, models: readonly HarnessModel[]): string {
  const model = choice.model ? (models.find(({ id }) => id === choice.model)?.name ?? choice.model) : undefined;
  const effort = choice.effort ? effortLabel(choice.effort).toLocaleLowerCase("fr") : undefined;
  return [model ?? `${PROVIDER_LABEL[choice.provider]} · modèle par défaut`, effort].filter(Boolean).join(" · ");
}

/**
 * Choix du modèle d’une conversation, assemblé selon D-380 : un `ChatOptionButton` (modèle, puis raisonnement en
 * valeur) ouvre un `Popover` de champs sans titre. Le harnais en boutons radio (propre à Alfred), le modèle en liste
 * (les seuls modèles affichés dans les réglages, plus celui déjà choisi), puis le raisonnement en curseur à crans sur
 * les seuls niveaux que ce modèle propose. Le harnais ne change plus une fois la conversation commencée : la session
 * de l’agent y reste attachée.
 */
export function ModelPicker({
  value,
  cwd,
  providerLocked,
  disabled,
  onChange,
  placement = "above",
}: {
  value: ModelChoice;
  cwd: string;
  providerLocked?: boolean;
  disabled?: boolean;
  onChange: (choice: ModelChoice) => void;
  placement?: "above" | "below";
}) {
  const [open, setOpen] = useState(false);
  const models = useHarnessModels(value.provider, cwd);
  const { shownModels } = usePreferences();
  const current = models.find(({ id: model }) => model === value.model);
  const choices = shownModelsOf(models, shownModels[value.provider], value.model);
  // Seuls les harnais installés sont proposés ; celui de la conversation reste affiché même s’il ne l’est plus.
  const installed = useInstalledProviders();
  const providers = ALL_PROVIDERS.filter(
    (provider) => provider === value.provider || installed === null || installed.includes(provider),
  );
  const others = providers.filter((provider) => provider !== value.provider);
  const modelName = value.model
    ? (current?.name ?? value.model)
    : `${PROVIDER_LABEL[value.provider]} · modèle par défaut`;
  const effort = value.effort ? effortLabel(value.effort).toLocaleLowerCase("fr") : undefined;
  const modelOptions = [
    { id: DEFAULT_MODEL, label: "Modèle par défaut" },
    ...(value.model && !current ? [{ id: value.model, label: value.model }] : []),
    ...choices.map((model) => ({ id: model.id, label: model.name })),
  ];
  const efforts = current?.efforts ?? [];
  return (
    <Popover
      label="Modèle de l’agent"
      width={efforts.length > 4 ? "lg" : "md"}
      placement={placement === "below" ? "bottom start" : "bottom end"}
      isOpen={open}
      onOpenChange={setOpen}
      trigger={
        <ChatOptionButton
          label={modelName}
          value={effort}
          aria-label={`${modelChoiceLabel(value, models)} : modèle de l’agent`}
          isDisabled={disabled}
        />
      }
    >
      <Stack gap="md">
        {providers.length > 1 ? (
          <RadioButtonGroup
            label="Harnais"
            isRequired
            orientation="horizontal"
            value={value.provider}
            description={
              providerLocked && others.length > 0
                ? `Harnais fixé : cette conversation a commencé avec ${PROVIDER_LABEL[value.provider]}. Pour ${others
                    .map((provider) => PROVIDER_LABEL[provider])
                    .join(" ou ")}, ouvrez une nouvelle conversation.`
                : undefined
            }
            onChange={(provider) => {
              if (provider && provider !== value.provider) onChange({ provider: provider as Provider });
            }}
          >
            {providers.map((provider) => (
              <RadioButtonGroup.Option
                key={provider}
                value={provider}
                isDisabled={providerLocked && provider !== value.provider}
              >
                {PROVIDER_LABEL[provider]}
              </RadioButtonGroup.Option>
            ))}
          </RadioButtonGroup>
        ) : null}
        <Select
          label="Modèle"
          isRequired
          value={value.model ?? DEFAULT_MODEL}
          options={modelOptions}
          description={efforts.length ? undefined : "Raisonnement : par défaut du modèle."}
          onChange={(model) =>
            onChange({ provider: value.provider, model: model && model !== DEFAULT_MODEL ? String(model) : undefined })
          }
        />
        <EffortSlider
          efforts={efforts}
          value={value.effort ?? ""}
          onChange={(next) => onChange({ ...value, effort: next || undefined })}
        />
      </Stack>
    </Popover>
  );
}

/** Identifiant du choix « Modèle par défaut » dans la liste (Select n’accepte pas d’identifiant vide). */
const DEFAULT_MODEL = "__default__";
