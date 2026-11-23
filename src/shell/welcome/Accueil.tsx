/**
 * Accueil au premier démarrage, quand aucun espace n’est connu : bienvenue, l’espace de travail, les modules d’un
 * marketplace, quelques réglages, puis le résumé. Il se relance depuis Réglages › Général (« Revoir l’accueil »).
 * Quand le dernier espace est fermé, `ShortWelcome` n’en garde que le choix de l’espace.
 */
import { FolderOpen, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Code, IconButton, List, ProgressIndicator, PropertyRow } from "socle-ui";
import { useHarnesses } from "../../features/agent/harness/installed";
import { PROVIDER_LABEL } from "../../features/agent/harness/types";
import { openOnboarding } from "../../features/setup/Onboarding";
import { ACCENT_LABEL } from "../../features/space/SpaceSettings";
import { Row, Stack, Text } from "../../kit";
import { SETTINGS_SECTION } from "../navigationLayout";
import { useShell } from "../store";
import { BasicsStep, harnessSummary } from "./BasicsStep";
import { ModulesStep } from "./ModulesStep";
import { SpaceChoice } from "./SpaceChoice";
import { closeWelcome, goToStep, useWelcome, WELCOME_STEPS, type WelcomeStep } from "./store";

/** Les trois étapes numérotées de l’accueil ; « Bonjour » et « C’est prêt » les encadrent. */
const NUMBERED_STEPS = [
  { id: "space", title: "Espace" },
  { id: "modules", title: "Modules" },
  { id: "basics", title: "Réglages" },
] as const;

/**
 * Écran centré, hors AppShell : Socle n’a pas de gabarit pour lui (LoginPage ne sert qu’à la connexion). Seuls le
 * fond, le panneau et le titre restent locaux ; le contenu est fait de composants Socle.
 */
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
  const numbered = NUMBERED_STEPS.some((item) => item.id === step);
  return (
    <main className="grid min-h-screen place-items-center overflow-y-auto bg-surface-side px-4 py-8 text-fg">
      <section
        className="flex w-full max-w-[600px] flex-col gap-4 rounded-lg border border-line bg-surface p-6 shadow-md"
        aria-labelledby="welcome-title"
      >
        {onClose ? (
          <Row justify="end">
            <IconButton icon={<X size={16} aria-hidden="true" />} label="Fermer l’accueil" onPress={onClose} />
          </Row>
        ) : null}
        {numbered && step ? (
          <ProgressIndicator label="Étapes de l’accueil" steps={NUMBERED_STEPS} current={step} />
        ) : null}
        <h1 id="welcome-title" className="m-0 font-semibold text-2xl">
          {title}
        </h1>
        {intro ? <Text tone="muted">{intro}</Text> : null}
        {children}
      </section>
    </main>
  );
}

/** Pied d’un écran : les boutons secondaires à gauche, le seul bouton principal à droite. */
function Footer({ secondary, primary }: { secondary?: ReactNode; primary: ReactNode }) {
  return (
    <div className="pt-2">
      <Row justify="between">
        <Row gap="xs">{secondary}</Row>
        {primary}
      </Row>
    </div>
  );
}

const next = (step: WelcomeStep) => WELCOME_STEPS[WELCOME_STEPS.indexOf(step) + 1] ?? "ready";
const previous = (step: WelcomeStep) => WELCOME_STEPS[WELCOME_STEPS.indexOf(step) - 1] ?? "hello";

function BackButton({ step }: { step: WelcomeStep }) {
  return (
    <Button variant="subtle" onPress={() => goToStep(previous(step))}>
      Retour
    </Button>
  );
}

function LaterButton({ step }: { step: WelcomeStep }) {
  return (
    <Button variant="subtle" onPress={() => goToStep(next(step))}>
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
      <Stack gap="none">
        <PropertyRow
          label="Espace"
          value={
            snapshot ? (
              <Stack gap="xs">
                <span>« {snapshot.name} »</span>
                <Code>{snapshot.path}</Code>
              </Stack>
            ) : (
              "Aucun"
            )
          }
        />
        <PropertyRow
          label="Modules"
          value={
            names.length === 0
              ? "Aucun pour l’instant. Vous en trouverez dans Réglages › Marketplace."
              : `${listNames(names)} ${names.length > 1 ? "sont importés" : "est importé"}.`
          }
        />
        <PropertyRow
          label="Apparence"
          value={`Thème ${themeLabel}${accent ? `, accent ${accent.toLocaleLowerCase("fr")}` : ""}.`}
        />
        <PropertyRow
          label="Agent"
          value={
            agents.connected.length > 0
              ? `${listNames(agents.connected.map((provider) => PROVIDER_LABEL[provider]))}, ${agents.connected.length > 1 ? "prêts" : "prêt"} à travailler.`
              : agents.installed.length > 0
                ? `${listNames(agents.installed.map((provider) => PROVIDER_LABEL[provider]))}, à connecter dans un terminal.`
                : "Aucun pour l’instant. Je le détecterai dès qu’il sera installé."
          }
        />
      </Stack>
      {names.length > 0 ? (
        <Text tone="muted">
          {names.length > 1
            ? `En ouvrant Alfred, je vous guide pour configurer ${names[0]}. ${listNames(names.slice(1))} ${names.length > 2 ? "attendent" : "attend"} dans Réglages › Modules.`
            : `En ouvrant Alfred, je vous guide pour configurer ${names[0]}.`}
        </Text>
      ) : null}
      <Footer
        secondary={<BackButton step="ready" />}
        primary={
          <Button variant="primary" onPress={finish} autoFocus>
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
        {startupError ? <Alert tone="danger">{startupError}</Alert> : null}
        <Footer
          primary={
            <Button variant="primary" onPress={() => goToStep("space")} autoFocus>
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
                <Button variant="primary" onPress={() => goToStep("ready")}>
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
      {startupError ? <Alert tone="danger">{startupError}</Alert> : null}
      <RecentList spaces={recent.slice(0, 5)} open={(path) => openSpace(path, undefined, { existing: true })} />
      <SpaceChoice footer={(primary) => <Footer primary={primary} />} />
    </Frame>
  );
}

/** Les espaces récents : une ligne par espace, « Ouvrir » au survol, Entrée ou double-clic ; un échec en encart. */
function RecentList({
  spaces,
  open,
}: {
  spaces: Array<{ path: string; name: string }>;
  open: (path: string) => Promise<void>;
}) {
  const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
  if (spaces.length === 0) return null;
  const openSpace = async (path: string) => {
    const space = spaces.find((item) => item.path === path);
    setFailure(null);
    try {
      await open(path);
    } catch (error) {
      setFailure({ name: space?.name ?? path, message: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <Stack gap="sm">
      {failure ? (
        <Alert tone="danger" title={`« ${failure.name} » ne s’est pas ouvert`} announce>
          {failure.message}
        </Alert>
      ) : null}
      <List
        label="Vos espaces récents"
        selectionMode="none"
        items={spaces.map((space) => ({ id: space.path, title: space.name, subtitle: space.path }))}
        onAction={(path) => void openSpace(path)}
        itemActions={(item) => [
          {
            icon: <FolderOpen size={16} aria-hidden="true" />,
            label: `Ouvrir l’espace ${item.title}`,
            onPress: () => void openSpace(item.id),
          },
        ]}
      />
    </Stack>
  );
}
