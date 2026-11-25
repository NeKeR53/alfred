import { type FormEvent, useState } from "react";
import { Button, Code, type ItemSetting, Modal, type SettingTag, TextArea } from "socle-ui";
import { Stack, Text } from "../../kit";
import { invoke } from "../../lib/native";
import type { FunctionRuntime, ResolvedFunction } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { type FunctionTests, TEST_STATE_LABELS } from "./tests";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
};

/** Valeur d’exemple tirée d’un schéma JSON : défaut, exemple ou valeur vide du bon type. */
export function skeleton(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 6) return {};
  const node = schema as Schema;
  if (node.default !== undefined) return node.default;
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0];
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type.find((candidate) => candidate !== "null") : node.type;
  switch (type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "null":
      return null;
    default: {
      if (!node.properties) return {};
      return Object.fromEntries(
        Object.entries(node.properties).map(([key, value]) => [key, skeleton(value, depth + 1)]),
      );
    }
  }
}

type FunctionState = "ready" | "missing" | "broken";

export function stateOf(fn: ResolvedFunction): FunctionState {
  if (fn.missing) return "missing";
  if (fn.errors.length > 0) return "broken";
  return "ready";
}

const RUNTIME_LABELS: Record<FunctionRuntime, string> = {
  ts: "TypeScript",
  bash: "bash",
  pwsh: "PowerShell",
  python: "Python",
};

function isScript(fn: ResolvedFunction): boolean {
  return (fn.runtime ?? "ts") !== "ts";
}

/** Étiquettes d’une fonction : seulement ce qui mérite l’attention (langage d’un script, écriture, tests, état). */
function tagsOf(fn: ResolvedFunction, tests: FunctionTests | undefined): SettingTag[] {
  const tags: SettingTag[] = [];
  if (fn.kept === "toValidate") tags.push({ label: "À valider", tone: "warning" });
  if (isScript(fn)) tags.push({ label: RUNTIME_LABELS[fn.runtime], tone: "neutral" });
  if (fn.effect !== "read") tags.push({ label: "Écriture", tone: "neutral" });
  const state = stateOf(fn);
  if (state === "missing") tags.push({ label: "Pas encore écrite", tone: "pending" });
  else if (state === "broken")
    tags.push({ label: isScript(fn) ? "Interpréteur absent" : "Ne compile pas", tone: "danger" });
  else if (tests && tests.state !== "none" && tests.state !== "passed") tags.push(TEST_STATE_LABELS[tests.state]);
  return tags;
}

/** Accepte un script gardé par l’agent dans son état actuel : il peut alors tourner. */
async function acceptKept(fn: ResolvedFunction) {
  try {
    await invoke("functions.acceptKept", { reference: fn.reference });
    await useShell.getState().refresh();
    notify({ title: `Fonction « ${fn.id} » acceptée`, tone: "success" });
  } catch (failure) {
    notify({ title: "L’accord n’a pas été enregistré", description: errorMessage(failure), tone: "error" });
  }
}

/** Active ou retire la fonction des outils proposés à l’agent. */
async function setTool(fn: ResolvedFunction, next: boolean) {
  try {
    await invoke("functions.setTool", { reference: fn.reference, tool: next });
    await useShell.getState().refresh();
  } catch (failure) {
    notify({
      title: "Le réglage de la fonction n’a pas été enregistré",
      description: errorMessage(failure),
      tone: "error",
    });
  }
}

/**
 * Une fonction sur une ligne de la fiche d’un module : nom, description, puis ce qui mérite l’attention. Essayer,
 * proposer à l’agent et supprimer sont dans le menu « … » de la ligne ; les erreurs s’ajoutent à la description.
 */
