/** Tests des fonctions : état gardé par Alfred et lancement d’un test (voir `function_tests.rs`). */
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import type { FunctionEffect } from "../../lib/types";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
  status: TestStatus;
  message: string;
  /** Sortie reçue, en JSON mis en forme (coupée au-delà de quelques milliers de caractères). */
  output: string;
  testedAt?: string;
  durationMs?: number;
}

export interface TestItem {
  name: string;
  target: { field: string; label: string; hint?: string } | null;
  /** Dernier résultat, s’il vaut pour la fonction telle qu’elle est ; `null` : à vérifier. */
  result: TestResult | null;
}

/** `none` : aucun test ; `partial` : lectures réussies, écritures pas encore lancées. */
export type FunctionTestState = "none" | "toVerify" | "failed" | "partial" | "passed";

export interface FunctionTests {
  function: string;
  effect: FunctionEffect | null;
  state: FunctionTestState;
  passed: number;
  failed: number;
  pending: number;
  tests: TestItem[];
}

export const functionTestsApi = {
  status: (module?: string) =>
    invoke<{ functions: FunctionTests[] }>("functions.tests", module ? { module } : {}).then(
      (result) => result.functions,
    ),
  run: (fn: string, test: string, options: { approved?: boolean; target?: string } = {}) =>
    invoke<TestResult & { function: string; test: string }>("functions.runTest", {
      function: fn,
      test,
      ...options,
    }),
};

/** État des tests des fonctions d’un module, relu à chaque test lancé et à chaque changement de l’espace. */
export function useFunctionTests(module: string) {
  const [tests, setTests] = useState<FunctionTests[]>();
  const load = useCallback(async () => {
    try {
      setTests(await functionTestsApi.status(module));
    } catch {
      setTests([]);
    }
  }, [module]);
  useEffect(() => {
    void load();
    const offTested = onNativeEvent("functions:tested", () => void load());
    const offSpace = onNativeEvent("space:changed", () => void load());
    return () => {
      offTested();
      offSpace();
    };
  }, [load]);
  return { tests, reload: load };
}

export const TEST_STATE_LABELS: Record<
  FunctionTestState,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  none: { label: "Sans test", tone: "neutral" },
  toVerify: { label: "À vérifier", tone: "warning" },
  failed: { label: "En échec", tone: "danger" },
  partial: { label: "Écritures à vérifier", tone: "warning" },
  passed: { label: "Vérifiée", tone: "success" },
};
