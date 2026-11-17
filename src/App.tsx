import { useEffect, useMemo } from "react";
import { AgentPage } from "./features/agent/AgentPage";
import { checkHarnesses, useInstalledProviders } from "./features/agent/harness";
import { AgentPanel, bindPageAi } from "./features/agent/pageAgent";
import { useAgentSummary } from "./features/agent/summary";
import { UiFixTool } from "./features/agent/uiFix";
import { useModuleUpdates } from "./features/modules/useModuleUpdates";
import { CommandPalette } from "./features/palette/CommandPalette";
import { settingsTabs } from "./features/settings/tabs";
import { OnboardingHost } from "./features/setup/Onboarding";
import { SetupTool } from "./features/setup/SetupBanner";
import { AppShell } from "./shell/AppShell";
import { PageWindow, pageWindowReference } from "./shell/PageWindow";
import { ShellServices } from "./shell/services";
import { useShell } from "./shell/store";
import { Welcome } from "./shell/Welcome";

export function App() {
  const snapshot = useShell((state) => state.snapshot);
  const start = useShell((state) => state.start);
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
  const tabs = useMemo(
    () =>
      settingsTabs.map((tab) =>
        tab.id === "modules" && updates > 0 ? { ...tab, label: `Modules (${updates})` } : tab,
      ),
    [updates],
  );

  if (snapshot === undefined) return null;
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
  if (snapshot === null) return <Welcome />;
  return (
    <>
      <AppShell
        agent={<AgentPage />}
        agentSummary={agentSummary}
        agentAvailable={agentAvailable}
        settingsTabs={tabs}
        renderAgentPanel={(conversation, close) => <AgentPanel conversationId={conversation} onClose={close} />}
        renderPageTools={(page, container) => (
          <>
            <SetupTool module={page.module} uses={page.uses} />
            <UiFixTool key={page.reference} page={page} container={container} />
          </>
        )}
      />
      <ShellServices />
      <CommandPalette />
      <OnboardingHost />
    </>
  );
}
