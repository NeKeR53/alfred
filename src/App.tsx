import { useEffect, useMemo } from "react";
import { AgentPage } from "./features/agent/AgentPage";
import { isAgentsWindow } from "./features/agent/agentsWindow";
import { checkHarnesses, useInstalledProviders } from "./features/agent/harness";
import { AgentPanel, bindPageAi } from "./features/agent/pageAgent";
import { useAgentSummary } from "./features/agent/summary";
import { UiFixTool } from "./features/agent/uiFix";
import { useModuleUpdates } from "./features/modules/useModuleUpdates";
import { CommandPalette } from "./features/palette/CommandPalette";
import { settingsTabs } from "./features/settings/tabs";
import { OnboardingHost } from "./features/setup/Onboarding";
import { AppShell } from "./shell/AppShell";
import { useAgentZone } from "./shell/agentZone";
import { PageWindow, pageWindowReference } from "./shell/PageWindow";
import { ShellServices } from "./shell/services";
import { useShell } from "./shell/store";
import { Accueil, ShortWelcome } from "./shell/welcome/Accueil";
import { useWelcome } from "./shell/welcome/store";

export function App() {
  const snapshot = useShell((state) => state.snapshot);
  const start = useShell((state) => state.start);
  const firstRun = useShell((state) => state.recentSpaces.length === 0);
  const welcoming = useWelcome((state) => state.active);
  useEffect(() => {
    bindPageAi();
    void start();
    // Quels agents sont installés : un agent absent n’est proposé nulle part.
    void checkHarnesses();
  }, [start]);
  const installed = useInstalledProviders();
  // L’entrée Agent n’apparaît qu’une fois la vérification faite, et seulement si un agent est installé.
  const agentAvailable = installed === null ? null : installed.length > 0;

  // Les mises à jour de modules disponibles se lisent sur l’onglet, sans ouvrir les Réglages.
  const updates = useModuleUpdates();
  const agentSummary = useAgentSummary();
  const agentZone = useAgentZone();
  const tabs = useMemo(
    () =>
      settingsTabs.map((tab) =>
        tab.id === "modules" && updates > 0 ? { ...tab, label: `Modules (${updates})` } : tab,
      ),
    [updates],
  );

  if (snapshot === undefined) return null;
  // Fenêtre Agent détachée : la page Agent seule ; ses conversations sont celles de la fenêtre principale.
  if (isAgentsWindow()) {
    return (
      <>
        <AgentPage detached />
        <ShellServices />
      </>
    );
  }
  // Fenêtre de page : la page seule, avec les demandes du backend (accès, fonctions) traitées ici aussi.
  const windowPage = pageWindowReference();
  if (windowPage) {
    return (
      <>
        <PageWindow
          reference={windowPage}
          renderAgentPanel={(conversation, close) => <AgentPanel conversationId={conversation} onClose={close} />}
          renderPageTools={(page, container) => <UiFixTool key={page.reference} page={page} container={container} />}
        />
        <ShellServices />
      </>
    );
  }
  // Accueil complet : au premier démarrage (aucun espace connu), ou relancé depuis Réglages › Général. Il reste
  // affiché après l’ouverture de l’espace, jusqu’à « Ouvrir Alfred ». Le dernier espace fermé : la version courte.
  if (welcoming || (snapshot === null && firstRun)) return <Accueil />;
  if (snapshot === null) return <ShortWelcome />;
  return (
    <>
      <AppShell
        agent={<AgentPage />}
        agentSummary={agentSummary}
        agentZone={agentZone}
        agentAvailable={agentAvailable}
        settingsTabs={tabs}
        renderAgentPanel={(conversation, close) => <AgentPanel conversationId={conversation} onClose={close} />}
        renderPageTools={(page, container) => <UiFixTool key={page.reference} page={page} container={container} />}
      />
      <ShellServices />
      <CommandPalette />
      <OnboardingHost />
    </>
  );
}
