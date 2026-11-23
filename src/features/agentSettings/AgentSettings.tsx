/**
 * Rubrique « Agent » des Réglages, décrite par données pour `SettingsPage` de Socle : état des harnais, harnais,
 * modèle et raisonnement par défaut, modèle de nommage, modèle des pages, modèles affichés, autonomie, éditeur de
 * texte et conversations archivées.
 */
import { ListChecks, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  SearchField,
  type SelectOption,
  type Setting,
  type SettingsSection,
  type SettingTag,
} from "socle-ui";
import { Stack } from "../../kit";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { effortLabel } from "../agent/effort";
import {
  ALL_PROVIDERS,
  type Autonomy,
  checkHarnesses,
  type HarnessModel,
  listModels,
  PROVIDER_LABEL,
  type Provider,
  type probe,
  useHarnesses,
  useInstalledProviders,
} from "../agent/harness";
import {
  type ModelChoice,
  type ShownModels,
  shownModelsOf,
  useAgentPreferences,
  usePreferences,
} from "../agent/panel/ModelPicker";
import { type AgentDefaults, useAgents } from "../agent/store";
import { useArchivedSection } from "./ArchivedConversations";

type ProbeResult = Awaited<ReturnType<typeof probe>>;
type Loadable<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

export const AUTONOMY: Array<{ value: Autonomy; label: string; description: string }> = [
  {
    value: "ask",
    label: "Libre dans ses dossiers, accord ailleurs",
    description:
      "L’agent lit et écrit sans demander dans le dossier de l’espace de travail et dans le dossier de travail. Il vous présente une carte d’accord pour lancer une commande, écrire ailleurs ou accéder au réseau.",
  },
  {
    value: "auto",
    label: "Autonomie totale",
    description: "L’agent ne demande jamais : commandes, écritures et réseau partout où son CLI le permet.",
  },
  {
    value: "strict",
    label: "Accord à chaque action",
    description:
      "L’agent demande votre accord avant chaque écriture et chaque commande, même dans l’espace de travail.",
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Valeur des listes pour « aucun choix » : un `Select` de Socle n’a pas d’option vide. */
const NONE = "__default";

const TEXT_EDITOR_DIRECTORY_PLACEHOLDER = "{{directory}}";

/** Erreur de la commande de l’éditeur, repris de `validateTextEditorCommand` de OneApp. */
export function validateTextEditorCommand(command: string): string | undefined {
  const value = command.trim();
  if (!value) return "Saisissez la commande de lancement de l’éditeur.";
  if (!value.includes(TEXT_EDITOR_DIRECTORY_PLACEHOLDER))
    return `Ajoutez ${TEXT_EDITOR_DIRECTORY_PLACEHOLDER} pour transmettre le dossier à l’éditeur.`;
  let quoted = false;
  for (const character of value) if (character === '"') quoted = !quoted;
  if (quoted) return "Fermez les guillemets de la commande de l’éditeur.";
  return undefined;
}

/** Étiquettes et phrase d’un harnais, d’après sa dernière vérification. */
function harnessState(provider: Provider, state: Loadable<ProbeResult> | undefined) {
  const label = PROVIDER_LABEL[provider];
  const tags: SettingTag[] = [];
  let description: string | undefined;
  if (!state || state.status === "loading") tags.push({ label: "Vérification…", tone: "pending" });
  else if (state.status === "error") {
    tags.push({ label: "État inconnu", tone: "neutral" });
    description = `L’état de ${label} n’a pas pu être vérifié : ${state.message}`;
  } else if (!state.value.installed) {
    tags.push({ label: "Non installé", tone: "danger" });
    description = `Installez ${label}, puis connectez-vous dans un terminal ; Alfred le détecte à la prochaine vérification.`;
  } else {
    tags.push({ label: state.value.version ? `Installé · ${state.value.version}` : "Installé", tone: "success" });
    if (state.value.loggedIn === true) tags.push({ label: "Connecté", tone: "success" });
    if (state.value.loggedIn === false) {
      tags.push({ label: "Non connecté", tone: "pending" });
      description = `Connectez-vous à ${label} dans un terminal pour qu’Alfred puisse l’utiliser.`;
    }
  }
  return { tags, description };
}

/** Options de modèle : « par défaut », le modèle choisi s’il n’est plus listé, puis les modèles affichés. */
function modelOptions(
  list: readonly HarnessModel[],
  current: string | undefined,
  defaultLabel: string,
): SelectOption[] {
  return [
    { id: NONE, label: defaultLabel },
    ...(current && !list.some((model) => model.id === current) ? [{ id: current, label: current }] : []),
    ...list.map((model) => ({ id: model.id, label: model.name })),
  ];
}

function effortOptions(efforts: readonly string[]): SelectOption[] {
  return [{ id: NONE, label: "Par défaut" }, ...efforts.map((effort) => ({ id: effort, label: effortLabel(effort) }))];
}

const fromOption = (id: string) => (id === NONE ? undefined : id);

/** Choix des modèles affichés d’un harnais : une recherche et une case par modèle. */
function ShownModelsDialog({
  provider,
  models,
  shownModels,
  onSave,
  onClose,
}: {
  provider: Provider;
  models: readonly HarnessModel[];
  shownModels: ShownModels;
  onSave: (next: ShownModels) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = shownModels[provider];
  const isShown = (id: string) => !shown || shown.includes(id);
  const search = query.trim().toLocaleLowerCase("fr");
  const visible = models.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase("fr").includes(search));
  const setShown = (ids: string[] | undefined) => {
    const next = { ...shownModels };
    if (ids) next[provider] = ids;
    else delete next[provider];
    onSave(next);
  };
  const toggle = (id: string) => {
    const current = shown ?? models.map((model) => model.id);
    setShown(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const shownCount = models.filter(({ id }) => isShown(id)).length;
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Modèles ${PROVIDER_LABEL[provider]}`}
      description={`${shownCount} affiché${shownCount > 1 ? "s" : ""} sur ${models.length}. Un modèle masqué reste utilisable s’il est déjà choisi.`}
      footer={
        <ButtonsFor
          shown={Boolean(shown)}
          none={shownCount === 0}
          onAll={() => setShown(undefined)}
          onNone={() => setShown([])}
        />
      }
    >
      <Stack gap="md">
        <SearchField
          label={`les modèles ${PROVIDER_LABEL[provider]}`}
          onChange={(criteria) => setQuery(criteria.text)}
        />
        {visible.length ? (
          <Stack gap="sm">
            {visible.map((model) => (
              <Checkbox
                key={model.id}
                isSelected={isShown(model.id)}
                description={
                  model.efforts.length ? model.efforts.map(effortLabel).join(" · ") : "raisonnement par défaut"
                }
                onChange={() => toggle(model.id)}
              >
                {model.name}
              </Checkbox>
            ))}
          </Stack>
        ) : (
          <EmptyState size="compact" title="Aucun modèle trouvé" description="Modifiez votre recherche." />
        )}
      </Stack>
    </Dialog>
  );
}

function ButtonsFor({
  shown,
  none,
  onAll,
  onNone,
}: {
  shown: boolean;
  none: boolean;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <>
      <Button isDisabled={!shown} onPress={onAll}>
        Tout afficher
      </Button>
      <Button isDisabled={none} onPress={onNone}>
        Tout masquer
      </Button>
    </>
  );
}

/**
 * Trois lignes d’un modèle choisi à part de celui des conversations (nommage, pages) : le harnais (ou « comme
 * l’agent »), un de ses modèles affichés, et son raisonnement.
 */
function modelChoiceRows({
  id,
  title,
  description,
  subject,
  inheritLabel,
  modelDefaultLabel,
  value,
  providers,
  catalog,
  shownModels,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  subject: string;
  inheritLabel: string;
  modelDefaultLabel: string;
  value: ModelChoice | null;
  providers: readonly Provider[];
  catalog: (provider: Provider) => HarnessModel[];
  shownModels: ShownModels;
  onChange: (value: ModelChoice | null) => unknown;
}): Setting[] {
  const shown = (provider: Provider) =>
    shownModelsOf(catalog(provider), shownModels[provider], provider === value?.provider ? value?.model : undefined);
  const provider = value?.provider;
  const selected = provider ? catalog(provider).find((model) => model.id === value?.model) : undefined;
  const rows: Setting[] = [
    {
      id: `${id}-provider`,
      type: "select",
      label: `Harnais ${subject}`,
      description: `${title} : ${description.charAt(0).toLocaleLowerCase("fr")}${description.slice(1)}`,
      value: provider ?? NONE,
      options: [
        { id: NONE, label: inheritLabel },
        // Un harnais réglé puis désinstallé reste affiché : le réglage n’est pas perdu en silence.
        ...(provider && !providers.includes(provider)
          ? [{ id: provider, label: `${PROVIDER_LABEL[provider]} (non installé)` }]
          : []),
        ...providers.map((item) => ({ id: item, label: PROVIDER_LABEL[item] })),
      ],
      onChange: (next) => {
        if (next === NONE) return onChange(null);
        const first = shown(next as Provider)[0];
        return onChange({ provider: next as Provider, ...(first ? { model: first.id } : {}) });
      },
    },
  ];
  if (provider) {
    rows.push({
      id: `${id}-model`,
      type: "select",
      label: `Modèle ${subject}`,
      value: value?.model ?? NONE,
      options: modelOptions(shown(provider), value?.model, modelDefaultLabel),
      onChange: (next) => onChange({ provider, ...(fromOption(next) ? { model: next } : {}) }),
    });
  }
  if (value && selected?.efforts.length) {
    rows.push({
      id: `${id}-effort`,
      type: "select",
      label: `Raisonnement ${subject}`,
      value: value.effort ?? NONE,
      options: effortOptions(selected.efforts),
      onChange: (next) =>
        onChange({ provider: value.provider, model: value.model, ...(fromOption(next) ? { effort: next } : {}) }),
    });
  }
  return rows;
}

/** Rubrique « Agent » des Réglages. */
export function useAgentSections(): SettingsSection[] {
  const defaults = useAgents((state) => state.defaults);
  const ready = useAgents((state) => state.ready);
  const cwd = useShell((state) => state.snapshot?.path ?? state.info?.home ?? "");
  const probes = useHarnesses((state) => state.probes);
  const installed = useInstalledProviders();
  /** Harnais affichés : les installés ; tous tant que la première vérification n’est pas finie. */
  const PROVIDERS = installed ?? ALL_PROVIDERS;
  const [models, setModels] = useState<Partial<Record<Provider, Loadable<HarnessModel[]>>>>({});
  const preferences = usePreferences();
  const savePreference = useAgentPreferences((state) => state.save);
  const preferencesStatus = useAgentPreferences((state) => state.status);
  const [choosing, setChoosing] = useState<Provider>();
  const archived = useArchivedSection();

  useEffect(() => {
    if (!ready)
      void useAgents
        .getState()
        .load()
        .catch(() => {});
  }, [ready]);

  const loadModels = useCallback(
    (provider: Provider) => {
      setModels((current) => ({ ...current, [provider]: { status: "loading" } }));
      listModels(provider, cwd).then(
        (value) => setModels((current) => ({ ...current, [provider]: { status: "ready", value } })),
        (error) =>
          setModels((current) => ({ ...current, [provider]: { status: "error", message: errorMessage(error) } })),
      );
    },
    [cwd],
  );

  // Les harnais sont vérifiés au démarrage d’Alfred ; les modèles se lisent pour ceux qui sont installés.
  const installedKey = (installed ?? []).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `installedKey` résume la liste des harnais installés.
  useEffect(() => {
    for (const provider of installed ?? []) loadModels(provider);
  }, [loadModels, installedKey]);

  /** Réglage immédiat : un échec remet la valeur précédente et le signale. */
  const save = async (next: AgentDefaults) => {
    const previous = useAgents.getState().defaults;
    try {
      await useAgents.getState().setDefaults(next);
    } catch (error) {
      useAgents.setState({ defaults: previous });
      throw error;
    }
  };

  const catalog = (provider: Provider) => {
    const loaded = models[provider];
    return loaded?.status === "ready" ? loaded.value : [];
  };

  const checking = ALL_PROVIDERS.some((provider) => probes[provider]?.status === "loading");
  const none = installed !== null && installed.length === 0;

  const harnessRows: Setting[] = PROVIDERS.map((provider) => {
    const list = catalog(provider);
    const shown = preferences.shownModels[provider];
    const shownCount = shown ? list.filter(({ id }) => shown.includes(id)).length : list.length;
    const { tags, description } = harnessState(provider, probes[provider]);
    return {
      id: `harness-${provider}`,
      type: "item",
      label: PROVIDER_LABEL[provider],
      description: [
        description,
        list.length ? `${shownCount} / ${list.length} modèles affichés` : "Aucun modèle chargé",
      ]
        .filter(Boolean)
        .join(" "),
      tags,
      actions: [
        {
          id: "models",
          label: `Choisir les modèles de ${PROVIDER_LABEL[provider]}`,
          icon: <ListChecks size={16} aria-hidden="true" />,
          isDisabled: !list.length,
          onPress: () => setChoosing(provider),
        },
      ],
    };
  });

  const modelRows: Setting[] = PROVIDERS.flatMap((provider): Setting[] => {
    const label = PROVIDER_LABEL[provider];
    const loaded = models[provider];
    const value = defaults.models[provider] ?? {};
    const list = shownModelsOf(catalog(provider), preferences.shownModels[provider], value.model);
    const selected = list.find((model) => model.id === value.model);
    const rows: Setting[] = [
      {
        id: `model-${provider}`,
        type: "select",
        label: `Modèle de ${label}`,
        description:
          loaded?.status === "error"
            ? `Les modèles de ${label} n’ont pas pu être lus : ${loaded.message} Vérifiez que le CLI est installé et connecté.`
            : !loaded || loaded.status === "loading"
              ? "Chargement des modèles…"
              : undefined,
        value: value.model ?? NONE,
        isDisabled: loaded?.status !== "ready",
        options: modelOptions(list, value.model, "Modèle par défaut"),
        // Comme dans OneApp, changer de modèle revient à son raisonnement par défaut.
        onChange: (next) =>
          save({
            ...defaults,
            models: { ...defaults.models, [provider]: { model: fromOption(next), effort: undefined } },
          }),
      },
    ];
    if (loaded?.status === "error") {
      rows.push({
        id: `retry-${provider}`,
        type: "action",
        label: `Relire les modèles de ${label}`,
        action: { id: "retry", label: "Réessayer", onPress: () => loadModels(provider) },
      });
    }
    if (selected?.efforts.length) {
      rows.push({
        id: `effort-${provider}`,
        type: "select",
        label: `Raisonnement de ${label}`,
        value: value.effort ?? NONE,
        options: effortOptions(selected.efforts),
        onChange: (next) =>
          save({
            ...defaults,
            models: { ...defaults.models, [provider]: { model: value.model, effort: fromOption(next) } },
          }),
      });
    }
    return rows;
  });

  const choice = (key: "titling" | "pageModel") => (value: ModelChoice | null) => savePreference(key, value);
  const autonomy = AUTONOMY.find((level) => level.value === defaults.autonomy);
  const textEditor = preferences.textEditor?.command ?? "";

  const sections: SettingsSection[] = [
    {
      id: "harnesses",
      title: "Harnais",
      description:
        "Alfred pilote le CLI de l’agent installé sur ce poste. Installation et connexion se font dans un terminal.",
      actions: [
        {
          id: "check",
          label: "Vérifier de nouveau les harnais",
          icon: <RefreshCw size={16} aria-hidden="true" />,
          isDisabled: checking,
          onPress: () => {
            // Comme « Actualiser les modèles » de OneApp : vérifier le harnais relit aussi ses modèles.
            void checkHarnesses();
            for (const provider of installed ?? []) loadModels(provider);
          },
        },
      ],
      settings: none ? [] : harnessRows,
      content: none ? (
        <EmptyState
          size="compact"
          title="Aucun agent installé"
          description="Installez Claude Code, Codex ou OpenCode sur ce poste, puis connectez-vous-y dans un terminal. Vérifiez ensuite de nouveau : l’agent apparaîtra ici et dans le menu."
        />
      ) : choosing ? (
        <ShownModelsDialog
          provider={choosing}
          models={catalog(choosing)}
          shownModels={preferences.shownModels}
          onSave={(next) =>
            void savePreference("shownModels", next).catch((error) =>
              notify({
                title: "Le réglage des agents n’a pas été enregistré",
                description: errorMessage(error),
                tone: "error",
              }),
            )
          }
          onClose={() => setChoosing(undefined)}
        />
      ) : undefined,
    },
  ];

  if (!none) {
    sections.push(
      {
        id: "conversations",
        title: "Conversations",
        description:
          "Choix utilisés pour toute nouvelle conversation. Ils s’appliquent dès qu’ils sont modifiés ; chaque conversation peut les changer.",
        settings: [
          {
            id: "provider",
            type: "select",
            label: "Harnais par défaut",
            description: "L’agent qui répond quand vous ouvrez une conversation.",
            value: defaults.provider,
            options: PROVIDERS.map((provider) => ({ id: provider, label: PROVIDER_LABEL[provider] })),
            onChange: (provider) => save({ ...defaults, provider: provider as Provider }),
          },
        ],
      },
      {
        id: "models",
        title: "Modèle et raisonnement",
        description:
          "Le modèle et le niveau de raisonnement de chaque harnais. Un modèle masqué reste utilisable s’il est déjà choisi.",
        settings: [
          ...modelRows,
          ...modelChoiceRows({
            id: "titling",
            title: "Nommage",
            description: "Le modèle qui donne un nom aux conversations d’après leur premier message.",
            subject: "du nommage",
            inheritLabel: "Comme les conversations",
            modelDefaultLabel: "Modèle par défaut",
            value: preferences.titling,
            providers: PROVIDERS,
            catalog,
            shownModels: preferences.shownModels,
            onChange: choice("titling"),
          }),
        ],
      },
      {
        id: "pages",
        title: "Dans les pages",
        description: "Pour résumer, classer ou rédiger depuis vos pages et vos fonctions.",
        settings: modelChoiceRows({
          id: "page-model",
          title: "Modèle des pages",
          description: "« Comme l’agent » reprend le harnais, le modèle et le raisonnement des conversations.",
          subject: "des pages",
          inheritLabel: "Comme l’agent",
          modelDefaultLabel: "Modèle de l’agent pour ce harnais",
          value: preferences.pageModel,
          providers: PROVIDERS,
          catalog,
          shownModels: preferences.shownModels,
          onChange: choice("pageModel"),
        }),
      },
    );
  }

  sections.push(
    {
      id: "autonomy",
      title: "Autonomie par défaut",
      description: "Ce que l’agent peut faire sans vous demander. Chaque conversation peut la changer.",
      settings: [
        {
          id: "autonomy",
          type: "select",
          label: "Autonomie par défaut",
          description: autonomy?.description,
          value: defaults.autonomy,
          width: "lg",
          options: AUTONOMY.map((level) => ({ id: level.value, label: level.label })),
          onChange: (value) => save({ ...defaults, autonomy: value as Autonomy }),
        },
      ],
    },
    {
      id: "text-editor",
      title: "Éditeur de texte",
      description: "Ouvre le dossier de travail d’une conversation depuis la barre de la page Agent.",
      actions: [
        {
          id: "disable",
          label: "Désactiver l’éditeur de texte",
          icon: <X size={16} aria-hidden="true" />,
          isHidden: !textEditor,
          onPress: () => savePreference("textEditor", null),
        },
      ],
      settings: [
        {
          id: "command",
          type: "text",
          label: "Commande de lancement",
          description: `Insérez ${TEXT_EDITOR_DIRECTORY_PLACEHOLDER} à l’endroit où le dossier doit être transmis. Les guillemets sont nécessaires si le chemin contient des espaces.`,
          value: textEditor,
          width: "lg",
          isDisabled: preferencesStatus === "loading",
          placeholder: `code --reuse-window "${TEXT_EDITOR_DIRECTORY_PLACEHOLDER}"`,
          validate: (value) => (value.trim() ? validateTextEditorCommand(value) : null),
          onChange: (value) => savePreference("textEditor", value.trim() ? { command: value.trim() } : null),
        },
      ],
    },
    archived,
  );
  return sections;
}
