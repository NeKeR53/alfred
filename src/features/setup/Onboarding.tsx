/**
 * Onboarding d’un module : un panneau à part, au-dessus de l’app, hors des Réglages. Il s’ouvre juste après l’import
 * d’un module, ou quand l’utilisateur lance la configuration d’un module (sa fiche, le bandeau d’une page). Il
 * présente le module, laisse nommer ses pages dans le menu, puis guide la connexion de chaque service.
 */
import { Dialog } from "@alfred/ui";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useShell } from "../../shell/store";
import type { ServiceEditing } from "../clients/ServiceEditor";
import { ServiceEditor } from "../clients/ServiceEditor";
import { useClients } from "../clients/useClients";
import { SetupFlow } from "./SetupFlow";
import { useModuleSetup } from "./useModuleSetup";
import "./setup.css";

interface OnboardingState {
  /** Module en cours de configuration, ou `null` quand le panneau est fermé. */
  module: string | null;
  /** `intro` juste après l’import ; `resume` pour reprendre à la première étape incomplète. */
  start: "intro" | "resume";
}

export const useOnboarding = create<OnboardingState>(() => ({ module: null, start: "resume" }));

/** Ouvre l’onboarding d’un module, au-dessus de ce qui est affiché. */
export function openOnboarding(module: string, start: "intro" | "resume" = "resume") {
  useOnboarding.setState({ module, start });
}

export function closeOnboarding() {
  useOnboarding.setState({ module: null });
}

/** Panneau de l’onboarding, monté une fois dans l’app ; rien tant qu’aucun module n’est en configuration. */
export function OnboardingHost() {
  const module = useOnboarding((state) => state.module);
  const start = useOnboarding((state) => state.start);
  if (!module) return null;
  return <OnboardingPanel key={`${module}:${start}`} module={module} start={start} />;
}

function OnboardingPanel({ module, start }: { module: string; start: "intro" | "resume" }) {
  const modules = useShell((state) => state.snapshot?.modules) ?? [];
  const snapshot = useShell((state) => state.snapshot);
  const services = useClients();
  const setups = useModuleSetup({ listen: false });
  const reload = setups.load;
  // Relu avec les services et l’espace de travail : ce sont eux qui font avancer la configuration.
  useEffect(() => {
    if (services.overview || snapshot) void reload();
  }, [services.overview, snapshot, reload]);
  const [editing, setEditing] = useState<ServiceEditing>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const firstSection =
    snapshot?.sections.find((section) => section.module === module && !section.hidden) ??
    snapshot?.sections.find((section) => section.module === module);
  const name = modules.find((candidate) => candidate.id === module)?.name ?? module;

  return (
    <Dialog
      ref={dialog}
      className="onboarding-panel"
      aria-label={`Configurer ${name}`}
      onCancel={(event) => {
        // Échap ferme le formulaire d’un service d’abord, puis le panneau.
        event.preventDefault();
        if (editing) setEditing(undefined);
        else closeOnboarding();
      }}
    >
      {editing ? (
        <div className="onboarding-panel__editor">
          <ServiceEditor
            editing={editing}
            redirectUri={services.overview?.redirectUri ?? null}
            onEdit={setEditing}
            onDone={() => {
              setEditing(undefined);
              void services.load();
            }}
          />
        </div>
      ) : (
        <SetupFlow
          setup={setups.of(module)}
          modules={modules}
          services={services}
          start={start}
          onEdit={setEditing}
          onClose={closeOnboarding}
          onOpenModule={
            firstSection
              ? () => {
                  closeOnboarding();
                  useShell.getState().setView({ kind: "section", id: firstSection.id });
                }
              : undefined
          }
        />
      )}
      {services.confirmDialog}
    </Dialog>
  );
}