export function functionRow(
  fn: ResolvedFunction,
  {
    readOnly,
    tests,
    onTry,
    onRemove,
  }: { readOnly: boolean; tests?: FunctionTests; onTry: () => void; onRemove: () => Promise<void> },
): ItemSetting {
  const errors = fn.errors.map(
    (error) =>
      `${error.line ? `Ligne ${error.line}${error.column ? `, colonne ${error.column}` : ""} : ` : ""}${error.message}`,
  );
  return {
    type: "item",
    id: fn.reference,
    label: fn.id,
    description: [
      fn.description || "Aucune description.",
      fn.missing
        ? "Déclarée dans le module, mais son fichier n’existe pas encore : demandez à l’agent de l’écrire."
        : null,
      fn.kept === "toValidate"
        ? "Script gardé par l’agent : il ne tourne qu’après votre accord. Toute modification le remet à valider."
        : null,
      ...errors,
    ]
      .filter(Boolean)
      .join(" "),
    tags: tagsOf(fn, tests),
    actions: [
      ...(fn.kept === "toValidate"
        ? [{ id: "accept", label: "Accepter", isDisabled: stateOf(fn) !== "ready", onPress: () => void acceptKept(fn) }]
        : []),
      { id: "try", label: "Essayer…", isDisabled: stateOf(fn) !== "ready", onPress: onTry },
      {
        id: "tool",
        label: fn.tool ? "Ne plus proposer à l’agent" : "Proposer à l’agent",
        isDisabled: readOnly,
        onPress: () => setTool(fn, !fn.tool),
      },
      {
        id: "remove",
        label: "Supprimer la fonction…",
        isDisabled: readOnly,
        danger: true,
        confirm: {
          title: `Supprimer la fonction « ${fn.id} » ?`,
          message:
            "Son fichier et sa déclaration sont retirés du module ; les pages qui l’appellent échoueront. La suppression est enregistrée dans l’historique de l’espace et peut y être annulée.",
          confirmLabel: "Supprimer",
        },
        onPress: onRemove,
      },
    ],
  };
}

export function TryDialog({ fn, onClose }: { fn: ResolvedFunction; onClose: () => void }) {
  const [input, setInput] = useState(() => JSON.stringify(skeleton(fn.input), null, 2));
  const [inputError, setInputError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: true; output: unknown } | { ok: false; message: string }>();
  const formId = `essai-${fn.reference.replace(/[^a-z0-9]/gi, "-")}`;

  const run = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = input.trim() === "" ? {} : JSON.parse(input);
    } catch (failure) {
      setInputError(`Saisissez une entrée en JSON valide (${errorMessage(failure)}).`);
      return;
    }
    setInputError(undefined);
    setRunning(true);
    setResult(undefined);
    try {
      const output = await invoke("functions.call", { function: fn.reference, input: parsed });
      setResult({ ok: true, output });
    } catch (failure) {
      setResult({ ok: false, message: errorMessage(failure) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      isOpen
      size="lg"
      title={`Essayer « ${fn.id} »`}
      isBusy={running}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose} isDisabled={running}>
            Fermer
          </Button>
          <Button type="submit" form={formId} variant="primary" isPending={running}>
            Exécuter
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={run}>
        <Stack gap="md">
          <Text tone="muted">
            L’appel est réel : la fonction s’exécute avec ses clients et sa base, et l’exécution s’inscrit au journal.
          </Text>
          <TextArea
            label="Entrée (JSON)"
            description={
              fn.input
                ? "Préremplie d’après le schéma d’entrée de la fonction."
                : "La fonction ne décrit pas son entrée."
            }
            error={inputError}
            minRows={8}
            value={input}
            onChange={(value) => {
              setInput(value);
              setInputError(undefined);
            }}
          />
          {running ? (
            <Text tone="muted">Exécution en cours…</Text>
          ) : result?.ok ? (
            <Stack gap="xs">
              <Text weight="medium">Sortie</Text>
              <Code block label="Sortie">
                {result.output === undefined ? "(aucune sortie)" : JSON.stringify(result.output, null, 2)}
              </Code>
            </Stack>
          ) : result ? (
            <Stack gap="xs">
              <Text tone="danger" weight="strong">
                Échec de l’exécution
              </Text>
              <Code block label="Erreur">
                {result.message}
              </Code>
            </Stack>
          ) : null}
        </Stack>
      </form>
    </Modal>
  );
}
