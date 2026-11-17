import {
  Button,
  CheckboxControl,
  ChoiceButton,
  ChoiceGroup,
  EmptyState,
  FormField,
  Modal,
  Page,
  RadioControl,
  RefreshButton,
  Row,
  SearchField,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  Spinner,
  StatusBadge,
  Text,
  TextInput,
} from "@alfred/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { EffortSlider } from "../agent/panel/EffortSlider";
import {
  type AgentPreferences,
  type ModelChoice,
  type ShownModels,
  shownModelsOf,
  useAgentPreferences,
  usePreferences,
} from "../agent/panel/ModelPicker";
import { type AgentDefaults, useAgents } from "../agent/store";
import { ArchivedConversations } from "./ArchivedConversations";

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

/**
 * Une ligne par harnais, comme dans les réglages des agents de OneApp : son état, le nombre de modèles affichés et
 * « Choisir les modèles… ».
 */
function HarnessStatus({
  provider,
  state,
  catalog,
  shown,
  onChoose,
}: {
  provider: Provider;
  state: Loadable<ProbeResult> | undefined;
  catalog: readonly HarnessModel[];
  shown?: readonly string[];
  onChoose: () => void;
}) {
  const label = PROVIDER_LABEL[provider];
  const shownCount = shown ? catalog.filter(({ id }) => shown.includes(id)).length : catalog.length;
  const description =
    state?.status === "error"
      ? `L’état de ${label} n’a pas pu être vérifié : ${state.message}`
      : state?.status === "ready" && !state.value.installed
        ? `Installez ${label}, puis connectez-vous dans un terminal ; Alfred le détecte à la prochaine vérification.`
        : state?.status === "ready" && state.value.loggedIn === false
          ? `Connectez-vous à ${label} dans un terminal pour qu’Alfred puisse l’utiliser.`
          : undefined;
  return (
    <SettingRow title={label} description={description}>
      {!state || state.status === "loading" ? (
        <Row gap="xs">
          <Spinner label={`Vérification de ${label}`} />
          <Text as="span" tone="muted">
            Vérification…
          </Text>
        </Row>
      ) : state.status === "error" ? (
        <StatusBadge tone="warning" size="compact">
          État inconnu
        </StatusBadge>
      ) : state.value.installed ? (
        <>
          <StatusBadge tone="success" size="compact">
            {state.value.version ? `Installé · ${state.value.version}` : "Installé"}
          </StatusBadge>
          {state.value.loggedIn === true ? (
            <StatusBadge tone="success" size="compact">
              Connecté
            </StatusBadge>
          ) : state.value.loggedIn === false ? (
            <StatusBadge tone="warning" size="compact">
              Non connecté
            </StatusBadge>
          ) : null}
        </>
      ) : (
        <StatusBadge tone="danger" size="compact">
          Non installé
        </StatusBadge>
      )}
      <Text as="span" tone="muted">
        {catalog.length ? `${shownCount} / ${catalog.length} modèles affichés` : "Aucun modèle chargé"}
      </Text>
      <Button aria-label={`Choisir les modèles de ${label}`} disabled={!catalog.length} onClick={onChoose}>
        Choisir les modèles…
      </Button>
    </SettingRow>
  );
}

