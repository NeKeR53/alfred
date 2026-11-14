import { useEffect, useMemo } from "react";
import { AgentPage } from "./features/agent/AgentPage";
import { AgentPanel, bindPageAi } from "./features/agent/pageAgent";
import { useAgentSummary } from "./features/agent/summary";
import { UiFixTool } from "./features/agent/uiFix";
import { useModuleUpdates } from "./features/modules/useModuleUpdates";
import { CommandPalette } from "./features/palette/CommandPalette";
import { settingsTabs } from "./features/settings/tabs";
import { AppShell } from "./shell/AppShell";
import { ShellServices } from "./shell/services";
import { useShell } from "./shell/store";
import { Welcome } from "./shell/Welcome";

export function App() {
  const snapshot = useShell((state) => state.snapshot);
  const start = useShell((state) => state.start);
  useEffect(() => {
    bindPageAi();
    void start();
  }, [start]);

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
  if (snapshot === null) return <Welcome />;
  return (
    <>
      <AppShell
        agent={<AgentPage />}
        agentSummary={agentSummary}
        settingsTabs={tabs}
        renderAgentPanel={(conversation, close) => <AgentPanel conversationId={conversation} onClose={close} />}
        renderPageTools={(page, container) => <UiFixTool key={page.reference} page={page} container={container} />}
      />
      <ShellServices />
      <CommandPalette />
    </>
  );
}
