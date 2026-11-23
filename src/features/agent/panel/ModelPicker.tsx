import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Popover, RadioGroup, Select } from "socle-ui";
import { create } from "zustand";
import { Stack, Text } from "../../../kit";
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
 * Choix du modèle d’une conversation, repris de `AgentModelPicker` de OneApp : le harnais en onglets segmentés,
 * le modèle en liste (les seuls modèles affichés dans les réglages, plus celui déjà choisi), puis le raisonnement en curseur sur les seuls niveaux que ce modèle propose. Le harnais ne
 * change plus une fois la conversation commencée : la session de l’agent y reste attachée.
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
  const label = modelChoiceLabel(value, models);
  const modelOptions = [
    { id: DEFAULT_MODEL, label: "Modèle par défaut" },
    ...(value.model && !current ? [{ id: value.model, label: value.model }] : []),
    ...choices.map((model) => ({ id: model.id, label: model.name })),
  ];
  return (
    <Popover
      label="Modèle de l’agent"
      // Un cran par niveau de raisonnement : au-delà de quatre, la fenêtre s’élargit pour que les libellés restent lisibles.
      width={(current?.efforts.length ?? 0) > 4 ? "lg" : "md"}
      placement={placement === "below" ? "bottom start" : "bottom end"}
      isOpen={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          size="sm"
          variant="subtle"
          icon={<ChevronDown size={13} />}
          aria-label={`Modèle de l’agent : ${label}`}
          isDisabled={disabled}
        >
          {label}
        </Button>
      }
    >
      <Stack gap="md">
        {providers.length > 1 ? (
          <RadioGroup
            label="Harnais"
            orientation="horizontal"
            value={value.provider}
            onChange={(provider) => {
              if (provider !== value.provider) onChange({ provider: provider as Provider });
            }}
          >
            {providers.map((provider) => (
              <RadioGroup.Option
                key={provider}
                value={provider}
                isDisabled={providerLocked && provider !== value.provider}
              >
                {PROVIDER_LABEL[provider]}
              </RadioGroup.Option>
            ))}
          </RadioGroup>
        ) : null}
        {providerLocked && others.length > 0 ? (
          <Text tone="muted" size="meta">
            {`Harnais fixé : cette conversation a commencé avec ${PROVIDER_LABEL[value.provider]}. Pour ${others
              .map((provider) => PROVIDER_LABEL[provider])
              .join(" ou ")}, ouvrez une nouvelle conversation.`}
          </Text>
        ) : null}
        <Select
          label="Modèle"
          value={value.model ?? DEFAULT_MODEL}
          options={modelOptions}
          onChange={(model) =>
            onChange({ provider: value.provider, model: model && model !== DEFAULT_MODEL ? model : undefined })
          }
        />
        <EffortSlider
          efforts={current?.efforts ?? []}
          value={value.effort ?? ""}
          onChange={(effort) => onChange({ ...value, effort: effort || undefined })}
        />
      </Stack>
    </Popover>
  );
}

/** Identifiant du choix « Modèle par défaut » dans la liste (Select n’accepte pas d’identifiant vide). */
const DEFAULT_MODEL = "__default__";
