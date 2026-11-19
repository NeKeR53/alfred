/**
 * Accueil au premier démarrage, quand aucun espace n’est connu : bienvenue, l’espace de travail, les modules d’un
 * marketplace, quelques réglages, puis le résumé. Il se relance depuis Réglages › Général (« Revoir l’accueil »).
 * Quand le dernier espace est fermé, `ShortWelcome` n’en garde que le choix de l’espace.
 */
import { Button, IconButton } from "@alfred/ui";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useHarnesses } from "../../features/agent/harness/installed";
import { PROVIDER_LABEL } from "../../features/agent/harness/types";
import { openOnboarding } from "../../features/setup/Onboarding";
import { ACCENT_LABEL } from "../../features/space/SpaceSettings";
import { SETTINGS_SECTION } from "../navigationLayout";
import { useShell } from "../store";
import { BasicsStep, harnessSummary } from "./BasicsStep";
import { ModulesStep } from "./ModulesStep";
import { SpaceChoice } from "./SpaceChoice";
import { closeWelcome, goToStep, useWelcome, WELCOME_STEPS, type WelcomeStep } from "./store";
import "./welcome.css";

const STEP_NUMBER: Partial<Record<WelcomeStep, number>> = { space: 1, modules: 2, basics: 3 };

function Frame({
  title,
  intro,
  step,
  children,
  onClose,
}: {
  title: string;
  intro?: ReactNode;
  step?: WelcomeStep;
  children: ReactNode;
  onClose?: () => void;
}) {
  const number = step ? STEP_NUMBER[step] : undefined;
  return (
    <main className="welcome">
      <section className="welcome__window" aria-labelledby="welcome-title">
        {number || onClose ? (
          <header className="welcome__header">
            <p className="welcome__step">{number ? `Étape ${number} sur 3` : null}</p>
            {onClose ? (
              <IconButton label="Fermer l’accueil" size="small" onClick={onClose}>
                <X size={14} aria-hidden="true" />
              </IconButton>
            ) : null}
          </header>
        ) : null}
        <h1 id="welcome-title">{title}</h1>
        {intro ? <p className="welcome__intro">{intro}</p> : null}
        {children}
      </section>
    </main>
  );
}

/** Pied d’un écran : les boutons secondaires à gauche, le seul bouton principal à droite. */
function Footer({ secondary, primary }: { secondary?: ReactNode; primary: ReactNode }) {
  return (
    <footer className="welcome__footer">
      <div className="welcome__secondary">{secondary}</div>
      {primary}
    </footer>
  );
}

const next = (step: WelcomeStep) => WELCOME_STEPS[WELCOME_STEPS.indexOf(step) + 1] ?? "ready";
const previous = (step: WelcomeStep) => WELCOME_STEPS[WELCOME_STEPS.indexOf(step) - 1] ?? "hello";

function BackButton({ step }: { step: WelcomeStep }) {
  return (
    <Button variant="subtle" onClick={() => goToStep(previous(step))}>
      Retour
    </Button>
  );
}

function LaterButton({ step }: { step: WelcomeStep }) {
  return (
    <Button variant="subtle" onClick={() => goToStep(next(step))}>
      Plus tard
    </Button>
  );
}

function listNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

/** « Ouvrir Alfred » : le parcours se ferme ; le premier module importé enchaîne sur sa configuration. */
function finish() {
  const { imported } = useWelcome.getState();
  closeWelcome();
  const first = imported[0];
  if (first) {
    useShell.getState().setActiveTab(SETTINGS_SECTION, "modules");
    openOnboarding(first.id, "intro");
  }
}

