/**
 * Fonctions d’un module, dans sa fiche (Réglages → Modules), une section par groupe : ce que le module fait avec chacun de ses
 * services, puis ses autres fonctions ; chaque groupe dit ses lectures, ses écritures et l’état de ses tests, et
 * « Vérifier… » lance ses tests fonction par fonction sous les yeux de l’utilisateur.
 */
import { ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, Code, Dialog, Disclosure, type SettingsSection, StatusBadge, TextField, useConfirm } from "socle-ui";
import { Notice, Row, Stack, Text } from "../../kit";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { functionRow, stateOf, TryDialog } from "./FunctionParts";
import { type FunctionTests, functionTestsApi, type TestResult } from "./tests";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Un test de la checklist : la fonction, le test, et ce qu’il faut pour le lancer. */
interface Case {
  key: string;
  fn: ResolvedFunction;
  name: string;
  read: boolean;
  target: { field: string; label: string; hint?: string } | null;
  /** La fonction ne peut pas tourner : pas encore écrite, ou ne compile pas. */
  blocked?: string;
}

type Live = { status: "running" } | (TestResult & { status: TestResult["status"] });

function casesOf(functions: ResolvedFunction[]): Case[] {
  return functions.flatMap((fn) =>
    (fn.tests ?? []).map((test, index) => {
      const name = test.name.trim() || `#${index + 1}`;
      const state = stateOf(fn);
      return {
        key: `${fn.reference}::${name}`,
        fn,
        name,
        read: fn.effect === "read",
        target: test.target ?? null,
        blocked:
          state === "missing"
            ? "Fonction pas encore écrite."
            : state === "broken"
              ? "La fonction ne compile pas."
              : undefined,
      };
    }),
  );
}

function ResultLine({ item, live, children }: { item: Case; live: Live | undefined; children?: ReactNode }) {
  const badge =
    live?.status === "running" ? (
      <StatusBadge tone="pending">En cours</StatusBadge>
    ) : live?.status === "passed" ? (
      <StatusBadge tone="success">Réussi</StatusBadge>
    ) : live?.status === "failed" ? (
      <StatusBadge tone="danger">Échec</StatusBadge>
    ) : live?.status === "skipped" || item.blocked ? (
      <StatusBadge>Passé</StatusBadge>
    ) : (
      <StatusBadge>En attente</StatusBadge>
    );
  const note = item.blocked ?? (live && live.status !== "running" && live.status !== "passed" ? live.message : "");
  return (
    <li data-test={item.key} className="flex min-w-0 flex-col gap-1 border-line border-b py-2 last:border-b-0">
      <Row gap="sm" wrap>
        <Text as="span" weight="medium">
          {item.fn.id}
        </Text>
        <Text as="span" tone="muted">
          {item.name}
        </Text>
        {badge}
      </Row>
      {note ? (
        <Text size="meta" tone={live?.status === "failed" ? "danger" : "muted"}>
          {note}
        </Text>
      ) : null}
      {live && live.status === "failed" && live.output ? (
        <Disclosure title="Sortie reçue">
          <Code block label="Sortie reçue">
            {live.output}
          </Code>
        </Disclosure>
      ) : null}
      {children}
    </li>
  );
}

/**
 * Checklist « Tout vérifier » : les tests de lecture partent à l’ouverture, l’un après l’autre ; ceux d’écriture
 * attendent que l’utilisateur ait choisi leur cible et donné son accord.
 */
