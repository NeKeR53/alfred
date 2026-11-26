/**
 * Palette de commandes : Cmd+K (macOS) ou Ctrl+K l’ouvre et la ferme. Elle mène à chaque page et onglet, lance les
 * fonctions de l’espace, ouvre les conversations avec l’agent et bascule le thème. La liste se recalcule à chaque
 * ouverture : une page créée par l’agent y apparaît d’elle-même. Faite d’un `Dialog` et d’un `ComboBox` de Socle :
 * on tape, les flèches parcourent les résultats, Entrée lance.
 */
import { Bot, MessageSquare, MessageSquarePlus, Moon, Play, Settings, Sun } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button, ComboBox, type ComboBoxItem, Modal, TextArea, useSocle } from "socle-ui";
import { create } from "zustand";
import { Row, Stack, Text } from "../../kit";
import { invoke } from "../../lib/native";
import type { ResolvedFunction } from "../../lib/types";
import { NamedIcon, SectionIcon } from "../../shell/icons";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { conversationLabel, delegateRole } from "../agent/conversationTree";
import { useAgents } from "../agent/store";
import { openSettings, settingsTabs } from "../settings/tabs";

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

/** Minuscules sans accents : « Réglages » se trouve en tapant « regl ». */
export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const isMac = () => {
  const platform = useShell.getState().info?.platform;
  if (platform) return platform === "macos";
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
};

type Schema = { type?: string; required?: unknown; properties?: Record<string, Schema>; default?: unknown } | null;

const requiredInputs = (schema: unknown): string[] => {
  const required = (schema as Schema)?.required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
};

function sample(schema: Schema | undefined): unknown {
  if (schema?.default !== undefined) return schema.default;
  switch (schema?.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

/** Entrée à compléter : les champs requis, avec une valeur vide de leur type. */
function template(schema: unknown): string {
  const properties = (schema as Schema)?.properties ?? {};
  const input = Object.fromEntries(requiredInputs(schema).map((key) => [key, sample(properties[key])]));
  return JSON.stringify(input, null, 2);
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "Aucun résultat renvoyé.";
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 1);
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

async function runFunction(fn: ResolvedFunction, input: unknown) {
  try {
    const result = await invoke("functions.call", { function: fn.reference, input });
    notify({
      tone: "success",
      title: `Fonction ${fn.reference} terminée`,
      description: summarize(result),
      source: "Palette de commandes",
    });
  } catch (error) {
    notify({
      tone: "error",
      title: `La fonction ${fn.reference} a échoué`,
      description: error instanceof Error ? error.message : String(error),
      source: "Palette de commandes",
    });
  }
}

/** Une entrée de la palette : son libellé, sa rubrique, et ce qu’elle fait. */
interface Entry extends ComboBoxItem {
  run: () => void;
}

/** Entrée JSON d’une fonction qui a des champs requis, puis « Lancer ». */
function FunctionInput({
  fn,
  onBack,
  onRun,
}: {
  fn: ResolvedFunction;
  onBack: () => void;
  onRun: (input: unknown) => void;
}) {
  const formId = useId();
  const [text, setText] = useState(() => template(fn.input));
  const [error, setError] = useState<string>();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    try {
      onRun(JSON.parse(text));
    } catch {
      setError("JSON invalide : vérifier les guillemets, virgules et accolades.");
    }
  };
  return (
    <form id={formId} noValidate onSubmit={submit}>
      <Stack gap="md">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Mod+Entrée lance la fonction depuis le champ. */}
        <div
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        >
          <TextArea
            label={`Entrée de ${fn.reference}`}
            isRequired
            description={`${fn.description ? `${fn.description} ` : ""}Champs requis : ${requiredInputs(fn.input).join(", ")}. Ctrl+Entrée pour lancer.`}
            value={text}
            minRows={8}
            error={error}
            onChange={(value) => {
              setText(value);
              setError(undefined);
            }}
          />
        </div>
        <Row justify="end">
          <Button onPress={onBack}>Retour</Button>
          <Button variant="primary" type="submit" form={formId}>
            Lancer
          </Button>
        </Row>
      </Stack>
    </form>
  );
}