function ReadyStep() {
  const snapshot = useShell((state) => state.snapshot);
  const theme = useShell((state) => (state.themeFollowsSystem ? "system" : state.theme));
  const imported = useWelcome((state) => state.imported);
  const probes = useHarnesses((state) => state.probes);
  const agents = harnessSummary(probes);
  const themeLabel = theme === "system" ? "comme votre ordinateur" : theme === "dark" ? "sombre" : "clair";
  const accent = snapshot?.accent ? ACCENT_LABEL[snapshot.accent as keyof typeof ACCENT_LABEL] : null;
  const names = imported.map((module) => module.name);

  return (
    <Frame title="C’est prêt" intro="Voici ce que nous avons mis en place. Tout se change ensuite dans les Réglages.">
      <dl className="welcome-summary">
        <div>
          <dt>Espace</dt>
          <dd>
            {snapshot ? (
              <>
                « {snapshot.name} »<span className="welcome-summary__path">{snapshot.path}</span>
              </>
            ) : (
              "Aucun"
            )}
          </dd>
        </div>
        <div>
          <dt>Modules</dt>
          <dd>
            {names.length === 0
              ? "Aucun pour l’instant. Vous en trouverez dans Réglages › Marketplace."
              : `${listNames(names)} ${names.length > 1 ? "sont importés" : "est importé"}.`}
          </dd>
        </div>
        <div>
          <dt>Apparence</dt>
          <dd>
            Thème {themeLabel}
            {accent ? `, accent ${accent.toLocaleLowerCase("fr")}` : ""}.
          </dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            {agents.connected.length > 0
              ? `${listNames(agents.connected.map((provider) => PROVIDER_LABEL[provider]))}, ${agents.connected.length > 1 ? "prêts" : "prêt"} à travailler.`
              : agents.installed.length > 0
                ? `${listNames(agents.installed.map((provider) => PROVIDER_LABEL[provider]))}, à connecter dans un terminal.`
                : "Aucun pour l’instant. Je le détecterai dès qu’il sera installé."}
          </dd>
        </div>
      </dl>
      {names.length > 0 ? (
        <p className="welcome__intro">
          {names.length > 1
            ? `En ouvrant Alfred, je vous guide pour configurer ${names[0]}. ${listNames(names.slice(1))} ${names.length > 2 ? "attendent" : "attend"} dans Réglages › Modules.`
            : `En ouvrant Alfred, je vous guide pour configurer ${names[0]}.`}
        </p>
      ) : null}
      <Footer
        secondary={<BackButton step="ready" />}
        primary={
          <Button variant="primary" onClick={finish} autoFocus>
            Ouvrir Alfred
          </Button>
        }
      />
    </Frame>
  );
}