function VerifyDialog({
  module,
  functions,
  onClose,
}: {
  module: ModuleSummary;
  functions: ResolvedFunction[];
  onClose: () => void;
}) {
  const cases = useMemo(() => casesOf(functions), [functions]);
  const reads = cases.filter((item) => item.read);
  const writes = cases.filter((item) => !item.read);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [running, setRunning] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [writesStarted, setWritesStarted] = useState(false);
  const confirm = useConfirm();
  const cancelled = useRef(false);

  const runAll = async (items: Case[], approved: boolean) => {
    setRunning(true);
    for (const item of items) {
      if (cancelled.current) break;
      if (item.blocked) continue;
      setLive((current) => ({ ...current, [item.key]: { status: "running" } }));
      try {
        const result = await functionTestsApi.run(item.fn.reference, item.name, {
          approved,
          target: item.target ? targets[item.key]?.trim() || undefined : undefined,
        });
        setLive((current) => ({ ...current, [item.key]: result }));
      } catch (failure) {
        setLive((current) => ({
          ...current,
          [item.key]: { status: "failed", message: errorMessage(failure), output: "" },
        }));
      }
    }
    setRunning(false);
  };

  // Les lectures partent dès l’ouverture : elles ne changent rien chez le service.
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: une seule série par ouverture.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runAll(reads, false);
  }, []);

  const missingTarget = writes.some((item) => !item.blocked && item.target && !targets[item.key]?.trim());
  const launchWrites = async () => {
    const confirmed = await confirm({
      title: `Lancer ${plural(writes.length, "test")} d’écriture ?`,
      message:
        "Ces tests modifient vraiment le service (création, commentaire, changement d’état…), sur les cibles que vous avez indiquées. Ils ne se lancent qu’une fois, maintenant.",
      confirmLabel: "Lancer",
    });
    if (!confirmed) return;
    setWritesStarted(true);
    await runAll(writes, true);
  };

  const done = Object.values(live).filter((result) => result.status !== "running");
  const failed = done.filter((result) => result.status === "failed").length;
  const passed = done.filter((result) => result.status === "passed").length;

  const close = () => {
    cancelled.current = true;
    onClose();
  };
  const list = "m-0 flex list-none flex-col p-0";

  return (
    <Dialog
      isOpen
      size="lg"
      title={`Vérifier les fonctions de ${module.name}`}
      isBusy={running}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          <Button isDisabled={running} onPress={close}>
            Fermer
          </Button>
          {writes.length > 0 && !writesStarted ? (
            <Button variant="primary" isDisabled={running || missingTarget} onPress={() => void launchWrites()}>
              Lancer les écritures
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="md">
        <div aria-live="polite">
          <Text tone="muted">
            {running
              ? `Vérification en cours : ${passed} réussi${passed > 1 ? "s" : ""}, ${failed} en échec.`
              : done.length > 0
                ? `${passed} réussi${passed > 1 ? "s" : ""}, ${failed} en échec, sur ${plural(cases.length, "test")}.`
                : `${plural(cases.length, "test")} déclaré${cases.length > 1 ? "s" : ""}.`}
          </Text>
        </div>
        {reads.length > 0 ? (
          <section aria-label="Tests de lecture">
            <Text weight="medium">Lectures</Text>
            <ul className={list}>
              {reads.map((item) => (
                <ResultLine key={item.key} item={item} live={live[item.key]} />
              ))}
            </ul>
          </section>
        ) : null}
        {writes.length > 0 ? (
          <section aria-label="Tests d’écriture">
            <Stack gap="sm">
              <Text weight="medium">Écritures</Text>
              {writesStarted ? null : (
                <Notice tone="warning">
                  Ces tests modifient le service : ils ne se lancent qu’avec votre accord. Indiquez pour chacun une
                  cible de test (un ticket ou un message jetable).
                </Notice>
              )}
              <ul className={list}>
                {writes.map((item) => (
                  <ResultLine key={item.key} item={item} live={live[item.key]}>
                    {item.target && !writesStarted && !item.blocked ? (
                      <TextField
                        label={`${item.target.label} pour « ${item.name} »`}
                        isRequired
                        description={item.target.label}
                        placeholder={item.target.hint || item.target.label}
                        value={targets[item.key] ?? ""}
                        onChange={(value) => setTargets((current) => ({ ...current, [item.key]: value }))}
                      />
                    ) : null}
                  </ResultLine>
                ))}
              </ul>
            </Stack>
          </section>
        ) : null}
      </Stack>
    </Dialog>
  );
}

/** État des tests d’un groupe de fonctions, en mots : « 3 vérifiées, 4 à vérifier ». */
function summaryOf(functions: ResolvedFunction[], tests: FunctionTests[] | undefined) {
  if (!tests) return null;
  const mine = functions.map((fn) => tests.find((item) => item.function === fn.reference));
  const withTests = mine.filter((item): item is FunctionTests => item !== undefined && item.state !== "none");
  if (withTests.length === 0) return "aucun test déclaré";
  const count = (state: FunctionTests["state"]) => withTests.filter((item) => item.state === state).length;
  return [
    count("passed") ? `${count("passed")} vérifiée${count("passed") > 1 ? "s" : ""}` : null,
    count("failed") ? `${count("failed")} en échec` : null,
    count("toVerify") + count("partial") ? `${count("toVerify") + count("partial")} à vérifier` : null,
    functions.length - withTests.length ? `${functions.length - withTests.length} sans test` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Un groupe de fonctions de la fiche : ce que le module fait avec un service, ou ses autres fonctions. */
export interface FunctionGroupSpec {
  key: string;
  label: string;
  functions: ResolvedFunction[];
}

/**
 * Sections « Fonctions » de la fiche d’un module : une par groupe, avec une ligne de bilan (lectures, écritures, état
 * des tests), « Vérifier… » qui lance les tests du groupe, puis une ligne par fonction. Les modales (essai,
 * vérification) vont dans le contenu libre de la dernière section.
 */
export function useFunctionSections(
  module: ModuleSummary | undefined,
  groups: FunctionGroupSpec[],
  tests: FunctionTests[] | undefined,
): SettingsSection[] {
  const [trying, setTrying] = useState<ResolvedFunction>();
  const [verifying, setVerifying] = useState<FunctionGroupSpec>();
  const shown = groups.filter((group) => group.functions.length > 0);
  if (!module || shown.length === 0) return [];

  const testsOf = (fn: ResolvedFunction) => tests?.find((item) => item.function === fn.reference);
  const remove = async (fn: ResolvedFunction) => {
    try {
      await invoke("functions.remove", { reference: fn.reference });
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "La fonction n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
  };

  const dialogs = (
    <>
      {verifying ? (
        <VerifyDialog module={module} functions={verifying.functions} onClose={() => setVerifying(undefined)} />
      ) : null}
      {trying ? <TryDialog key={trying.reference} fn={trying} onClose={() => setTrying(undefined)} /> : null}
    </>
  );

  return shown.map((group, index) => {
    const { functions, label } = group;
    const reads = functions.filter((fn) => fn.effect === "read").length;
    const testCount = functions.reduce((total, fn) => total + (fn.tests?.length ?? 0), 0);
    return {
      id: `functions:${group.key}`,
      title: `${label} (${functions.length})`,
      description: [
        reads ? `${reads} en lecture` : null,
        functions.length - reads ? `${functions.length - reads} en écriture` : null,
        summaryOf(functions, tests),
      ]
        .filter(Boolean)
        .join(" · "),
      actions:
        testCount > 0
          ? [
              {
                id: "verify",
                label: `Vérifier : ${label}`,
                icon: <ShieldCheck size={16} aria-hidden="true" />,
                onPress: () => setVerifying(group),
              },
            ]
          : undefined,
      settings: functions.map((fn) =>
        functionRow(fn, {
          readOnly: module.readOnly,
          tests: testsOf(fn),
          onTry: () => setTrying(fn),
          onRemove: () => remove(fn),
        }),
      ),
      content: index === shown.length - 1 ? dialogs : undefined,
    };
  });
}
