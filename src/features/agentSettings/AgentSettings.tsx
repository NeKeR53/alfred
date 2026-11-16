import {
  Button,
  ChoiceButton,
  ChoiceGroup,
  Page,
  RadioControl,
  RefreshButton,
  Row,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  Spinner,
  StatusBadge,
  Text,
} from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { effortLabel } from "../agent/effort";
import { type Autonomy, type HarnessModel, listModels, PROVIDER_LABEL, type Provider, probe } from "../agent/harness";
import { type AgentDefaults, useAgents } from "../agent/store";
import { ArchivedConversations } from "./ArchivedConversations";

const PROVIDERS: Provider[] = ["claude", "codex", "opencode"];

type ProbeResult = Awaited<ReturnType<typeof probe>>;
type Loadable<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

export const AUTONOMY: Array<{ value: Autonomy; label: string; description: string }> = [
  {
    value: "ask",
    label: "Libre dans ses dossiers, accord ailleurs",
    description:
      "L’agent lit et écrit sans demander dans le dossier de l’espace et dans le dossier de travail. Il vous présente une carte d’accord pour lancer une commande, écrire ailleurs ou accéder au réseau.",
  },
  {
    value: "auto",
    label: "Autonomie totale",
    description: "L’agent ne demande jamais : commandes, écritures et réseau partout où son CLI le permet.",
  },
  {
    value: "strict",
    label: "Accord à chaque action",
    description: "L’agent demande votre accord avant chaque écriture et chaque commande, même dans l’espace.",
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function HarnessStatus({ provider, state }: { provider: Provider; state: Loadable<ProbeResult> | undefined }) {
  const label = PROVIDER_LABEL[provider];
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
    </SettingRow>
  );
}

function ModelFields({
  provider,
  models,
  value,
  onChange,
  onRetry,
}: {
  provider: Provider;
  models: Loadable<HarnessModel[]> | undefined;
  value: { model?: string; effort?: string };
  onChange: (value: { model?: string; effort?: string }) => void;
  onRetry: () => void;
}) {
  const label = PROVIDER_LABEL[provider];
  const list = models?.status === "ready" ? models.value : [];
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
        ) : selected && efforts.length === 0 ? (
          "Ce modèle ne propose pas de niveau d’effort."
        ) : undefined
      }
    >
      <SelectControl
        aria-label={`Modèle de ${label}`}
        value={value.model ?? ""}
        disabled={models?.status !== "ready"}
        onChange={(event) => {
          const model = event.target.value || undefined;
          const nextEfforts = list.find((candidate) => candidate.id === model)?.efforts ?? [];
          onChange({
            model,
            effort: value.effort && nextEfforts.includes(value.effort) ? value.effort : undefined,
          });
        }}
      >
        <option value="">Modèle par défaut</option>
        {value.model && !selected ? <option value={value.model}>{value.model}</option> : null}
        {list.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </SelectControl>
      <SelectControl
        aria-label={`Effort de ${label}`}
        value={value.effort ?? ""}
        disabled={efforts.length === 0}
        onChange={(event) => onChange({ model: value.model, effort: event.target.value || undefined })}
      >
        <option value="">Effort par défaut</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effortLabel(effort)}
          </option>
        ))}
      </SelectControl>
    </SettingRow>
  );
}

/** Onglet « Agents » des Réglages : état des harnais, harnais, modèle, effort et autonomie par défaut. */
export function AgentSettings() {
  const defaults = useAgents((state) => state.defaults);
  const ready = useAgents((state) => state.ready);
  const cwd = useShell((state) => state.snapshot?.path ?? state.info?.home ?? "");
  const [probes, setProbes] = useState<Partial<Record<Provider, Loadable<ProbeResult>>>>({});
  const [models, setModels] = useState<Partial<Record<Provider, Loadable<HarnessModel[]>>>>({});

  useEffect(() => {
    if (!ready)
      void useAgents
        .getState()
        .load()
        .catch(() => {});
  }, [ready]);

  const check = useCallback(() => {
    for (const provider of PROVIDERS) {
      setProbes((current) => ({ ...current, [provider]: { status: "loading" } }));
      probe(provider).then(
        (value) => setProbes((current) => ({ ...current, [provider]: { status: "ready", value } })),
        (error) =>
          setProbes((current) => ({ ...current, [provider]: { status: "error", message: errorMessage(error) } })),
      );
    }
  }, []);

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

  useEffect(() => check(), [check]);
  useEffect(() => {
    for (const provider of PROVIDERS) loadModels(provider);
  }, [loadModels]);

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

  const checking = PROVIDERS.some((provider) => probes[provider]?.status === "loading");

  return (
    <Page width="text">
      <Section
        title="Harnais"
        description="Alfred pilote le CLI de l’agent installé sur ce poste. Installation et connexion se font dans un terminal."
        actions={<RefreshButton label="Vérifier de nouveau les harnais" loading={checking} onClick={check} />}
      >
        <SettingRows>
          {PROVIDERS.map((provider) => (
            <HarnessStatus key={provider} provider={provider} state={probes[provider]} />
          ))}
        </SettingRows>
      </Section>

      <Section
        title="Conversations"
        description="Choix utilisés pour toute nouvelle conversation. Ils s’appliquent dès qu’ils sont modifiés ; chaque conversation peut les changer."
      >
        <SettingRows>
          <SettingRow title="Harnais par défaut" description="L’agent qui répond quand vous ouvrez une conversation.">
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

      <Section title="Modèle et effort" description="Le modèle et le niveau d’effort de chaque harnais.">
        <SettingRows>
          {PROVIDERS.map((provider) => (
            <ModelFields
              key={provider}
              provider={provider}
              models={models[provider]}
              value={defaults.models[provider] ?? {}}
              onRetry={() => loadModels(provider)}
              onChange={(value) => void save({ ...defaults, models: { ...defaults.models, [provider]: value } })}
            />
          ))}
        </SettingRows>
      </Section>

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

      <ArchivedConversations />
    </Page>
  );
}