export function CommandPalette() {
  const open = usePalette((state) => state.open);
  const setOpen = usePalette((state) => state.setOpen);
  const snapshot = useShell((state) => state.snapshot);
  const theme = useShell((state) => state.theme);
  const headers = useAgents((state) => state.headers);
  const socle = useSocle();
  const [inputFor, setInputFor] = useState<ResolvedFunction>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return;
      if (!(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      usePalette.getState().toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const close = () => {
    setOpen(false);
    setInputFor(undefined);
  };
  /** Ferme la palette puis lance l’action. */
  const run = (action: () => void) => () => {
    close();
    action();
  };

  const shell = useShell.getState;
  const sections = (snapshot?.sections ?? []).filter((section) => !section.hidden);
  const settingsPages = (snapshot?.settingsPages ?? []).filter((page) => !page.hidden);
  const functions = (snapshot?.functions ?? []).filter((fn) => !fn.missing);
  const conversations = headers
    .filter((header) => header.started && !header.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12);

  const call = (fn: ResolvedFunction) => {
    if (requiredInputs(fn.input).length > 0) {
      setInputFor(fn);
      return;
    }
    run(() => void runFunction(fn, {}))();
  };

  const icon16 = (Icon: typeof Bot) => <Icon size={16} aria-hidden="true" />;
  const nextTheme = theme === "dark" ? "light" : "dark";
  const entries: Entry[] = open
    ? [
        {
          id: "aller:agent",
          label: "Agent",
          section: "Aller à",
          icon: icon16(Bot),
          run: run(() => shell().setView({ kind: "agent" })),
        },
        ...sections.map((section) => ({
          id: `aller:section:${section.id}`,
          label: section.label,
          description: "Section",
          section: "Aller à",
          icon: <SectionIcon section={section} size={16} />,
          run: run(() => shell().setView({ kind: "section", id: section.id })),
        })),
        ...sections.flatMap((section) =>
          section.pages
            .filter((page) => !page.hidden)
            .map((page) => ({
              id: `aller:page:${page.reference}`,
              label: page.title,
              description: section.label,
              section: "Aller à",
              icon: page.icon ? <NamedIcon name={page.icon} size={16} /> : <SectionIcon section={section} size={16} />,
              run: run(() => shell().openPage(page.reference)),
            })),
        ),
        ...settingsTabs.map((tab) => ({
          id: `aller:réglages:${tab.id}`,
          label: `Réglages › ${tab.label}`,
          section: "Aller à",
          icon: icon16(Settings),
          run: run(() => openSettings(tab.id)),
        })),
        ...settingsPages.map((page) => ({
          id: `aller:page:${page.reference}`,
          label: `Réglages › ${page.title}`,
          section: "Aller à",
          icon: <NamedIcon name={page.icon} size={16} />,
          run: run(() => shell().openPage(page.reference)),
        })),
        ...functions.map((fn) => ({
          id: `fonction:${fn.reference}`,
          label: fn.reference,
          description: requiredInputs(fn.input).length > 0 ? "Entrée requise" : fn.description || undefined,
          section: "Lancer une fonction",
          icon: icon16(Play),
          run: () => call(fn),
        })),
        {
          id: "agent:nouvelle",
          label: "Nouvelle conversation",
          section: "Agent",
          icon: icon16(MessageSquarePlus),
          run: run(() => {
            const agents = useAgents.getState();
            const conversation = agents.create();
            void agents.open(conversation.id);
            shell().setView({ kind: "agent" });
          }),
        },
        ...conversations.map((conversation) => ({
          id: `agent:conversation:${conversation.id}`,
          // Un délégué se cherche par sa tâche (« ventes ») ; la précision dit de qui il est le délégué.
          label: conversationLabel(conversation),
          description: delegateRole(conversation, headers) ?? "Conversation",
          section: "Agent",
          icon: icon16(MessageSquare),
          run: run(() => {
            void useAgents.getState().open(conversation.id);
            shell().setView({ kind: "agent" });
          }),
        })),
        {
          id: "apparence:theme",
          label: theme === "dark" ? "Passer au thème clair" : "Passer au thème sombre",
          section: "Apparence",
          icon: theme === "dark" ? icon16(Sun) : icon16(Moon),
          run: run(() => {
            shell().setTheme(nextTheme);
            socle.setColorScheme(nextTheme);
          }),
        },
      ]
    : [];

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={inputFor ? `Lancer ${inputFor.reference}` : "Palette de commandes"}
      description={
        inputFor
          ? undefined
          : `Tapez pour chercher ; flèches pour choisir, Entrée pour lancer. ${isMac() ? "⌘K" : "Ctrl+K"} ferme.`
      }
    >
      {inputFor ? (
        <FunctionInput
          fn={inputFor}
          onBack={() => setInputFor(undefined)}
          onRun={(input) => run(() => void runFunction(inputFor, input))()}
        />
      ) : (
        <Stack gap="sm">
          <ComboBox
            label="Rechercher une page, une fonction ou une commande"
            hideLabel
            placeholder="Rechercher une page, une fonction ou une commande…"
            items={entries.map(({ run: _run, ...item }) => item)}
            value={null}
            onChange={(id) => entries.find((entry) => entry.id === id)?.run()}
          />
          <Text size="meta" tone="muted">
            {`${entries.length} commandes : pages, Réglages, fonctions, conversations, thème.`}
          </Text>
        </Stack>
      )}
    </Modal>
  );
}
