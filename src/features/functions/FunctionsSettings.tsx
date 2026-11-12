import {
  Button,
  Dialog,
  EmptyState,
  FormField,
  Heading,
  LoadingSkeleton,
  Markdown,
  Page,
  Row,
  Section,
  Stack,
  StatusBadge,
  SwitchControl,
  Text,
  TextArea,
  useConfirm,
} from "@alfred/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import "../vault/settings-dialog.css";
import "./functions.css";

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

function stateOf(fn: ResolvedFunction): FunctionState {
  if (fn.missing) return "missing";
  if (fn.errors.length > 0) return "broken";
  return "ready";
}

function FunctionStatus({ fn }: { fn: ResolvedFunction }) {
  const state = stateOf(fn);
  if (state === "missing") return <StatusBadge tone="warning">Pas encore écrite</StatusBadge>;
  if (state === "broken") return <StatusBadge tone="danger">Ne compile pas</StatusBadge>;
  return <StatusBadge tone="success">Prête</StatusBadge>;
}

function TryDialog({ fn, onClose }: { fn: ResolvedFunction; onClose: () => void }) {
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
        <header className="settings-dialog__header">
          <h2 id={titleId}>Essayer « {fn.id} »</h2>
        </header>
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

function FunctionItem({
  fn,
  readOnly,
  onTry,
  onRemove,
}: {
  fn: ResolvedFunction;
  readOnly: boolean;
  onTry: () => void;
  onRemove: () => void;
}) {
  const [tool, setTool] = useState(fn.tool);
  const [saving, setSaving] = useState(false);
  const [shownTool, setShownTool] = useState(fn.tool);
  if (shownTool !== fn.tool) {
    setShownTool(fn.tool);
    setTool(fn.tool);
  }
  const ready = stateOf(fn) === "ready";

  const toggleTool = async (next: boolean) => {
    setTool(next);
    setSaving(true);
    try {
      await invoke("functions.setTool", { reference: fn.reference, tool: next });
      await useShell.getState().refresh();
    } catch (failure) {
      setTool(!next);
      notify({
        title: "Le réglage de la fonction n’a pas été enregistré",
        description: errorMessage(failure),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="sm">
      <Row justify="between" align="start" gap="md">
        <Stack gap="xs">
          <Heading level={3}>{fn.id}</Heading>
          <Text tone={fn.description ? "default" : "muted"}>{fn.description || "Aucune description."}</Text>
        </Stack>
        <FunctionStatus fn={fn} />
      </Row>
      {fn.missing ? (
        <Text tone="muted">
          Déclarée dans le module, mais son fichier n’existe pas encore : demandez à l’agent de l’écrire.
        </Text>
      ) : null}
      {fn.errors.length > 0 ? (
        <Stack gap="xs">
          {fn.errors.map((error) => (
            <Text key={`${error.line ?? ""}:${error.column ?? ""}:${error.message}`} tone="danger">
              {error.line ? `Ligne ${error.line}${error.column ? `, colonne ${error.column}` : ""} : ` : ""}
              {error.message}
            </Text>
          ))}
        </Stack>
      ) : null}
      <Stack gap="none">
        <SwitchControl
          label="Proposer aux agents comme outil"
          checked={tool}
          disabled={readOnly || saving}
          onChange={(event) => void toggleTool(event.target.checked)}
        />
        <Text size="meta" tone="muted">
          {readOnly
            ? "Module installé en lecture seule : ce réglage suit sa version d’origine."
            : "L’agent peut alors appeler cette fonction pendant une conversation."}
        </Text>
      </Stack>
      <Row gap="sm">
        <Button disabled={!ready} aria-label={`Essayer la fonction ${fn.id}`} onClick={onTry}>
          Essayer
        </Button>
        <Button
          variant="danger"
          disabled={readOnly}
          aria-label={`Supprimer la fonction ${fn.id}`}
          title={readOnly ? "Module en lecture seule" : undefined}
          onClick={onRemove}
        >
          Supprimer
        </Button>
      </Row>
    </Stack>
  );
}

/** Onglet « Fonctions » des Réglages : les fonctions de l’espace, leur état, leur exposition aux agents, un essai. */
export function FunctionsSettings() {
  const snapshot = useShell((state) => state.snapshot);
  const setView = useShell((state) => state.setView);
  const [trying, setTrying] = useState<ResolvedFunction>();
  const { confirm, confirmDialog } = useConfirm();

  if (snapshot === undefined) {
    return (
      <Page width="text">
        <LoadingSkeleton label="Chargement des fonctions…" />
      </Page>
    );
  }
  if (snapshot === null) {
    return (
      <Page width="text">
        <EmptyState title="Aucun espace ouvert" description="Ouvrez ou créez un espace depuis l’accueil d’Alfred." />
      </Page>
    );
  }

  const functions = snapshot.functions;
  if (functions.length === 0) {
    return (
      <Page width="text">
        <EmptyState
          title="Aucune fonction"
          description="Une fonction fait un traitement côté Alfred (calcul, appel d’un client, écriture en base) pour vos pages, webhooks et planifications. Elles se créent en le demandant à l’agent."
        >
          <Button variant="primary" onClick={() => setView({ kind: "agent" })}>
            Ouvrir l’agent
          </Button>
        </EmptyState>
      </Page>
    );
  }

  const modules = new Map<string, ModuleSummary | undefined>();
  for (const fn of functions) {
    if (!modules.has(fn.module))
      modules.set(
        fn.module,
        snapshot.modules.find((module) => module.id === fn.module),
      );
  }
  const broken = functions.filter((fn) => stateOf(fn) === "broken").length;

  const remove = async (fn: ResolvedFunction) => {
    const confirmed = await confirm({
      title: `Supprimer la fonction « ${fn.id} » ?`,
      message:
        "Son fichier et sa déclaration sont retirés du module ; les pages qui l’appellent échoueront. La suppression est enregistrée dans l’historique de l’espace et peut y être annulée.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await invoke("functions.remove", { reference: fn.reference });
      notify({ title: "Fonction supprimée", description: fn.reference, tone: "success" });
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "La fonction n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
  };

  return (
    <Page width="text">
      {broken > 0 ? (
        <Text tone="danger" weight="medium">
          {broken === 1 ? "1 fonction ne compile pas." : `${broken} fonctions ne compilent pas.`} Demandez à l’agent de
          corriger les erreurs indiquées.
        </Text>
      ) : null}
      {[...modules.entries()].map(([id, module]) => (
        <Section
          key={id}
          title={module?.name ?? id}
          description={
            module?.readOnly
              ? `${module.description ? `${module.description} ` : ""}Module en lecture seule.`
              : module?.description || undefined
          }
        >
          <Stack gap="lg">
            {functions
              .filter((fn) => fn.module === id)
              .map((fn) => (
                <FunctionItem
                  key={fn.reference}
                  fn={fn}
                  readOnly={Boolean(module?.readOnly)}
                  onTry={() => setTrying(fn)}
                  onRemove={() => void remove(fn)}
                />
              ))}
          </Stack>
        </Section>
      ))}
      {trying ? <TryDialog key={trying.reference} fn={trying} onClose={() => setTrying(undefined)} /> : null}
      {confirmDialog}
    </Page>
  );
}
