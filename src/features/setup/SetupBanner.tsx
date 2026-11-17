/**
 * Bandeau au-dessus d’une page dont un service n’est pas prêt, avec de quoi le configurer. Un module se sert dès
 * qu’un service est prêt : une page qui déclare ses services (`uses.clients`) ne parle que des siens, et n’affiche
 * rien quand ils sont prêts, même si le reste du module attend encore sa configuration.
 */
import { Button, FeedbackBanner, IconButton } from "@alfred/ui";
import { PlugZap } from "lucide-react";
import { useState } from "react";
import type { Uses } from "../../lib/types";
import { listClients, testClient } from "../clients/api";
import type { ModuleSetup, SetupStep } from "./api";
import { openOnboarding } from "./Onboarding";
import { useModuleSetup } from "./useModuleSetup";

/** Ouvre l’onboarding du module, à la première étape incomplète, au-dessus de la page. */
export function openModuleSetup(module: string) {
  openOnboarding(module, "resume");
}

/** Teste les comptes prêts mais jamais testés des services qui manquent au module ; Alfred garde le résultat. */
async function verify(steps: SetupStep[]) {
  const wanted = new Set(steps.filter((step) => step.state === "untested").map((step) => step.client));
  const { clients } = await listClients();
  for (const client of clients.filter((candidate) => wanted.has(candidate.id))) {
    for (const instance of client.instances.filter((item) => item.status === "ready" && !item.lastTest)) {
      await testClient(client.id, client.simple ? undefined : instance.id);
    }
  }
}

/**
 * Services dont dépend une page : ceux qu’elle déclare dans `uses.clients` (« besoin » de son module, ou
 * « dépendance/besoin »), sinon tous ceux du module, dépendances comprises.
 */
export function stepsOfPage(setup: ModuleSetup, module: string, uses?: Uses): SetupStep[] {
  const declared = uses?.clients ?? [];
  if (declared.length === 0) return setup.steps;
  const keys = new Set(declared.map((need) => (need.includes("/") ? need : `${module}/${need}`)));
  return setup.steps.filter((step) => keys.has(step.key));
}

export function SetupBanner({ module, uses }: { module: string; uses?: Uses }) {
  const { of, load } = useModuleSetup();
  const [checking, setChecking] = useState(false);
  const setup = of(module);
  if (!setup || setup.ready) return null;
  const left = stepsOfPage(setup, module, uses).filter((step) => !step.optional && step.state !== "ready");
  if (left.length === 0) return null;
  const names = left.map((step) => step.label).join(", ");
  // Tout est renseigné, seul un test manque (module construit par l’agent, compte modifié) : un clic suffit.
  if (left.every((step) => step.state === "untested")) {
    return (
      <FeedbackBanner
        tone="info"
        appearance="bar"
        action={
          <Button
            loading={checking}
            onClick={() => {
              setChecking(true);
              void verify(left)
                .catch(() => undefined)
                .finally(() => {
                  setChecking(false);
                  void load();
                });
            }}
          >
            Vérifier
          </Button>
        }
      >
        La connexion à {names} n’a pas encore été vérifiée.
      </FeedbackBanner>
    );
  }
  // Une partie du module marche déjà : on dit seulement ce qui manque, sans alarmer.
  const usable = setup.steps.some((step) => step.state === "ready");
  return (
    <FeedbackBanner
      tone={usable ? "info" : "warning"}
      appearance="bar"
      action={<Button onClick={() => openModuleSetup(module)}>Configurer</Button>}
    >
      {left.length === 1 ? `${names} n’est pas encore configuré` : `${names} ne sont pas encore configurés`} : ce qui en
      dépend reste vide pour l’instant.
    </FeedbackBanner>
  );
}

/**
 * Bouton de la barre d’une page, à côté de la cible et de l’agent : ouvre la configuration du module quand un
 * service dont la page dépend n’est pas prêt. Absent sinon.
 */
export function SetupTool({ module, uses }: { module: string; uses?: Uses }) {
  const { of } = useModuleSetup();
  const setup = of(module);
  if (!setup || setup.ready) return null;
  const left = stepsOfPage(setup, module, uses).filter((step) => !step.optional && step.state !== "ready");
  if (left.length === 0) return null;
  return (
    <IconButton
      label={`Configurer ${left.map((step) => step.label).join(", ")}`}
      onClick={() => openModuleSetup(module)}
    >
      <PlugZap size={15} aria-hidden="true" />
    </IconButton>
  );
}
