import { EmptyState } from "@alfred/ui";
import { type AgentPanelRenderer, type PageToolsRenderer, SectionView } from "./AppShell";
import { NotificationToasts } from "./NotificationCenter";
import { findPage } from "./navigationLayout";
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