function ModelFields({
  provider,
  models,
  shown,
  value,
  onChange,
  onRetry,
}: {
  provider: Provider;
  models: Loadable<HarnessModel[]> | undefined;
  /** Modèles affichés de ce harnais ; absent : tous. */
  shown?: readonly string[];
  value: { model?: string; effort?: string };
  onChange: (value: { model?: string; effort?: string }) => void;
  onRetry: () => void;
}) {
  const label = PROVIDER_LABEL[provider];
  const catalog = models?.status === "ready" ? models.value : [];
  const list = shownModelsOf(catalog, shown, value.model);
  const selected = list.find((model) => model.id === value.model);
  const efforts = selected?.efforts ?? [];

  return (
    <SettingRow
      title={label}
      description={
        models?.status === "error" ? (
          <Row gap="xs" wrap>
            <span>
              Les modèles de {label} n’ont pas pu être lus : {models.message} Vérifiez que le CLI est installé et
              connecté.
            </span>
            <Button aria-label={`Relire les modèles de ${label}`} onClick={onRetry}>
              Réessayer
            </Button>
          </Row>
        ) : !models || models.status === "loading" ? (
          <Row gap="xs">
            <Spinner label={`Chargement des modèles de ${label}`} />
            <span>Chargement des modèles…</span>
          </Row>
        ) : undefined
      }
    >
      <SelectControl
        aria-label={`Modèle de ${label}`}
        value={value.model ?? ""}
        disabled={models?.status !== "ready"}
        // Comme dans OneApp, changer de modèle revient à son raisonnement par défaut.
        onChange={(event) => onChange({ model: event.target.value || undefined, effort: undefined })}
      >
        <option value="">Modèle par défaut</option>
        {value.model && !selected ? <option value={value.model}>{value.model}</option> : null}
        {list.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </SelectControl>
      {/* Comme dans OneApp : le raisonnement en curseur, sur les seuls niveaux du modèle choisi. */}
      {selected ? (
        <EffortSlider
          label={`Raisonnement de ${label}`}
          efforts={efforts}
          value={value.effort ?? ""}
          onChange={(effort) => onChange({ model: value.model, effort: effort || undefined })}
        />
      ) : null}
    </SettingRow>
  );
}

/**
 * Modèle qui nomme les conversations d’après leur premier message, repris de la ligne « Nommage » des réglages de
 * OneApp : « Comme les conversations » garde le modèle par défaut ; sinon un harnais, un de ses modèles affichés et
 * son effort.
 */
function TitlingFields({
  value,
  models,
  shownModels,
  providers,
  onChange,
}: {
  value: ModelChoice | null;
  /** Harnais installés : les seuls proposés. */
  providers: readonly Provider[];
  models: Partial<Record<Provider, Loadable<HarnessModel[]>>>;
  shownModels: ShownModels;
  onChange: (value: ModelChoice | null) => void;
}) {
  const catalog = (provider: Provider) => {
    const loaded = models[provider];
    return loaded?.status === "ready" ? loaded.value : [];
  };
  const shown = (provider: Provider) =>
    shownModelsOf(catalog(provider), shownModels[provider], provider === value?.provider ? value?.model : undefined);
  const provider = value?.provider;
  const list = provider ? shown(provider) : [];
  const selected = provider ? catalog(provider).find((model) => model.id === value?.model) : undefined;
  const efforts = selected?.efforts ?? [];
  return (
    <SettingRow
      title="Nommage"
      description="Le modèle qui donne un nom aux conversations d’après leur premier message."
    >
      <SelectControl
        aria-label="Harnais du nommage"
        value={provider ?? ""}
        onChange={(event) => {
          const next = event.target.value as Provider | "";
          if (!next) return onChange(null);
          const first = shown(next)[0];
          onChange({ provider: next, ...(first ? { model: first.id } : {}) });
        }}
      >
        <option value="">Comme les conversations</option>
        {providers.map((item) => (
          <option key={item} value={item}>
            {PROVIDER_LABEL[item]}
          </option>
        ))}
      </SelectControl>
      <SelectControl
        aria-label="Modèle du nommage"
        value={value?.model ?? ""}
        disabled={!provider}
        onChange={(event) =>
          provider && onChange({ provider, ...(event.target.value ? { model: event.target.value } : {}) })
        }
      >
        <option value="">{provider ? "Modèle par défaut" : "—"}</option>
        {value?.model && !selected ? <option value={value.model}>{value.model}</option> : null}
        {list.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </SelectControl>
      {value && selected ? (
        <EffortSlider
          label="Raisonnement du nommage"
          efforts={efforts}
          value={value.effort ?? ""}
          onChange={(effort) =>
            onChange({ provider: value.provider, model: value.model, ...(effort ? { effort } : {}) })
          }
        />
      ) : null}
    </SettingRow>
  );
}

/** Choix des modèles affichés d’un harnais, repris de `AgentModelsDialog` de OneApp (sans les demandes secrètes). */
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
    <Modal
      open
      onClose={onClose}
      title={`Modèles ${PROVIDER_LABEL[provider]}`}
      actions={
        <>
          <Text as="span" tone="muted">
            {shownCount} affiché{shownCount > 1 ? "s" : ""} sur {models.length}
          </Text>
          <Button disabled={!shown} onClick={() => setShown(undefined)}>
            Tout afficher
          </Button>
          <Button disabled={shownCount === 0} onClick={() => setShown([])}>
            Tout masquer
          </Button>
        </>
      }
    >
      <SearchField
        value={query}
        onClear={() => setQuery("")}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Rechercher…"
        label={`Rechercher un modèle ${PROVIDER_LABEL[provider]}`}
      />
      {visible.length ? (
        <SettingRows label={`Modèles ${PROVIDER_LABEL[provider]}`}>
          {visible.map((model) => (
            <SettingRow
              key={model.id}
              title={model.name}
              description={
                model.efforts.length ? model.efforts.map(effortLabel).join(" · ") : "raisonnement par défaut"
              }
            >
              <CheckboxControl
                aria-label={`Afficher ${model.name}`}
                label=""
                checked={isShown(model.id)}
                onChange={() => toggle(model.id)}
              />
            </SettingRow>
          ))}
        </SettingRows>
      ) : (
        <EmptyState size="compact" title="Aucun modèle trouvé" description="Modifiez votre recherche." />
      )}
    </Modal>
  );
}

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

