/** Bandeau au-dessus des pages d’un module dont la configuration n’est pas terminée, avec de quoi la reprendre. */
import { Button, FeedbackBanner } from "@alfred/ui";
import { useState } from "react";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";
import { listClients, testClient } from "../clients/api";
import { type ModuleSetup, remainingSummary, SETUP_FOCUS } from "./api";
import { useModuleSetup } from "./useModuleSetup";

/** Ouvre les Réglages sur le parcours de configuration du module, à la première étape incomplète. */
export function openModuleSetup(module: string) {
  const shell = useShell.getState();
  shell.setView({ kind: "settings" });
  shell.setActiveTab(SETTINGS_SECTION, "modules");
  shell.setActiveTab(SETUP_FOCUS, module);
}

/** Teste les comptes prêts mais jamais testés des services qui manquent au module ; Alfred garde le résultat. */
async function verify(setup: ModuleSetup) {
  const wanted = new Set(setup.steps.filter((step) => step.state === "untested").map((step) => step.client));
  const { clients } = await listClients();
  for (const client of clients.filter((candidate) => wanted.has(candidate.id))) {
    for (const instance of client.instances.filter((item) => item.status === "ready" && !item.lastTest)) {
      await testClient(client.id, client.simple ? undefined : instance.id);
    }
  }
}

export function SetupBanner({ module }: { module: string }) {
  const { of, load } = useModuleSetup();
  const [checking, setChecking] = useState(false);
  const setup = of(module);
  if (!setup || setup.ready) return null;
  const left = setup.steps.filter((step) => !step.optional && step.state !== "ready");
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
              void verify(setup)
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
        La connexion à {left.map((step) => step.label).join(", ")} n’a pas encore été vérifiée.
      </FeedbackBanner>
    );
  }
  return (
    <FeedbackBanner
      tone="warning"
      appearance="bar"
      action={<Button onClick={() => openModuleSetup(module)}>Terminer la configuration</Button>}
    >
      {setup.name} n’est pas encore prêt : certaines données peuvent manquer. {remainingSummary(setup)}
    </FeedbackBanner>
  );
}
