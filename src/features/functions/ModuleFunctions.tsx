/**
 * Fonctions d’un module, dans sa fiche (Réglages → Modules) : pour un connecteur, les services qu’il détient et
 * toutes les opérations qu’il offre aux autres modules, lecture ou écriture, avec l’état de leurs tests ; et
 * « Tout vérifier », qui lance les tests fonction par fonction sous les yeux de l’utilisateur.
 */
import {
  Button,
  Dialog,
  Disclosure,
  FeedbackBanner,
  Markdown,
  Row,
  Spinner,
  Stack,
  StatusBadge,
  Text,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction } from "../../lib/types";
import { DialogHeader } from "../../shell/DialogHeader";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { FunctionItem, stateOf, TryDialog } from "./FunctionParts";
import { type FunctionTests, functionTestsApi, type TestResult, useFunctionTests } from "./tests";
import "../vault/settings-dialog.css";
import "./functions.css";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function codeBlock(content: string) {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${content}\n${fence}`;
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
      <Spinner label={`Test « ${item.name} » en cours`} />
    ) : live?.status === "passed" ? (
      <StatusBadge tone="success" size="compact">
        Réussi
      </StatusBadge>
    ) : live?.status === "failed" ? (
      <StatusBadge tone="danger" size="compact">
        Échec
      </StatusBadge>
    ) : live?.status === "skipped" || item.blocked ? (
      <StatusBadge size="compact">Passé</StatusBadge>
    ) : (
      <StatusBadge size="compact">En attente</StatusBadge>
    );
  const note = item.blocked ?? (live && live.status !== "running" && live.status !== "passed" ? live.message : "");
  return (
    <li className="function-check" data-test={item.key}>
      <div className="function-check__line">
        <span className="function-row__name">{item.fn.id}</span>
        <span className="function-check__name" title={item.name}>
          {item.name}
        </span>
        {badge}
      </div>
      {note ? (
        <Text size="meta" tone={live?.status === "failed" ? "danger" : "muted"}>
          {note}
        </Text>
      ) : null}
      {live && live.status === "failed" && live.output ? (
        <Disclosure appearance="subtle" label="Sortie reçue">
          <Markdown>{codeBlock(live.output)}</Markdown>
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
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const cases = useMemo(() => casesOf(functions), [functions]);
  const reads = cases.filter((item) => item.read);
  const writes = cases.filter((item) => !item.read);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [running, setRunning] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [writesStarted, setWritesStarted] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
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
    const element = dialog.current;
    if (element && !element.open) element.showModal();
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

  return (
    <Dialog
      ref={dialog}
      className="settings-dialog function-verify-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (running) event.preventDefault();
      }}
      onClose={(event) => {
        // La confirmation des écritures est une modale dans celle-ci : sa fermeture ne ferme pas la checklist.
        if (event.target !== event.currentTarget) return;
        cancelled.current = true;
        onClose();
      }}
    >
      <DialogHeader title={`Vérifier les fonctions de ${module.name}`} titleId={titleId} dialogRef={dialog} />
      <div className="settings-dialog__body">
        <Stack gap="md">
          <Text tone="muted" aria-live="polite">
            {running
              ? `Vérification en cours : ${passed} réussi${passed > 1 ? "s" : ""}, ${failed} en échec.`
              : done.length > 0
                ? `${passed} réussi${passed > 1 ? "s" : ""}, ${failed} en échec, sur ${plural(cases.length, "test")}.`
                : `${plural(cases.length, "test")} déclaré${cases.length > 1 ? "s" : ""}.`}
          </Text>
          {reads.length > 0 ? (
            <section aria-label="Tests de lecture">
              <Text weight="medium">Lectures</Text>
              <ul className="function-checks">
                {reads.map((item) => (
                  <ResultLine key={item.key} item={item} live={live[item.key]} />
                ))}
              </ul>
            </section>
          ) : null}
          {writes.length > 0 ? (
            <section aria-label="Tests d’écriture">
              <Text weight="medium">Écritures</Text>
              {writesStarted ? null : (
                <FeedbackBanner tone="warning" appearance="contained">
                  Ces tests modifient le service : ils ne se lancent qu’avec votre accord. Indiquez pour chacun une
                  cible de test (un ticket ou un message jetable).
                </FeedbackBanner>
              )}
              <ul className="function-checks">
                {writes.map((item) => (
                  <ResultLine key={item.key} item={item} live={live[item.key]}>
                    {item.target && !writesStarted && !item.blocked ? (
                      <div className="function-check__target">
                        <TextInput
                          aria-label={`${item.target.label} pour « ${item.name} »`}
                          placeholder={item.target.hint || item.target.label}
                          value={targets[item.key] ?? ""}
                          onChange={(event) =>
                            setTargets((current) => ({ ...current, [item.key]: event.target.value }))
                          }
                        />
                        <Text size="meta" tone="muted">
                          {item.target.label}
                        </Text>
                      </div>
                    ) : null}
                  </ResultLine>
                ))}
              </ul>
            </section>
          ) : null}
        </Stack>
      </div>
      <footer className="settings-dialog__footer">
        <Row justify="end">
          <Button disabled={running} onClick={() => dialog.current?.close()}>
            Fermer
          </Button>
          {writes.length > 0 && !writesStarted ? (
            <Button
              variant="primary"
              disabled={running || missingTarget}
              title={missingTarget ? "Indiquez d’abord la cible de chaque test." : undefined}
              onClick={() => void launchWrites()}
            >
              Lancer les écritures
            </Button>
          ) : null}
        </Row>
      </footer>
      {confirmDialog}
    </Dialog>
  );
}

function summaryOf(tests: FunctionTests[] | undefined) {
  if (!tests) return null;
  const withTests = tests.filter((item) => item.state !== "none");
  if (withTests.length === 0) return "aucun test déclaré";
  const count = (state: FunctionTests["state"]) => withTests.filter((item) => item.state === state).length;
  return [
    count("passed") ? `${count("passed")} vérifiée${count("passed") > 1 ? "s" : ""}` : null,
    count("failed") ? `${count("failed")} en échec` : null,
    count("toVerify") + count("partial") ? `${count("toVerify") + count("partial")} à vérifier` : null,
    tests.length - withTests.length ? `${tests.length - withTests.length} sans test` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Partie « Fonctions » de la fiche d’un module. */
export function ModuleFunctions({ module, clientLabels }: { module: ModuleSummary; clientLabels: string[] }) {
  const snapshot = useShell((state) => state.snapshot);
  const functions = useMemo(
    () => snapshot?.functions.filter((fn) => fn.module === module.id) ?? [],
    [snapshot, module.id],
  );
  const { tests } = useFunctionTests(module.id);
  const [trying, setTrying] = useState<ResolvedFunction>();
  const [verifying, setVerifying] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  if (functions.length === 0) return null;

  const reads = functions.filter((fn) => fn.effect === "read").length;
  const testCount = functions.reduce((total, fn) => total + (fn.tests?.length ?? 0), 0);
  const connector = clientLabels.length > 0;
  const testsOf = (fn: ResolvedFunction) => tests?.find((item) => item.function === fn.reference);

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
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "La fonction n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
  };

  return (
    <div className="module-part" data-part="functions">
      <div className="module-part__head module-part__head--actions">
        <div>
          <h3>{connector ? "Connecteur" : "Fonctions"}</h3>
          <p>
            {connector
              ? `Tout accès à ${clientLabels.join(", ")} passe par ces fonctions : les autres modules les appellent au lieu de parler au service eux-mêmes.`
              : "Les traitements propres à ce module."}
          </p>
        </div>
        <Button disabled={testCount === 0} onClick={() => setVerifying(true)}>
          Tout vérifier
        </Button>
      </div>
      <Text size="meta" tone="muted">
        {[
          plural(functions.length, "fonction"),
          reads ? `${reads} en lecture` : null,
          functions.length - reads ? `${functions.length - reads} en écriture` : null,
          summaryOf(tests),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <ul className="function-list">
        {functions.map((fn) => (
          <FunctionItem
            key={fn.reference}
            fn={fn}
            readOnly={module.readOnly}
            withTests
            tests={testsOf(fn)}
            onTry={() => setTrying(fn)}
            onRemove={() => void remove(fn)}
          />
        ))}
      </ul>
      {verifying ? <VerifyDialog module={module} functions={functions} onClose={() => setVerifying(false)} /> : null}
      {trying ? <TryDialog key={trying.reference} fn={trying} onClose={() => setTrying(undefined)} /> : null}
      {confirmDialog}
    </div>
  );
}