/** Le parcours complet, du premier démarrage ou relancé depuis les Réglages. */
export function Accueil() {
  const step = useWelcome((state) => state.step);
  const active = useWelcome((state) => state.active);
  const replay = useWelcome((state) => state.replay);
  const snapshot = useShell((state) => state.snapshot);
  const startupError = useShell((state) => state.startupError);

  // Premier démarrage : le parcours reste affiché une fois l’espace ouvert, jusqu’à « Ouvrir Alfred ».
  useEffect(() => {
    if (!active) useWelcome.setState({ active: true });
  }, [active]);

  // Sans espace ouvert, les étapes suivantes n’ont rien où écrire : retour au choix de l’espace.
  const lost = !snapshot && (step === "modules" || step === "basics");
  useEffect(() => {
    if (lost) goToStep("space");
  }, [lost]);

  const onClose = replay ? closeWelcome : undefined;

  if (step === "hello") {
    return (
      <Frame
        title="Bonjour, je suis Alfred"
        intro="Je vous aide à assembler votre propre application : des pages, des outils et des réglages, rangés dans un dossier à vous. Nous allons la préparer ensemble en trois étapes."
        onClose={onClose}
      >
        {startupError ? (
          <p className="welcome-meta welcome-meta--danger" role="alert">
            {startupError}
          </p>
        ) : null}
        <Footer
          primary={
            <Button variant="primary" onClick={() => goToStep("space")} autoFocus>
              Commencer
            </Button>
          }
        />
      </Frame>
    );
  }

  if (step === "space") {
    return (
      <Frame
        title="Votre espace de travail"
        intro="C’est le dossier où je range tout ce que nous mettons en place. Vous pourrez en avoir plusieurs."
        step="space"
        onClose={onClose}
      >
        <SpaceChoice
          onOpened={() => goToStep("modules")}
          extraChoice={
            snapshot
              ? {
                  title: `Garder « ${snapshot.name} »`,
                  description: "L’espace ouvert en ce moment.",
                  submitLabel: "Continuer",
                  onSubmit: () => goToStep("modules"),
                }
              : undefined
          }
          footer={(primary) => <Footer secondary={<BackButton step="space" />} primary={primary} />}
        />
      </Frame>
    );
  }

  if (lost) return null;

  if (step === "modules") {
    return (
      <Frame
        title="Vos modules"
        intro="Les modules ajoutent des pages toutes faites : suivi de projets, tickets, déploiements… Ils viennent d’un marketplace, un dépôt git que votre équipe partage."
        step="modules"
        onClose={onClose}
      >
        <ModulesStep
          onDone={() => goToStep("basics")}
          footer={(primary) => (
            <Footer
              secondary={
                <>
                  <BackButton step="modules" />
                  <LaterButton step="modules" />
                </>
              }
              primary={primary}
            />
          )}
        />
      </Frame>
    );
  }

  if (step === "basics") {
    return (
      <Frame
        title="Quelques réglages"
        intro="Chacun a déjà une valeur raisonnable : changez seulement ce qui vous importe."
        step="basics"
        onClose={onClose}
      >
        <BasicsStep
          footer={
            <Footer
              secondary={
                <>
                  <BackButton step="basics" />
                  <LaterButton step="basics" />
                </>
              }
              primary={
                <Button variant="primary" onClick={() => goToStep("ready")}>
                  Continuer
                </Button>
              }
            />
          }
        />
      </Frame>
    );
  }

  return <ReadyStep />;
}

/** Le dernier espace vient d’être fermé : seulement créer ou ouvrir un espace, avec les récents à portée de clic. */
export function ShortWelcome() {
  const recent = useShell((state) => state.recentSpaces);
  const openSpace = useShell((state) => state.openSpace);
  const startupError = useShell((state) => state.startupError);
  return (
    <Frame
      title="Quel espace ouvrir ?"
      intro="Aucun espace de travail n’est ouvert. Reprenez l’un des vôtres, ou créez-en un."
    >
      {startupError ? (
        <p className="welcome-meta welcome-meta--danger" role="alert">
          {startupError}
        </p>
      ) : null}
      <RecentList spaces={recent.slice(0, 5)} open={(path) => openSpace(path, undefined, { existing: true })} />
      <SpaceChoice footer={(primary) => <Footer primary={primary} />} />
    </Frame>
  );
}

function RecentList({
  spaces,
  open,
}: {
  spaces: Array<{ path: string; name: string }>;
  open: (path: string) => Promise<void>;
}) {
  if (spaces.length === 0) return null;
  return (
    <ul className="welcome-recents" aria-label="Vos espaces récents">
      {spaces.map((space) => (
        <RecentRow key={space.path} space={space} open={open} />
      ))}
    </ul>
  );
}

function RecentRow({ space, open }: { space: { path: string; name: string }; open: (path: string) => Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  return (
    <li>
      <div className="welcome-recents__text">
        <span className="welcome-recents__name">{space.name}</span>
        <span className="welcome-recents__path" title={space.path}>
          {space.path}
        </span>
        {state.error ? (
          <span className="welcome-meta--danger" role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
      <Button
        aria-label={`Ouvrir l’espace ${space.name}`}
        loading={state.busy}
        onClick={async () => {
          setState({ busy: true, error: null });
          try {
            await open(space.path);
          } catch (failure) {
            setState({ busy: false, error: failure instanceof Error ? failure.message : String(failure) });
          }
        }}
      >
        Ouvrir
      </Button>
    </li>
  );
}
