import { EmptyState } from "@alfred/ui";
import { useEffect } from "react";
import { type AgentPanelRenderer, type PageToolsRenderer, SectionView } from "./AppShell";
import { NotificationToasts } from "./NotificationCenter";
import { findPage } from "./navigationLayout";
import { pageWindowParams } from "./pageWindowMode";
import { useShell } from "./store";

export { pageWindowReference } from "./pageWindowMode";

/**
 * Coquille d’une fenêtre de page : la page et son panneau, sans le menu de l’espace. Elle suit le même espace que
 * la fenêtre principale, et dit pourquoi elle est vide si la page en a disparu.
 */
export function PageWindow({
  reference,
  renderAgentPanel,
  renderPageTools,
}: {
  reference: string;
  renderAgentPanel?: AgentPanelRenderer;
  renderPageTools?: PageToolsRenderer;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const found = snapshot ? findPage(snapshot, reference) : undefined;
  // Fenêtre ouverte sur une entrée du menu : la page la lit dans `usePageContext().entry`, comme dans la principale.
  useEffect(() => {
    const entry = pageWindowParams()?.entry as { id?: unknown; label?: unknown; zone?: unknown } | undefined;
    if (!entry || typeof entry.id !== "string") return;
    const label = typeof entry.label === "string" ? entry.label : entry.id;
    const zone = typeof entry.zone === "string" ? entry.zone : reference;
    useShell.setState((state) => ({
      activeEntry: { ...state.activeEntry, [reference]: { id: entry.id as string, label, zone } },
    }));
  }, [reference]);
  return (
    <div className="app-shell app-shell--page-window">
      <main className="workspace">
        {found ? (
          <SectionView
            title={found.page.title}
            sectionId={`fenêtre:${reference}`}
            pages={[found.page]}
            waiting={found.section?.waiting}
            detachable={false}
            renderAgentPanel={renderAgentPanel}
            renderPageTools={renderPageTools}
          />
        ) : (
          <EmptyState
            title="Page introuvable"
            description={
              snapshot
                ? "Cette page n’est plus dans la navigation de l’espace de travail ouvert. Vous pouvez fermer cette fenêtre."
                : "Aucun espace de travail n’est ouvert. Ouvrez-en un dans la fenêtre principale d’Alfred."
            }
          />
        )}
      </main>
      <NotificationToasts />
    </div>
  );
}