/**
 * Éditeur de texte qui ouvre le dossier de travail d’une conversation, repris de « Éditeur de texte » des réglages de
 * OneApp : la commande s’enregistre d’elle-même dès qu’elle est valide ; « Désactiver » la retire.
 */
function TextEditorSection({
  saved,
  onSave,
}: {
  saved: AgentPreferences["textEditor"];
  onSave: (value: AgentPreferences["textEditor"]) => Promise<void>;
}) {
  const [command, setCommand] = useState(saved?.command ?? "");
  const savedCommand = saved?.command ?? "";
  const status = useAgentPreferences((state) => state.status);
  // La valeur enregistrée arrive après le premier rendu : elle remplace le champ tant qu’il n’a pas été modifié.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setCommand(savedCommand);
  }, [savedCommand]);
  const error = command ? validateTextEditorCommand(command) : undefined;
  useEffect(() => {
    const next = command.trim();
    if (!touched.current || !next || error || next === savedCommand) return;
    const timer = setTimeout(() => {
      onSave({ command: next }).catch((cause) =>
        notify({ title: "Enregistrement de l’éditeur impossible", description: errorMessage(cause), tone: "error" }),
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [command, error, savedCommand, onSave]);
  return (
    <Section
      title="Éditeur de texte"
      description="Ouvre le dossier de travail d’une conversation depuis la barre de la page Agent."
      actions={
        savedCommand ? (
          <Button
            onClick={() => {
              touched.current = true;
              setCommand("");
              onSave(null).catch((cause) =>
                notify({ title: "Désactivation impossible", description: errorMessage(cause), tone: "error" }),
              );
            }}
          >
            Désactiver
          </Button>
        ) : undefined
      }
    >
      <FormField
        label="Commande de lancement"
        error={error}
        hint={
          <>
            Insérez <code>{TEXT_EDITOR_DIRECTORY_PLACEHOLDER}</code> à l’endroit où le dossier doit être transmis. Les
            guillemets sont nécessaires si le chemin contient des espaces.
          </>
        }
      >
        <TextInput
          value={command}
          disabled={status === "loading"}
          onChange={(event) => {
            touched.current = true;
            setCommand(event.target.value);
          }}
          placeholder={`code --reuse-window "${TEXT_EDITOR_DIRECTORY_PLACEHOLDER}"`}
          aria-invalid={Boolean(error) || undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
    </Section>
  );
}

/**
 * Onglet « Agents » des Réglages : état des harnais, harnais, modèle, effort et autonomie par défaut, modèle de
 * nommage, modèles affichés, éditeur de texte et conversations archivées.
 */
export function AgentSettings() {
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
  const [choosing, setChoosing] = useState<Provider>();

  useEffect(() => {
    if (!ready)
      void useAgents
        .getState()
        .load()
        .catch(() => {});
  }, [ready]);

  const check = useCallback(() => void checkHarnesses(), []);

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
      notify({
        title: "Le réglage des agents n’a pas été enregistré",
        description: errorMessage(error),
        tone: "error",
      });
    }
  };

  /** Préférence immédiate : un échec garde la valeur précédente et le signale. */
  const savePreferenceOrReport = <Key extends keyof AgentPreferences>(key: Key, value: AgentPreferences[Key]) =>
    savePreference(key, value).catch((error) =>
      notify({
        title: "Le réglage des agents n’a pas été enregistré",
        description: errorMessage(error),
        tone: "error",
      }),
    );
  const saveTextEditor = useCallback(
    (value: AgentPreferences["textEditor"]) => useAgentPreferences.getState().save("textEditor", value),
    [],
  );

  const checking = ALL_PROVIDERS.some((provider) => probes[provider]?.status === "loading");
  const none = installed !== null && installed.length === 0;

  return (
    <Page width="text">
      <Section
        title="Harnais"
        description="Alfred pilote le CLI de l’agent installé sur ce poste. Installation et connexion se font dans un terminal."
        actions={
          <RefreshButton
            label="Vérifier de nouveau les harnais"
            loading={checking}
            onClick={() => {
              // Comme « Actualiser les modèles » de OneApp : vérifier le harnais relit aussi ses modèles.
              check();
              for (const provider of installed ?? []) loadModels(provider);
            }}
          />
        }
      >
        {none ? (
          <EmptyState
            size="compact"
            title="Aucun agent installé"
            description="Installez Claude Code, Codex ou OpenCode sur ce poste, puis connectez-vous-y dans un terminal. Vérifiez ensuite de nouveau : l’agent apparaîtra ici et dans le menu."
          />
        ) : (
          <SettingRows>
            {PROVIDERS.map((provider) => {
              const loaded = models[provider];
              return (
                <HarnessStatus
                  key={provider}
                  provider={provider}
                  state={probes[provider]}
                  catalog={loaded?.status === "ready" ? loaded.value : []}
                  shown={preferences.shownModels[provider]}
                  onChoose={() => setChoosing(provider)}
                />
              );
            })}
          </SettingRows>
        )}
      </Section>

      {none ? null : (
        <>
          <Section
            title="Conversations"
            description="Choix utilisés pour toute nouvelle conversation. Ils s’appliquent dès qu’ils sont modifiés ; chaque conversation peut les changer."
          >
            <SettingRows>
              <SettingRow
                title="Harnais par défaut"
                description="L’agent qui répond quand vous ouvrez une conversation."
              >
                <ChoiceGroup label="Harnais par défaut" appearance="segmented">
                  {PROVIDERS.map((provider) => (
                    <ChoiceButton
                      key={provider}
                      variant="label"
                      selectionMode="radio"
                      label={PROVIDER_LABEL[provider]}
                      selected={defaults.provider === provider}
                      onClick={() => void save({ ...defaults, provider })}
                    >
                      {PROVIDER_LABEL[provider]}
                    </ChoiceButton>
                  ))}
                </ChoiceGroup>
              </SettingRow>
            </SettingRows>
          </Section>

          <Section
            title="Modèle et raisonnement"
            description="Le modèle et le niveau de raisonnement de chaque harnais. Un modèle masqué reste utilisable s’il est déjà choisi."
          >
            <SettingRows>
              {PROVIDERS.map((provider) => (
                <ModelFields
                  key={provider}
                  provider={provider}
                  models={models[provider]}
                  shown={preferences.shownModels[provider]}
                  value={defaults.models[provider] ?? {}}
                  onRetry={() => loadModels(provider)}
                  onChange={(value) => void save({ ...defaults, models: { ...defaults.models, [provider]: value } })}
                />
              ))}
              <TitlingFields
                value={preferences.titling}
                models={models}
                shownModels={preferences.shownModels}
                providers={PROVIDERS}
                onChange={(value) => void savePreferenceOrReport("titling", value)}
              />
            </SettingRows>
          </Section>
        </>
      )}

      {choosing ? (
        <ShownModelsDialog
          provider={choosing}
          models={(() => {
            const loaded = models[choosing];
            return loaded?.status === "ready" ? loaded.value : [];
          })()}
          shownModels={preferences.shownModels}
          onSave={(next) => void savePreferenceOrReport("shownModels", next)}
          onClose={() => setChoosing(undefined)}
        />
      ) : null}

      <Section
        title="Autonomie par défaut"
        description="Ce que l’agent peut faire sans vous demander. Chaque conversation peut la changer."
      >
        <SettingRows label="Autonomie par défaut">
          {AUTONOMY.map((level) => (
            <SettingRow key={level.value} title={level.label} description={level.description}>
              <RadioControl
                name="agent-autonomy"
                value={level.value}
                aria-label={level.label}
                checked={defaults.autonomy === level.value}
                onChange={() => void save({ ...defaults, autonomy: level.value })}
                label=""
              />
            </SettingRow>
          ))}
        </SettingRows>
      </Section>

      <TextEditorSection saved={preferences.textEditor} onSave={saveTextEditor} />

      <ArchivedConversations />
    </Page>
  );
}
