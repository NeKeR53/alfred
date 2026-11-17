/**
 * Page d’attente d’une page à qui il manque un service : tant qu’un service non facultatif de ses `uses.clients`
 * n’est pas prêt, la coquille montre cette page à la place du cadre, qui n’est pas chargé. Dès que tout est prêt
 * (onboarding terminé, compte ajouté ailleurs), la vraie page s’affiche d’elle-même, même si d’autres services du
 * module attendent encore. Elle ne nomme que les comptes qui manquent à cette page. Un service facultatif qui manque
 * ne retient pas la page.
 */
import { Button, EmptyState } from "@alfred/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Uses } from "../../lib/types";
import { listClients, testClient } from "../clients/api";
import type { SetupStep, SetupStepState } from "./api";
import { openOnboarding } from "./Onboarding";
import { stepsOfPage, useModuleSetup } from "./useModuleSetup";

/** Ce qu’il reste à faire pour un compte, à l’impératif (seul) et à l’infinitif (dans une liste). */
const TODO: Record<Exclude<SetupStepState, "ready">, { alone: string; listed: string; after?: string }> = {
  missing: { alone: "ajoutez", listed: "ajouter" },
  incomplete: { alone: "connectez", listed: "connecter" },
  untested: { alone: "testez", listed: "tester" },
  failed: { alone: "vérifiez", listed: "vérifier", after: "dont la connexion a échoué" },
};

/** « votre compte Jira », et le module qui s’en sert quand c’est une dépendance de celui de la page. */
function account(step: SetupStep, module: string): string {
  const owner = step.module !== module ? `, utilisé par le module ${step.moduleName}` : "";
  const after = TODO[step.state as keyof typeof TODO].after;
  return `votre compte ${step.label}${owner}${after ? `, ${after}` : ""}`;
}

/** « A », « A et B », « A, B et C ». */
function joined(items: string[], last = " et "): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")}${last}${items.at(-1)}`;
}

/**
 * Ce qu’il faut faire pour afficher la page, compte par compte : « Pour l’afficher, ajoutez votre compte Jira. »,
 * ou « Pour l’afficher, il reste à connecter votre compte Gmail et à tester votre compte Slack. ». Les comptes qui
 * attendent la même chose sont regroupés sous un seul verbe.
 */
export function pageNeeds(steps: SetupStep[], module: string): string {
  const todo = (step: SetupStep) => TODO[step.state as keyof typeof TODO];
  const [only] = steps;
  if (steps.length === 1 && only) return `Pour l’afficher, ${todo(only).alone} ${account(only, module)}.`;
  const groups = new Map<string, string[]>();
  for (const step of steps) {
    const verb = todo(step).listed;
    groups.set(verb, [...(groups.get(verb) ?? []), account(step, module)]);
  }
  const items = [...groups].map(([verb, accounts]) => `à ${verb} ${joined(accounts)}`);
  return `Pour l’afficher, il reste ${joined(items, groups.size > 1 && steps.length > groups.size ? ", et " : " et ")}.`;
}

/** Teste les comptes prêts mais jamais testés des services qui manquent ; Alfred garde le résultat. */
async function verify(steps: SetupStep[]) {
  const wanted = new Set(steps.filter((step) => step.state === "untested").map((step) => step.client));
  const { clients } = await listClients();
  for (const client of clients.filter((candidate) => wanted.has(candidate.id))) {
    for (const instance of client.instances.filter((item) => item.status === "ready" && !item.lastTest)) {
      await testClient(client.id, client.simple ? undefined : instance.id);
    }
  }
}

export function SetupGate({
  module,
  uses,
  compact = false,
  children,
}: {
  module: string;
  uses?: Uses;
  /** Dans un panneau : la page d’attente se fait plus petite. */
  compact?: boolean;
  children: ReactNode;
}) {
  const { modules, of, load } = useModuleSetup();
  const setup = of(module);
  const left = setup ? stepsOfPage(setup, module, uses).filter((step) => !step.optional && step.state !== "ready") : [];
  // Seul un test manque (module construit par l’agent, compte modifié) : je vérifie moi-même, une fois.
  const onlyUntested = left.length > 0 && left.every((step) => step.state === "untested");
  const verified = useRef(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!onlyUntested || verified.current) return;
    verified.current = true;
    setChecking(true);
    void verify(left)
      .catch(() => undefined)
      .finally(() => {
        setChecking(false);
        void load();
      });
  }, [onlyUntested, left, load]);

  // L’état n’est pas encore lu : rien plutôt qu’une page qui céderait aussitôt la place à la page d’attente.
  if (modules === undefined) return null;
  if (left.length === 0) return <>{children}</>;
  const size = compact ? "compact" : "default";
  if (checking) {
    return <EmptyState size={size} title={`Je vérifie la connexion à ${joined(left.map((step) => step.label))}…`} />;
  }
  return (
    <EmptyState
      size={size}
      title={left.length === 1 ? "Il manque un compte à cette page" : "Il manque des comptes à cette page"}
      description={pageNeeds(left, module)}
    >
      {/* Le parcours s’ouvre directement sur le premier compte qui manque à cette page, pas sur la présentation. */}
      <Button variant="primary" onClick={() => openOnboarding(module, "resume", left[0]?.key)}>
        Configurer
      </Button>
    </EmptyState>
  );
}
