import {
  Button,
  Dialog,
  FormField,
  Markdown,
  MenuItem,
  OverflowMenu,
  Row,
  Stack,
  StatusBadge,
  Text,
  TextArea,
} from "@alfred/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import type { FunctionRuntime, ResolvedFunction } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { type FunctionTests, TEST_STATE_LABELS } from "./tests";
import "../vault/settings-dialog.css";
import "./functions.css";
import { DialogHeader } from "../../shell/DialogHeader";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bloc de code Markdown dont la clôture ne peut pas être refermée par le contenu. */
function codeBlock(content: string, language = ""): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content}\n${fence}`;
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

/** Lecture ou écriture : sans effet déclaré, la fonction compte comme une écriture. */
export function EffectBadge({ fn }: { fn: ResolvedFunction }) {
  if (fn.effect === "read")
    return (
      <StatusBadge size="compact" title="Ne fait que lire : ses tests se lancent d’office.">
        Lecture
      </StatusBadge>
    );
  return (
    <StatusBadge
      size="compact"
      title={
        fn.effect === "write"
          ? "Modifie le service : ses tests attendent votre accord."
          : "Effet non déclaré : traitée comme une écriture."
      }
    >
      Écriture
    </StatusBadge>
  );
}

/** État des tests d’une fonction, quand il demande quelque chose : une fonction vérifiée n’en porte pas. */
function TestBadge({ tests }: { tests: FunctionTests | undefined }) {
  if (!tests || tests.state === "none" || tests.state === "passed") return null;
  const { label, tone } = TEST_STATE_LABELS[tests.state];
  const total = tests.tests.length;
  return (
    <StatusBadge
      tone={tone}
      size="compact"
      title={`${tests.passed} réussi${tests.passed > 1 ? "s" : ""} sur ${total} test${total > 1 ? "s" : ""}`}
    >
      {label}
    </StatusBadge>
  );
}

export function FunctionStatus({ fn }: { fn: ResolvedFunction }) {
  const state = stateOf(fn);
  if (state === "missing") return <StatusBadge tone="warning">Pas encore écrite</StatusBadge>;
  if (state === "broken")
    return <StatusBadge tone="danger">{isScript(fn) ? "Interpréteur absent" : "Ne compile pas"}</StatusBadge>;
  return <StatusBadge tone="success">Prête</StatusBadge>;
}

export function TryDialog({ fn, onClose }: { fn: ResolvedFunction; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const titleId = useId();
  const [input, setInput] = useState(() => JSON.stringify(skeleton(fn.input), null, 2));
  const [inputError, setInputError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: true; output: unknown } | { ok: false; message: string }>();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

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
    <Dialog
      ref={dialog}
      className="settings-dialog function-try-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (running) event.preventDefault();
      }}
      onClose={onClose}
    >
      <form id={formId} noValidate onSubmit={run}>
        <DialogHeader title={`Essayer « ${fn.id} »`} titleId={titleId} dialogRef={dialog} />
        <div className="settings-dialog__body">
          <Stack gap="md">
            <Text tone="muted">
              L’appel est réel : la fonction s’exécute avec ses clients et sa base, et l’exécution s’inscrit au journal.
            </Text>
            <FormField
              label="Entrée (JSON)"
              hint={
                fn.input
                  ? "Préremplie d’après le schéma d’entrée de la fonction."
                  : "La fonction ne décrit pas son entrée."
              }
              error={inputError}
            >
              <TextArea
                className="mono"
                rows={8}
                spellCheck={false}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setInputError(undefined);
                }}
              />
            </FormField>
            {running ? (
              <Text tone="muted">Exécution en cours…</Text>
            ) : result?.ok ? (
              <Stack gap="xs">
                <Text weight="medium">Sortie</Text>
                <Markdown>
                  {result.output === undefined
                    ? codeBlock("(aucune sortie)")
                    : codeBlock(JSON.stringify(result.output, null, 2), "json")}
                </Markdown>
              </Stack>
            ) : result ? (
              <Stack gap="xs">
                <Text tone="danger" weight="strong">
                  Échec de l’exécution
                </Text>
                <Markdown>{codeBlock(result.message)}</Markdown>
              </Stack>
            ) : null}
          </Stack>
        </div>
        <footer className="settings-dialog__footer">
          <Row justify="end">
            <Button disabled={running} onClick={() => dialog.current?.close()}>
              Fermer
            </Button>
            <Button type="submit" variant="primary" loading={running} loadingLabel="Exécution…">
              Exécuter
            </Button>
          </Row>
        </footer>
      </form>
    </Dialog>
  );
}

/**
 * Une fonction sur une ligne, dans la fiche d’un module : nom, langage d’un script, description (coupée, en entier
 * au survol), puis seulement ce qui mérite l’attention, en petites pastilles : une écriture, des tests à refaire ou
 * en échec, une fonction pas prête. Essayer, proposer à l’agent et supprimer sont dans le menu « … » de la ligne.
 * Les erreurs s’ajoutent dessous.
 */
export function FunctionItem({
  fn,
  readOnly,
  onTry,
  onRemove,
  tests,
}: {
  fn: ResolvedFunction;
  readOnly: boolean;
  onTry: () => void;
  onRemove: () => void;
  tests?: FunctionTests;
}) {
  const [saving, setSaving] = useState(false);
  const ready = stateOf(fn) === "ready";
  const setToolOn = async (next: boolean) => {
    setSaving(true);
    try {
      await invoke("functions.setTool", { reference: fn.reference, tool: next });
      await useShell.getState().refresh();
    } catch (failure) {
      notify({
        title: "Le réglage de la fonction n’a pas été enregistré",
        description: errorMessage(failure),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };
  const items = [
    { label: "Essayer…", disabled: !ready, run: onTry },
    {
      label: fn.tool ? "Ne plus proposer à l’agent" : "Proposer à l’agent",
      disabled: readOnly || saving,
      run: () => void setToolOn(!fn.tool),
    },
    { label: "Supprimer la fonction…", disabled: readOnly, run: onRemove },
  ];
  return (
    <li className="function-row" data-function={fn.reference}>
      <div className="function-row__line">
        <span className="function-row__name">{fn.id}</span>
        {isScript(fn) ? (
          <StatusBadge tone="neutral" size="compact">
            {RUNTIME_LABELS[fn.runtime]}
          </StatusBadge>
        ) : null}
        <span
          className={`function-row__description${fn.description ? "" : " is-empty"}`}
          title={fn.description || undefined}
        >
          {fn.description || "Aucune description."}
        </span>
        {fn.effect === "read" ? null : <EffectBadge fn={fn} />}
        {ready ? <TestBadge tests={tests} /> : <FunctionStatus fn={fn} />}
        <OverflowMenu label={`Actions de la fonction ${fn.id}`} size="small">
          {items.map((item) => (
            // L’action part dès la capture : le menu se ferme avant la remontée du clic (voir `ModulesSettings`).
            <MenuItem key={item.label} disabled={item.disabled} onClickCapture={item.run}>
              {item.label}
            </MenuItem>
          ))}
        </OverflowMenu>
      </div>
      {fn.missing ? (
        <Text size="meta" tone="muted">
          Déclarée dans le module, mais son fichier n’existe pas encore : demandez à l’agent de l’écrire.
        </Text>
      ) : null}
      {fn.errors.map((error) => (
        <Text key={`${error.line ?? ""}:${error.column ?? ""}:${error.message}`} size="meta" tone="danger">
          {error.line ? `Ligne ${error.line}${error.column ? `, colonne ${error.column}` : ""} : ` : ""}
          {error.message}
        </Text>
      ))}
    </li>
  );
}
