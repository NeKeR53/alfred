/**
 * Page d’attente d’une page à qui il manque un service : tant qu’un service non facultatif de ses `uses.clients`
 * n’est pas prêt, la coquille montre cette page à la place du cadre, qui n’est pas chargé. Dès que tout est prêt
 * (onboarding terminé, compte ajouté ailleurs), la vraie page s’affiche d’elle-même. Un service facultatif qui
 * manque ne retient pas la page.
 */
import { Button, EmptyState } from "@alfred/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Uses } from "../../lib/types";
import { listClients, testClient } from "../clients/api";
import type { SetupStep, SetupStepState } from "./api";
import { openOnboarding } from "./Onboarding";
import { stepsOfPage, useModuleSetup } from "./useModuleSetup";

const STATE: Record<Exclude<SetupStepState, "ready">, string> = {
  missing: "à ajouter",
  incomplete: "à connecter",
  untested: "à tester",
  failed: "connexion en échec",
};

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

function names(steps: SetupStep[]): string {
  const labels = steps.map((step) => step.label);
  return labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} et ${labels.at(-1)}`;
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
    return <EmptyState size={size} title={`Je vérifie la connexion à ${names(left)}…`} />;
  }
  const detail = left.map((step) => `${step.label} : ${STATE[step.state as keyof typeof STATE]}`).join(" · ");
  return (
    <EmptyState size={size} title={`Cette page attend ${names(left)}`} description={`${detail}.`}>
      <Button variant="primary" onClick={() => openOnboarding(module, "resume")}>
        Configurer
      </Button>
    </EmptyState>
  );
}
