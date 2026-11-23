/**
 * Onboarding d’un module : un panneau à part, au-dessus de l’app, hors des Réglages. Il s’ouvre juste après l’import
 * d’un module, ou quand l’utilisateur lance la configuration d’un module (sa fiche, la page d’attente d’une page). Il
 * présente le module, laisse choisir ses pages, puis guide, page par page, le choix ou la connexion de leurs comptes.
 */
import { useEffect } from "react";
import { Dialog } from "socle-ui";
import { create } from "zustand";
import { onNativeEvent } from "../../lib/native";
import { useShell } from "../../shell/store";
import { useClients } from "../clients/useClients";
import { SetupFlow } from "./SetupFlow";
import { useModuleSetup } from "./useModuleSetup";
import "./setup.css";

interface OnboardingState {
  /** Module en cours de configuration, ou `null` quand le panneau est fermé. */
  module: string | null;
  /** `intro` juste après l’import ; `resume` pour reprendre à la première étape incomplète. */
  start: "intro" | "resume";
  /** Étape (`module/besoin`) sur laquelle ouvrir le parcours, à la place de la reprise : celle d’une page qui attend. */
  step?: string;
}

export const useOnboarding = create<OnboardingState>(() => ({ module: null, start: "resume" }));

/**
 * Ouvre l’onboarding d’un module, au-dessus de ce qui est affiché ; `step` l’ouvre directement sur l’étape d’un
 * service (celui qui manque à une page).
 */
export function openOnboarding(module: string, start: "intro" | "resume" = "resume", step?: string) {
  useOnboarding.setState({ module, start, step });
}

export function closeOnboarding() {
  useOnboarding.setState({ module: null });
}

/** Panneau de l’onboarding, monté une fois dans l’app ; rien tant qu’aucun module n’est en configuration. */
export function OnboardingHost() {
  // L’agent ouvre l’onboarding d’un module quand il ne reste que ce que l’utilisateur seul peut faire.
  useEffect(
    () =>
      onNativeEvent("onboarding:open", (payload) => {
        const module = (payload as { module?: unknown } | null)?.module;
        if (typeof module === "string" && module) openOnboarding(module, "intro");
      }),
    [],
  );
  const module = useOnboarding((state) => state.module);
  const start = useOnboarding((state) => state.start);
  const step = useOnboarding((state) => state.step);
  if (!module) return null;
  return <OnboardingPanel key={`${module}:${start}:${step ?? ""}`} module={module} start={start} step={step} />;
}

function OnboardingPanel({ module, start, step }: { module: string; start: "intro" | "resume"; step?: string }) {
  const modules = useShell((state) => state.snapshot?.modules) ?? [];
  const snapshot = useShell((state) => state.snapshot);
  const services = useClients();
  const setups = useModuleSetup({ listen: false });
  const reload = setups.load;
  // Relu avec les comptes et l’espace de travail : ce sont eux qui font avancer la configuration.
  useEffect(() => {
    if (services.overview || snapshot) void reload();
  }, [services.overview, snapshot, reload]);
  const name = modules.find((candidate) => candidate.id === module)?.name ?? module;

  return (
    <Dialog
      isOpen
      size="xl"
      title={`Configurer ${name}`}
      onOpenChange={(open) => {
        if (!open) closeOnboarding();
      }}
    >
      <SetupFlow
        setup={setups.of(module)}
        modules={modules}
        services={services}
        start={start}
        step={step}
        onClose={closeOnboarding}
        onOpenSection={(id) => {
          closeOnboarding();
          useShell.getState().setView({ kind: "section", id });
        }}
      />
    </Dialog>
  );
}
