/**
 * Rubrique « Automatisations » des Réglages : les fonctions que l’utilisateur fait exécuter sans les lancer
 * lui-même, par un planning cron, un appel HTTP local ou un script (voir docs/automatisations.md). Deux sections :
 * la liste (une ligne par automatisation : déclencheur, fonction, dernier et prochain passage, état en étiquette ;
 * ses actions dans la ligne) et l’historique des passages, lu au Journal. Le formulaire de création et de
 * modification s’ouvre en modale.
 */
import { Check, Play, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Action,
  Alert,
  Button,
  Checkbox,
  LogViewer,
  Modal,
  RadioButtonGroup,
  Select,
  type SettingsSection,
  TextArea,
  TextInput,
} from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { type JournalEntry, journalLines } from "../journal/JournalSettings";
import { errorMessage } from "../vault/api";
import {
  type AutomationDraft,
  type AutomationFunction,
  type AutomationItem,
  type AutomationsList,
  type AutomationTrigger,
  automationSecret,
  curlCommand,
  listAutomations,
  removeAutomation,
  rotateAutomationSecret,
  runAutomationNow,
  saveAutomation,
  setAutomationEnabled,
  triggerLabel,
  validateAutomation,
} from "./api";

const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });

/** « 14:42 » aujourd’hui, « mer. 26 nov., 08:00 » un autre jour. */
export function when(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? time.format(date)
    : `${day.format(date)}, ${time.format(date)}`;
}

/** Étiquettes de la ligne : l’état, puis l’échec du dernier passage. */
export function tagsOf(
  item: AutomationItem,
): Array<{ label: string; tone: "success" | "warning" | "danger" | "neutral" }> {
  const tags: Array<{ label: string; tone: "success" | "warning" | "danger" | "neutral" }> = [];
  if (item.status === "invalid") tags.push({ label: "À corriger", tone: "danger" });
  else if (item.status === "toValidate") tags.push({ label: "À valider", tone: "warning" });
  else if (item.status === "paused") tags.push({ label: "En pause", tone: "neutral" });
  else tags.push({ label: "Active", tone: "success" });
  if (item.lastStatus === "error" && item.status !== "invalid") tags.push({ label: "Échec", tone: "danger" });
  return tags;
}

/** Description de la ligne : déclencheur, fonction, dernier passage, prochain passage ou problème. */
export function describe(item: AutomationItem): string {
  const parts = [triggerLabel(item.trigger), `fonction ${item.function}`];
  if (item.problem) parts.push(item.problem);
  if (item.running || item.lastStatus === "running") parts.push("en cours");
  else if (item.lastRunAt) parts.push(`${item.lastStatus === "error" ? "échec" : "réussie"} ${when(item.lastRunAt)}`);
  else parts.push("jamais lancée");
  if (item.nextRunAt) parts.push(`prochain passage ${when(item.nextRunAt)}`);
  if (item.status === "toValidate")
    parts.push(item.createdBy === "agent" ? "créée par l’agent" : "modifiée depuis l’accord");
  return parts.join(" · ");
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify({ title: done, tone: "success" });
  } catch (failure) {
    notify({ title: "La copie a échoué", description: errorMessage(failure), tone: "error" });
  }
}

const NONE = "__aucun__";

