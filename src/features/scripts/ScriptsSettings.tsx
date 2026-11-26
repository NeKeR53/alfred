/**
 * Rubrique « Scripts de l’agent » des Réglages : ce que l’agent a exécuté en Code Mode (`alfred run`), gardé sept
 * jours, et les scripts gardés comme fonctions. Sections : les scripts gardés (à valider, acceptés : Accepter,
 * Relancer, Créer une automatisation, Retirer), puis les exécutions (date, conversation, appels, réussite, durée ;
 * Voir le détail, Ouvrir la conversation, Garder…). Le détail et « Garder » s’ouvrent en modale. Gardé ici, un
 * script est accepté aussitôt : c’est l’utilisateur qui le garde.
 */
import { Check, FileCode, Play, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type Action,
  Alert,
  Button,
  Checkbox,
  Code,
  Fieldset,
  type ItemSetting,
  Modal,
  Select,
  type SettingsSection,
  TextArea,
  TextInput,
} from "socle-ui";
import { Stack, Text } from "../../kit";
import { AlfredError, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { AutomationForm, when } from "../automations/AutomationsSettings";
import { openConversation } from "../automations/agentRuns";
import { type AutomationsList, type ConversationChoice, listAutomations, listConversations } from "../automations/api";
import { errorMessage } from "../vault/api";
import {
  acceptKept,
  callsLabel,
  duration,
  type KeptScript,
  keepRun,
  listScripts,
  loadRun,
  removeKept,
  runKept,
  type ScriptLiteral,
  type ScriptRun,
  type ScriptRunDetail,
  type ScriptsList,
  shortJson,
  suggestedName,
  VALID_NAME,
  VALID_PARAM,
} from "./api";

const pretty = (value: unknown) => (value === undefined ? "(aucune)" : JSON.stringify(value, null, 2));

function Block({ title, children }: { title: string; children: string }) {
  return (
    <Stack gap="xs">
      <Text weight="medium">{title}</Text>
      <Code block label={title}>
        {children}
      </Code>
    </Stack>
  );
}

/** Détail d’une exécution : code, entrée, sortie (ou erreur). */
function RunDetail({
  detail,
  conversation,
  onKeep,
  onClose,
}: {
  detail: ScriptRunDetail;
  conversation: string;
  onKeep: () => void;
  onClose: () => void;
}) {
  const output = detail.output as { result?: unknown; error?: string; detail?: unknown; logs?: string[] } | null;
  return (
    <Modal
      isOpen
      size="lg"
      title={`Exécution du ${when(detail.at)}`}
      description={[conversation, duration(detail.ms), detail.ok ? "réussie" : "échec"].filter(Boolean).join(" · ")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose}>Fermer</Button>
          {detail.ok ? (
            <Button variant="primary" onPress={onKeep}>
              Garder…
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="md">
        <Text tone="muted">Appels : {callsLabel(detail.calls)}</Text>
        <Block title="Code">{detail.code}</Block>
        <Block title="Entrée">{pretty(detail.input)}</Block>
        {detail.ok ? (
          <Block title="Sortie">{pretty(output?.result)}</Block>
        ) : (
          <Block title="Erreur">
            {[output?.error ?? "Échec", output?.detail ? pretty(output.detail) : ""].filter(Boolean).join("\n\n")}
          </Block>
        )}
        {output?.logs && output.logs.length > 0 ? (
          <Block title="Journal du script">{output.logs.join("\n")}</Block>
        ) : null}
      </Stack>
    </Modal>
  );
}

/** « Garder » : nom, description, module d’accueil. La fonction est créée et acceptée. */
function KeepForm({ detail, onClose }: { detail: ScriptRunDetail; onClose: (kept?: string) => void }) {
  const [name, setName] = useState(() => suggestedName(detail.calls));
  const [description, setDescription] = useState("");
  const [module, setModule] = useState<string | null>(detail.home);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; close?: string }>();
  // Valeurs en dur cochées : elles deviennent des paramètres (nom, description ; la valeur devient le défaut).
  const [chosen, setChosen] = useState<Record<number, { id: string; description: string }>>({});
  const nameError = name && !VALID_NAME.test(name) ? "Minuscules, chiffres et tirets, sans espace." : undefined;
  const paramError = (literal: ScriptLiteral) => {
    const param = chosen[literal.start];
    if (!param) return {};
    const ids = Object.values(chosen).map((entry) => entry.id);
    return {
      id: !VALID_PARAM.test(param.id)
        ? "Lettres, chiffres et _, sans espace ni tiret."
        : ids.filter((id) => id === param.id).length > 1
          ? "Deux paramètres ont ce nom."
          : undefined,
      description: param.description.trim() ? undefined : "Dites ce que ce paramètre choisit.",
    };
  };
  const paramsInvalid = detail.literals.some((literal) => {
    const errors = paramError(literal);
    return Boolean(errors.id || errors.description);
  });

  const submit = async (separate = false) => {
    if (!module || !name || nameError || paramsInvalid) return;
    setBusy(true);
    setError(undefined);
    try {
      const params = detail.literals
        .filter((literal) => chosen[literal.start])
        .map((literal) => ({
          id: chosen[literal.start]?.id ?? literal.key,
          description: chosen[literal.start]?.description.trim() ?? "",
          default: literal.value,
          at: literal.start,
        }));
      const kept = await keepRun({
        id: detail.id,
        module,
        name,
        description: description.trim() || undefined,
        params,
        ...(separate ? { new: true } : {}),
      });
      notify({
        title: `Fonction « ${kept.function} » ${kept.updated ? "mise à jour" : "gardée"}`,
        description: "Elle est acceptée : une page ou une automatisation peut l’appeler.",
        tone: "success",
      });
      onClose(kept.function);
    } catch (failure) {
      const detailOf = failure instanceof AlfredError ? (failure.detail as { close?: string } | undefined) : undefined;
      setError({ message: errorMessage(failure), close: detailOf?.close });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      size="md"
      title="Garder ce script"
      description="Il devient une fonction du module choisi. Vous la gardez vous-même : elle est acceptée aussitôt."
      isBusy={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button isDisabled={busy} onPress={() => onClose()}>
            Annuler
          </Button>
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={!name || !!nameError || !module || paramsInvalid}
            onPress={() => void submit()}
          >
            Garder
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {error ? (
          <Alert
            tone="danger"
            announce
            action={error.close ? { label: "Garder à part quand même", onPress: () => void submit(true) } : undefined}
          >
            {error.message}
          </Alert>
        ) : null}
        <TextInput
          label="Nom de la fonction"
          isRequired
          autoFocus
          value={name}
          onChange={setName}
          error={nameError}
          description="Minuscules, chiffres et tirets : total-des-ventes."
        />
        <TextArea
          label="Description"
          value={description}
          onChange={setDescription}
          minRows={2}
          description="Ce qu’elle fait, en une phrase. Sans description, Alfred en écrit une d’après ses appels."
        />
        <Select
          label="Module"
          isRequired
          value={module}
          onChange={setModule}
          options={detail.modules.map((option) => ({
            id: option.id,
            label: option.id === detail.home ? `${option.name} (proposé)` : option.name,
          }))}
          description="Proposé : le module de la plupart de ses appels, sinon Mes scripts."
        />
        {detail.literals.length > 0 ? (
          <Fieldset
            legend="Valeurs en dur"
            isOptional
            description="Cochez celles qui changeront d’un appel à l’autre : elles deviennent des paramètres, avec cette valeur par défaut."
          >
            {detail.literals.map((literal) => {
              const param = chosen[literal.start];
              const errors = paramError(literal);
              return (
                <Stack gap="sm" key={literal.start}>
                  <Checkbox
                    isSelected={Boolean(param)}
                    description={`Passée à ${literal.function}, champ ${literal.key}.`}
                    onChange={(selected) =>
                      setChosen((current) => {
                        const next = { ...current };
                        if (selected) next[literal.start] = { id: literal.key, description: "" };
                        else delete next[literal.start];
                        return next;
                      })
                    }
                  >
                    {`${literal.key} = ${JSON.stringify(literal.value)}`}
                  </Checkbox>
                  {param ? (
                    <>
                      <TextInput
                        label={`Nom du paramètre (${literal.key})`}
                        isRequired
                        value={param.id}
                        error={errors.id}
                        onChange={(id) => setChosen((current) => ({ ...current, [literal.start]: { ...param, id } }))}
                      />
                      <TextInput
                        label={`Description du paramètre (${literal.key})`}
                        isRequired
                        value={param.description}
                        error={errors.description}
                        placeholder="Équipe suivie"
                        onChange={(text) =>
                          setChosen((current) => ({ ...current, [literal.start]: { ...param, description: text } }))
                        }
                      />
                    </>
                  ) : null}
                </Stack>
              );
            })}
          </Fieldset>
        ) : null}
      </Stack>
    </Modal>
  );
}

/** Ligne d’une exécution gardée. */
export function runRow(
  run: ScriptRun,
  conversationTitle: string | undefined,
  actions: { open: () => void; conversation: () => void; keep: () => void },
): ItemSetting {
  const parts = [when(run.at), conversationTitle ? `conversation « ${conversationTitle} »` : "conversation supprimée"];
  const took = duration(run.ms);
  if (took) parts.push(took);
  return {
    type: "item",
    id: run.id,
    label: callsLabel(run.calls),
    description: parts.join(" · "),
    tags: [run.ok ? { label: "Réussie", tone: "success" } : { label: "Échec", tone: "danger" }],
    actions: [
      { id: "detail", label: "Voir le détail", icon: <FileCode size={16} aria-hidden="true" />, onPress: actions.open },
      {
        id: "conversation",
        label: "Ouvrir la conversation",
        isHidden: !conversationTitle,
        onPress: actions.conversation,
      },
      { id: "keep", label: "Garder…", isHidden: !run.ok, onPress: actions.keep },
    ],
  };
}

export function useScriptsSections(): SettingsSection[] {
  const [data, setData] = useState<ScriptsList>();
  const [error, setError] = useState<string>();
  const [conversations, setConversations] = useState<Map<string, ConversationChoice>>(new Map());
  const [open, setOpen] = useState<{ detail: ScriptRunDetail; keeping: boolean }>();
  const [automation, setAutomation] = useState<{ script: KeptScript; list: AutomationsList }>();

  const load = useCallback(async () => {
    try {
      const [list, known] = await Promise.all([listScripts(), listConversations().catch(() => [])]);
      setData(list);
      setConversations(new Map(known.map((conversation) => [conversation.id, conversation])));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
    const stops = ["space:changed", "journal:changed"].map((name) => onNativeEvent(name, () => void load()));
    return () => {
      for (const stop of stops) stop();
    };
  }, [load]);

  const act = async (work: () => Promise<unknown>, failed: string) => {
    try {
      await work();
    } catch (failure) {
      notify({ title: failed, description: errorMessage(failure), tone: "error" });
    } finally {
      void load();
    }
  };

  const openRun = async (run: ScriptRun, keeping: boolean) => {
    try {
      setOpen({ detail: await loadRun(run.id), keeping });
    } catch (failure) {
      notify({ title: "L’exécution n’a pas pu être lue", description: errorMessage(failure), tone: "error" });
      void load();
    }
  };

  const rerun = async (script: KeptScript) => {
    try {
      const output = await runKept(script.reference, script.input);
      notify({ title: `${script.reference} : exécution réussie`, description: shortJson(output), tone: "success" });
    } catch (failure) {
      notify({
        title: `${script.reference} : l’exécution a échoué`,
        description: errorMessage(failure),
        tone: "error",
      });
    }
  };

  const newAutomation = async (script: KeptScript) => {
    try {
      setAutomation({ script, list: await listAutomations() });
    } catch (failure) {
      notify({ title: "Le formulaire n’a pas pu s’ouvrir", description: errorMessage(failure), tone: "error" });
    }
  };

  const titleOf = (id: string) => conversations.get(id)?.title;

  const keptActions = (script: KeptScript): Action[] => {
    const waiting = script.status === "toValidate";
    return [
      {
        id: "accept",
        label: "Accepter",
        icon: <Check size={16} aria-hidden="true" />,
        isHidden: !waiting,
        confirm: {
          title: `Accepter « ${script.reference} » ?`,
          message: `${script.effect === "write" ? "Elle écrit chez un service. " : ""}Une page ou une automatisation pourra la lancer sans vous demander, dans son état actuel. Une modification la remettra à valider.`,
          confirmLabel: "Accepter",
        },
        onPress: () => act(() => acceptKept(script.reference), "Le script n’a pas été accepté"),
      },
      {
        id: "run",
        label: `Relancer ${script.reference}`,
        icon: <Play size={16} aria-hidden="true" />,
        isHidden: waiting,
        onPress: () => rerun(script),
      },
      {
        id: "automation",
        label: "Créer une automatisation",
        icon: <Workflow size={16} aria-hidden="true" />,
        disabledReason: waiting ? "Acceptez-la d’abord." : undefined,
        onPress: () => newAutomation(script),
      },
      {
        id: "conversation",
        label: "Ouvrir la conversation d’origine",
        isHidden: !titleOf(script.conversation),
        onPress: () => openConversation(script.conversation),
      },
      {
        id: "remove",
        label: "Retirer",
        danger: true,
        confirm: {
          title: `Retirer « ${script.reference} » ?`,
          message:
            "La fonction et son fichier sont supprimés du module. Une page ou une automatisation qui l’appelle échouera.",
          confirmLabel: "Retirer",
        },
        onPress: () => act(() => removeKept(script.reference), "Le script n’a pas été retiré"),
      },
    ];
  };

  const keptRow = (script: KeptScript): ItemSetting => ({
    type: "item",
    id: script.reference,
    label: script.reference,
    description: [
      script.description,
      `${script.moduleName}`,
      `gardé ${when(script.createdAt)}`,
      script.status === "toValidate" ? "ne tourne qu’après votre accord" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    tags: [
      script.status === "toValidate" ? { label: "À valider", tone: "warning" } : { label: "Acceptée", tone: "success" },
      ...(script.effect === "write" ? [{ label: "Écriture", tone: "neutral" as const }] : []),
    ],
    actions: keptActions(script),
  });

  const loading = data === undefined && !error;
  const days = data?.keepDays ?? 7;

  return [
    {
      id: "kept",
      title: "Scripts gardés",
      description:
        "Des exécutions devenues des fonctions. Gardées par l’agent, elles attendent votre accord avant de tourner.",
      emptyMessage: error
        ? `Les scripts n’ont pas pu être lus. ${error}`
        : loading
          ? "Chargement des scripts…"
          : "Aucun script gardé. Gardez une exécution réussie, ci-dessous, ou demandez-le à l’agent.",
      settings: (data?.kept ?? []).map(keptRow),
      content: automation ? (
        <AutomationForm
          preset={{
            name: automation.script.description || automation.script.reference,
            steps: [{ function: automation.script.reference, input: automation.script.input }],
          }}
          functions={automation.list.functions}
          maxMinutes={automation.list.maxAgentMinutes ?? 120}
          onScriptCreated={() => undefined}
          onClose={() => setAutomation(undefined)}
        />
      ) : undefined,
    },
    {
      id: "runs",
      title: "Exécutions",
      description: `Ce que l’agent a lancé avec alfred run, gardé ${days} jours : les 100 dernières, la plus récente d’abord.`,
      emptyMessage: error
        ? `Les exécutions n’ont pas pu être lues. ${error}`
        : loading
          ? "Chargement des exécutions…"
          : `Aucune exécution ces ${days} derniers jours.`,
      settings: (data?.runs ?? []).map((run) =>
        runRow(run, titleOf(run.conversation), {
          open: () => void openRun(run, false),
          conversation: () => void openConversation(run.conversation),
          keep: () => void openRun(run, true),
        }),
      ),
      content: open ? (
        open.keeping ? (
          <KeepForm
            detail={open.detail}
            onClose={() => {
              setOpen(undefined);
              void load();
            }}
          />
        ) : (
          <RunDetail
            detail={open.detail}
            conversation={
              titleOf(open.detail.conversation)
                ? `conversation « ${titleOf(open.detail.conversation)} »`
                : "conversation supprimée"
            }
            onKeep={() => setOpen({ detail: open.detail, keeping: true })}
            onClose={() => setOpen(undefined)}
          />
        )
      ) : undefined,
    },
  ];
}
