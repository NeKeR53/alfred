import { FileText } from "lucide-react";
import { useEffect } from "react";
import { EmptyState, Sidebar, AppShell as SocleShell } from "socle-ui";
import { useSectionFrame } from "./AppShell";
import { findPage } from "./navigationLayout";
import { pageWindowParams } from "./pageWindowMode";
import { useShell } from "./store";
import type { AgentPanelRenderer, PageToolsRenderer } from "./types";

export { pageWindowReference } from "./pageWindowMode";

/**
 * Coquille d’une fenêtre de page : la page et son panneau, avec un menu réduit à la page elle-même. Elle suit le
 * même espace que la fenêtre principale, et dit pourquoi elle est vide si la page en a disparu.
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
  const frame = useSectionFrame({
    title: found?.page.title ?? "Page introuvable",
    sectionId: `fenêtre:${reference}`,
    pages: found ? [found.page] : [],
    waiting: found?.section?.waiting,
    detachable: false,
    renderAgentPanel,
    renderPageTools,
  });
  const sidebar = (
    <Sidebar
      selectedId={reference}
      onSelectionChange={() => undefined}
      account={<Sidebar.Account name="Alfred" onSettings={() => useShell.getState().setView({ kind: "settings" })} />}
    >
      <Sidebar.Item id={reference} icon={<FileText size={16} aria-hidden="true" />} label={frame.pageTitle} />
    </Sidebar>
  );
  return (
    <SocleShell
      sidebar={sidebar}
      pageTitle={frame.pageTitle}
      actions={frame.actions}
      detail={found ? frame.detail : undefined}
      detailExpandable
      history={false}
    >
      {found ? (
        frame.main
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
    </SocleShell>
  );
}