/** Formulaire de création ou de modification, en modale. */
function AutomationForm({
  initial,
  functions,
  onClose,
}: {
  initial?: AutomationItem;
  functions: AutomationFunction[];
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [reference, setReference] = useState<string | null>(initial?.function ?? null);
  const [instance, setInstance] = useState<string>(initial?.instance ?? NONE);
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(initial?.trigger.kind ?? "cron");
  const [cron, setCron] = useState(initial?.trigger.kind === "cron" ? initial.trigger.cron : "0 8 * * 1-5");
  const [input, setInput] = useState(initial ? JSON.stringify(initial.input, null, 2) : "{}");
  const [enabled, setEnabled] = useState(initial ? initial.enabled || initial.status === "toValidate" : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const sections = useMemo(() => {
    const byModule = new Map<string, { title: string; options: Array<{ id: string; label: string }> }>();
    for (const fn of functions) {
      const section = byModule.get(fn.module) ?? { title: fn.moduleName, options: [] };
      section.options.push({ id: fn.reference, label: fn.description ? `${fn.id} — ${fn.description}` : fn.id });
      byModule.set(fn.module, section);
    }
    return [...byModule.values()];
  }, [functions]);
  const chosen = functions.find((fn) => fn.reference === reference);
  const accounts = chosen?.instances ?? [];

  const parsed = useMemo((): { value?: Record<string, unknown>; error?: string } => {
    try {
      const value: unknown = JSON.parse(input.trim() || "{}");
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return { error: 'L’entrée doit être un objet JSON, par exemple {} ou { "projet": "ACME" }.' };
      if ("event" in value)
        return { error: "La clé « event » est réservée : elle reçoit ce qu’apporte le déclencheur." };
      return { value: value as Record<string, unknown> };
    } catch {
      return { error: "JSON illisible : vérifiez les guillemets et les virgules." };
    }
  }, [input]);

  const submit = async () => {
    if (!reference || !name.trim() || !parsed.value) return;
    const trigger: AutomationTrigger = kind === "cron" ? { kind, cron: cron.trim() } : { kind };
    const draft: AutomationDraft = {
      ...(initial ? { id: initial.id } : {}),
      name: name.trim(),
      function: reference,
      input: parsed.value,
      instance: instance === NONE ? null : instance,
      trigger,
      enabled,
    };
    setBusy(true);
    setError(undefined);
    try {
      await saveAutomation(draft);
      notify({ title: initial ? "Automatisation modifiée" : "Automatisation créée", tone: "success" });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      size="md"
      title={initial ? `Modifier « ${initial.name} »` : "Nouvelle automatisation"}
      description="Une fonction d’un module, lancée sans vous, tant qu’Alfred est ouvert."
      isBusy={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button isDisabled={busy} onPress={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={!name.trim() || !reference || !!parsed.error || (kind === "cron" && !cron.trim())}
            onPress={() => void submit()}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" announce>
          {error}
        </Alert>
      ) : null}
      <TextInput label="Nom" isRequired autoFocus value={name} onChange={setName} placeholder="Relance des impayés" />
      <Select
        label="Fonction"
        isRequired
        options={sections}
        value={reference}
        onChange={(id) => {
          setReference(id);
          setInstance(NONE);
        }}
        description={functions.length === 0 ? "Aucune fonction dans l’espace : demandez-en une à l’agent." : undefined}
      />
      {accounts.length > 0 ? (
        <Select
          label="Compte"
          description="Passé à la fonction dans input.instance."
          options={[
            { id: NONE, label: "Aucun (compte par défaut)" },
            ...accounts.map((a) => ({ id: a.id, label: a.label })),
          ]}
          value={instance}
          onChange={(id) => setInstance(id ?? NONE)}
        />
      ) : null}
      <RadioButtonGroup
        label="Déclencheur"
        isRequired
        value={kind}
        onChange={(value) => setKind((value ?? "cron") as AutomationTrigger["kind"])}
      >
        <RadioButtonGroup.Option value="cron" description="À heures fixes, en heure locale.">
          Planning
        </RadioButtonGroup.Option>
        <RadioButtonGroup.Option
          value="webhook"
          description="Un service (webhook) ou un autre programme appelle son adresse locale, avec son secret."
        >
          Appel HTTP local
        </RadioButtonGroup.Option>
        <RadioButtonGroup.Option
          value="script"
          description="Une page, une fonction ou un script de l’espace la lance par automations.trigger."
        >
          Script
        </RadioButtonGroup.Option>
      </RadioButtonGroup>
      {kind === "cron" ? (
        <TextInput
          label="Planning (cron)"
          isRequired
          value={cron}
          onChange={setCron}
          placeholder="0 8 * * 1-5"
          description="Minute, heure, jour, mois, jour de la semaine. 0 8 * * 1-5 : à 8 h du lundi au vendredi. */15 * * * * : tous les quarts d’heure."
        />
      ) : null}
      <TextArea
        label="Entrée (JSON)"
        value={input}
        onChange={setInput}
        minRows={3}
        error={parsed.error}
        description="Objet passé à la fonction."
      />
      <Checkbox
        isSelected={enabled}
        onChange={setEnabled}
        description="Sinon, elle attend en pause : vous l’activez depuis sa ligne."
      >
        Active dès l’enregistrement
      </Checkbox>
    </Modal>
  );
}

/**
 * Sections de la rubrique : la liste des automatisations, puis l’historique de leurs passages.
 */
export function useAutomationsSections(): SettingsSection[] {
  const [data, setData] = useState<AutomationsList>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<AutomationItem | "new">();
  const [historyOf, setHistoryOf] = useState<string>("all");
  const [entries, setEntries] = useState<JournalEntry[]>();

  const load = useCallback(async () => {
    try {
      setData(await listAutomations());
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);
  const loadHistory = useCallback(async (id: string) => {
    try {
      setEntries(
        await invoke<JournalEntry[]>("automations.history", id === "all" ? { limit: 200 } : { id, limit: 200 }),
      );
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const stops = ["automations:changed", "journal:changed", "space:changed"].map((name) =>
      onNativeEvent(name, () => void load()),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [load]);
  useEffect(() => {
    void loadHistory(historyOf);
    return onNativeEvent("journal:changed", () => void loadHistory(historyOf));
  }, [historyOf, loadHistory]);

  const act = async (work: () => Promise<unknown>, failed: string) => {
    try {
      await work();
    } catch (failure) {
      notify({ title: failed, description: errorMessage(failure), tone: "error" });
    } finally {
      void load();
    }
  };

  const runNow = async (item: AutomationItem) => {
    try {
      const result = await runAutomationNow(item.id);
      notify(
        result.ok
          ? { title: `${item.name} : passage réussi`, tone: "success" }
          : { title: `${item.name} : le passage a échoué`, description: result.error, tone: "error" },
      );
    } catch (failure) {
      notify({ title: `${item.name} : le passage n’a pas démarré`, description: errorMessage(failure), tone: "error" });
    } finally {
      void load();
    }
  };

  const actionsOf = (item: AutomationItem): Action[] => {
    const webhook = item.trigger.kind === "webhook";
    const waiting = item.status === "toValidate";
    return [
      {
        id: "validate",
        label: "Valider et activer",
        icon: <Check size={16} aria-hidden="true" />,
        isHidden: !waiting,
        confirm: {
          title: `Valider « ${item.name} » ?`,
          message: `Elle lancera ${item.function} (${triggerLabel(item.trigger)}) avec l’entrée ${JSON.stringify(item.input)}${item.instance ? `, compte ${item.instance}` : ""}, sans vous demander.`,
          confirmLabel: "Valider et activer",
        },
        onPress: () => act(() => validateAutomation(item.id), "L’automatisation n’a pas été validée"),
      },
      {
        id: "run",
        label: `Exécuter maintenant ${item.name}`,
        icon: <Play size={16} aria-hidden="true" />,
        onPress: () => runNow(item),
        isHidden: waiting,
        disabledReason:
          item.status === "invalid" ? "Corrigez-la d’abord." : item.running ? "Un passage est en cours." : undefined,
      },
      {
        id: "toggle",
        label: item.enabled ? "Mettre en pause" : "Activer",
        isHidden: waiting || item.status === "invalid",
        onPress: () =>
          act(
            () => setAutomationEnabled(item.id, !item.enabled),
            item.enabled ? "L’automatisation n’a pas été mise en pause" : "L’automatisation n’a pas été activée",
          ),
      },
      { id: "edit", label: "Modifier", onPress: () => setEditing(item) },
      {
        id: "copy-url",
        label: "Copier l’adresse",
        isHidden: !webhook,
        onPress: () => copy(item.url ?? "", "Adresse copiée"),
      },
      {
        id: "copy-curl",
        label: "Copier la commande curl",
        isHidden: !webhook,
        onPress: async () => {
          const { secret, url } = await automationSecret(item.id);
          await copy(curlCommand(url ?? item.url ?? "", secret), "Commande copiée");
        },
      },
      {
        id: "copy-secret",
        label: "Copier le secret",
        isHidden: !webhook,
        onPress: async () => copy((await automationSecret(item.id)).secret, "Secret copié"),
      },
      {
        id: "rotate",
        label: "Régénérer le secret",
        isHidden: !webhook,
        confirm: {
          title: `Régénérer le secret de « ${item.name} » ?`,
          message: "L’ancien secret cesse aussitôt de valoir : l’appelant sera refusé tant qu’il n’a pas le nouveau.",
          confirmLabel: "Régénérer",
        },
        onPress: () =>
          act(async () => {
            await rotateAutomationSecret(item.id);
            notify({ title: "Secret régénéré", description: "Copiez-le chez l’appelant.", tone: "success" });
          }, "Le secret n’a pas été régénéré"),
      },
      {
        id: "remove",
        label: "Supprimer",
        danger: true,
        confirm: {
          title: `Supprimer « ${item.name} » ?`,
          message: "Elle ne partira plus. Son historique reste au Journal.",
          confirmLabel: "Supprimer",
        },
        onPress: () => act(() => removeAutomation(item.id), "L’automatisation n’a pas été supprimée"),
      },
    ];
  };

  const items = data?.automations ?? [];
  const pending = items.filter((item) => item.status === "toValidate");
  const others = items.filter((item) => item.status !== "toValidate");
  const row = (item: AutomationItem) => ({
    type: "item" as const,
    id: item.id,
    label: item.name,
    description: describe(item),
    tags: tagsOf(item),
    actions: actionsOf(item),
  });
  const historyOptions = [{ id: "all", label: "Toutes" }, ...items.map((item) => ({ id: item.id, label: item.name }))];

  const pendingSection: SettingsSection[] =
    pending.length > 0
      ? [
          {
            id: "pending",
            title: "À valider",
            description:
              "Préparées par l’agent, ou modifiées depuis votre accord : elles ne partent qu’après votre validation.",
            settings: pending.map(row),
          },
        ]
      : [];

  return [
    ...pendingSection,
    {
      id: "automations",
      title: "Automatisations",
      description:
        "Des fonctions lancées sans vous, tant qu’Alfred est ouvert sur cet espace. Rien ne part Alfred fermé, et un passage manqué n’est pas rattrapé.",
      actions: [
        {
          id: "new",
          label: "Nouvelle automatisation",
          icon: <Plus size={16} aria-hidden="true" />,
          primary: true,
          onPress: () => setEditing("new"),
        },
      ],
      emptyMessage: error
        ? `Les automatisations n’ont pas pu être lues. ${error}`
        : data
          ? pending.length > 0
            ? "Aucune autre automatisation."
            : "Aucune automatisation. Créez-en une, ou demandez-la à l’agent : vous la validerez ici."
          : "Chargement des automatisations…",
      settings: others.map(row),
      content: editing ? (
        <AutomationForm
          initial={editing === "new" ? undefined : editing}
          functions={data?.functions ?? []}
          onClose={() => {
            setEditing(undefined);
            void load();
          }}
        />
      ) : undefined,
    },
    {
      id: "history",
      title: "Historique",
      description: "Chaque passage : déclencheur, durée, réussite ou échec, sortie. Les refus aussi.",
      settings: [
        {
          type: "select" as const,
          id: "history-of",
          label: "Automatisation affichée",
          value: historyOf,
          options: historyOptions,
          onChange: (id: string) => setHistoryOf(id),
        },
      ],
      content: (
        <LogViewer
          label="Passages des automatisations"
          lines={entries ? journalLines(entries) : []}
          loading={entries === undefined}
          levels
          wrap
        />
      ),
    },
  ];
}
