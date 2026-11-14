import { Button, EmptyState, IconButton, PageTopBar, SearchField, Tabs } from "@alfred/ui";
import {
  AppWindow,
  Bot,
  CircleCheck,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
} from "lucide-react";
import { type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { inTauri, openPageWindow } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { NamedIcon } from "./icons";
import { NotificationBell, NotificationToasts } from "./NotificationCenter";
import { anchorOf, announce, applyLayoutChange, type MenuAnchor, useNavigationEditor } from "./navigationEditing";
import { mergeVisibleOrder, pagesOf, reorderSections, reorderTabs, SETTINGS_SECTION } from "./navigationLayout";
import { notify } from "./notifications";
import { PageFrame } from "./PageFrame";
import { ResizablePanel } from "./ResizablePanel";
import { useShell, type View } from "./store";
import { useDragReorder } from "./useDragReorder";
import "./shell.css";

/** Affiche une conversation d’agent dans le panneau de droite ; `close` rend la place au panneau de la page. */
export type AgentPanelRenderer = (conversation: string, close: () => void) => ReactNode;

export interface BuiltInTab {
  id: string;
  label: string;
  render: () => ReactNode;
}

/** Contenu d’une page de l’espace : son cadre, ou l’état qui explique pourquoi il n’y a encore rien à afficher. */
function SpacePage({ page, kind, host }: { page: ResolvedPage; kind: "page" | "panel"; host?: string }) {
  if (page.missing) {
    return (
      <EmptyState
        title="Page en cours de création"
        description="L’agent n’a pas encore écrit le contenu de cette page."
        size={kind === "panel" ? "compact" : "default"}
      />
    );
  }
  return <PageFrame page={page} kind={kind} host={host} />;
}

/**
 * Corps d’une section : la page de l’onglet actif et, si elle en déclare un, son panneau de droite. Les Réglages
 * et la page Agent passent par le même gabarit avec leurs onglets intégrés.
 */
export function SectionView({
  title,
  sectionId,
  pages,
  builtIn = [],
  actions,
  renderAgentPanel,
  onPageMenu,
  variant = "section",
  waiting,
  detachable = true,
}: {
  title: string;
  sectionId: string;
  pages: ResolvedPage[];
  /** Section par instance qui attend encore une instance : ce qu’il faut faire, à la place des pages. */
  waiting?: string | null;
  /** Propose d’ouvrir la page affichée dans sa propre fenêtre (pas dans une fenêtre de page elle-même). */
  detachable?: boolean;
  builtIn?: BuiltInTab[];
  actions?: ReactNode;
  renderAgentPanel?: AgentPanelRenderer;
  /** Ouvre le menu d’un onglet de page de l’espace. */
  onPageMenu?: (reference: string, anchor: MenuAnchor, returnFocus: HTMLElement | null) => void;
  /** Réglages : les rubriques intégrées prennent la mise en page des Réglages de OneApp. */
  variant?: "section" | "settings";
}) {
  const activeTab = useShell((state) => state.activeTab[sectionId]);
  const setActiveTab = useShell((state) => state.setActiveTab);
  const panelHidden = useShell((state) => state.panelHidden);
  const togglePanel = useShell((state) => state.togglePanel);

  const visible = useMemo(() => pages.filter((page) => !page.hidden), [pages]);
  const sortable = useMemo(() => visible.map((page) => ({ id: page.reference, page })), [visible]);
  const drag = useDragReorder(
    sortable,
    (order, moved) =>
      applyLayoutChange((snapshot) => {
        const all = pagesOf(snapshot, sectionId).map((page) => page.reference);
        return reorderTabs(snapshot, sectionId, mergeVisibleOrder(all, order), moved);
      }),
    { axis: "horizontal", findTarget: (element) => tabTarget(element) },
  );
  const tabs = useMemo(
    () => [
      ...builtIn.map((tab) => ({ id: tab.id, label: tab.label })),
      ...drag.orderedItems.map(({ id, page }) => ({
        id,
        label: page.title,
        content: (
          <span data-tab-ref={id} className={`shell-tab${drag.draggedId === id ? " is-dragging" : ""}`}>
            {page.title}
          </span>
        ),
      })),
    ],
    [builtIn, drag.orderedItems, drag.draggedId],
  );
  const activeId = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id;
  // L’onglet affiché par défaut est retenu : réordonner ou déplacer les onglets ne change pas la page ouverte.
  useEffect(() => {
    if (activeId && activeId !== activeTab) setActiveTab(sectionId, activeId);
  }, [activeId, activeTab, sectionId, setActiveTab]);
  const builtInTab = builtIn.find((tab) => tab.id === activeId);
  const page = visible.find((candidate) => candidate.reference === activeId);
  const panel = page?.panel && !page.panel.hidden ? page.panel : null;
  // Un agent lancé par la page prend la place de son panneau tant que sa conversation est ouverte.
  const agentConversation = useShell((state) => (page ? state.agentPanel[page.reference] : undefined));
  const closeAgentPanel = useShell((state) => state.closeAgentPanel);
  const hasPanel = Boolean(panel) || Boolean(agentConversation);
  const panelVisible = hasPanel ? !panelHidden[page?.reference ?? ""] : false;

  return (
    <>
      <PageTopBar
        title={title}
        panelToggle={
          hasPanel && page
            ? {
                hidden: !panelVisible,
                onToggle: () => togglePanel(page.reference),
                subject: agentConversation ? "la conversation avec l’agent" : `le panneau « ${panel?.title ?? ""} »`,
              }
            : undefined
        }
      >
        {tabs.length > 1 && activeId ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: les onglets portent eux-mêmes le clavier ; ce conteneur relaie le glissement et le menu de chaque onglet.
          <div
            className="shell-tabs"
            onPointerDown={(event) => {
              const target = event.target instanceof Element ? tabTarget(event.target) : undefined;
              const tab = target?.element.closest<HTMLElement>('[role="tab"]');
              if (target && tab && sortable.some((item) => item.id === target.id))
                drag.startDrag(event, target.id, tab);
            }}
            onContextMenu={(event) => {
              const target = event.target instanceof Element ? tabTarget(event.target) : undefined;
              if (!target || !onPageMenu) return;
              event.preventDefault();
              onPageMenu(target.id, { x: event.clientX, y: event.clientY }, target.element.closest("button"));
            }}
            onKeyDownCapture={(event) => {
              const target = event.target instanceof Element ? tabTarget(event.target) : undefined;
              if (!target) return;
              const tab = target.element.closest<HTMLElement>('[role="tab"]');
              if (isMenuKey(event) && onPageMenu && tab) {
                event.preventDefault();
                event.stopPropagation();
                onPageMenu(target.id, anchorOf(tab), tab);
                return;
              }
              if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                event.preventDefault();
                event.stopPropagation();
                if (!drag.moveItem(target.id, event.key === "ArrowLeft" ? -1 : 1))
                  announceEdge(event.key === "ArrowLeft" ? "premier" : "dernier");
                refocus(`[data-tab-ref="${CSS.escape(target.id)}"]`, (element) => element.closest("button"));
              }
            }}
          >
            <Tabs
              label={`Onglets de ${title}`}
              className="shell-tabs__list choice-segmented"
              tabClassName="shell-tabs__tab"
              items={tabs}
              activeId={activeId}
              onChange={(id) => setActiveTab(sectionId, id)}
            />
          </div>
        ) : null}
        {actions}
        {detachable && inTauri && page && !builtInTab && !waiting ? (
          <IconButton
            label="Ouvrir dans une nouvelle fenêtre"
            onClick={() =>
              void openPageWindow(page.reference).catch((error: unknown) =>
                notify({
                  title: "La fenêtre n’a pas pu s’ouvrir",
                  description: error instanceof Error ? error.message : String(error),
                  tone: "error",
                }),
              )
            }
          >
            <AppWindow size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <NotificationBell />
      </PageTopBar>
      <div
        className={`workspace-body shell-body${variant === "settings" && builtInTab ? " shell-body--settings" : ""}`}
      >
        <div className="shell-body__main">
          {builtInTab ? (
            builtInTab.render()
          ) : waiting ? (
            <EmptyState title="En attente d’une instance" description={waiting}>
              <Button
                onClick={() => {
                  useShell.getState().setView({ kind: "settings" });
                  useShell.getState().setActiveTab(SETTINGS_SECTION, "clients");
                }}
              >
                Ouvrir les clients
              </Button>
            </EmptyState>
          ) : page ? (
            <SpacePage key={page.reference} page={page} kind="page" />
          ) : (
            <EmptyState title="Section vide" description="Demander à l’agent d’y créer une page." />
          )}
        </div>
        {waiting ? null : page && panelVisible && agentConversation && renderAgentPanel ? (
          <ResizablePanel storageKey="shell.panelWidth" label="Conversation avec l’agent">
            {renderAgentPanel(agentConversation, () => closeAgentPanel(page.reference))}
          </ResizablePanel>
        ) : panel && page && panelVisible ? (
          <ResizablePanel storageKey="shell.panelWidth" label={panel.title}>
            <SpacePage key={panel.reference} page={panel} kind="panel" host={page.reference} />
          </ResizablePanel>
        ) : null}
      </div>
    </>
  );
}

function NavButton({
  active,
  label,
  onClick,
  children,
  className = "",
  badge,
  glyph = false,
  ...props
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  /** Pastille à droite du libellé, ou sur l’icône quand le menu est replié. */
  badge?: AgentSummary;
  /** Icône posée dans un cadre fixe (entrée Agent), qui porte aussi la pastille du menu replié. */
  glyph?: boolean;
} & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onKeyDown" | "onContextMenu" | "onPointerDown" | "aria-keyshortcuts"
>) {
  const collapsed = useShell((state) => state.sidebarCollapsed);
  return (
    <IconButton
      {...props}
      appearance="navigation"
      label={label}
      tooltip={collapsed ? label : false}
      tooltipPlacement="right"
      className={`${className}${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {glyph ? (
        <span className="sidebar-product__glyph">
          {children}
          {badge && collapsed ? <AgentsBadge summary={badge} collapsed /> : null}
        </span>
      ) : (
        children
      )}
      <span className="sidebar__label">{badge ? label.split(" · ")[0] : label}</span>
      {badge && !collapsed ? (
        <span className="sidebar-orchestrator__badge">
          <AgentsBadge summary={badge} collapsed={false} />
        </span>
      ) : null}
    </IconButton>
  );
}

/** État résumé des conversations de l’agent, affiché en pastille sur l’entrée Agent du menu. */
export interface AgentSummary {
  state: "attention" | "working" | "done";
  count: number;
}

/** Pastille de l’entrée Agent, reprise de celle des agents de OneApp. */
function AgentsBadge({ summary, collapsed }: { summary: AgentSummary; collapsed: boolean }) {
  return (
    <span
      className={`product-agents__badge product-agents__badge--${summary.state}${collapsed ? " is-collapsed" : ""}`}
      aria-hidden="true"
    >
      {summary.state === "attention" ? (
        <span className="product-agents__mark">?</span>
      ) : summary.state === "working" ? (
        <LoaderCircle className="is-spinning" size={10} aria-hidden="true" />
      ) : (
        <CircleCheck size={10} aria-hidden="true" />
      )}
      {summary.count}
    </span>
  );
}

const AGENT_STATE_LABEL: Record<AgentSummary["state"], (count: number) => string> = {
  attention: (count) => `${count} réponse${count > 1 ? "s" : ""} attendue${count > 1 ? "s" : ""}`,
  working: (count) => `${count} conversation${count > 1 ? "s" : ""} en cours`,
  done: (count) => `${count} à consulter`,
};

const shortcutLabel = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

/** Comparaison sans casse ni accents, comme la palette de commandes. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

/** Touche Menu ou Maj+F10 : ouvre le menu contextuel de l’élément qui a le focus. */
const isMenuKey = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

/** Onglet de page de l’espace sous un élément : son identifiant et le libellé qui le porte. */
function tabTarget(element: Element): { id: string; element: HTMLElement } | undefined {
  const tab = element.closest('[role="tab"]');
  const label = tab?.querySelector<HTMLElement>("[data-tab-ref]");
  const id = label?.dataset.tabRef;
  return label && id ? { id, element: label } : undefined;
}

/** Un élément déplacé dans le DOM perd le focus : il le retrouve une fois l’ordre affiché. */
function refocus(selector: string, pick: (element: HTMLElement) => HTMLElement | null = (element) => element) {
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(selector);
    const target = element ? pick(element) : null;
    if (target && document.activeElement !== target) target.focus();
  });
}

function announceEdge(edge: "premier" | "dernier") {
  announce(`Déjà en ${edge === "premier" ? "première" : "dernière"} position.`);
}

const sameView = (left: View, right: View) =>
  left.kind === right.kind && (left.kind !== "section" || (right.kind === "section" && left.id === right.id));

export function AppShell({
  agent,
  settingsTabs,
  renderAgentPanel,
  agentSummary,
}: {
  /** Contenu de la page Agent. */
  agent: ReactNode;
  /** Conversations qui attendent l’utilisateur, travaillent ou sont à lire. */
  agentSummary?: AgentSummary;
  /** Onglets intégrés des Réglages ; les pages de l’espace placées dans les Réglages s’y ajoutent. */
  settingsTabs: BuiltInTab[];
  renderAgentPanel?: AgentPanelRenderer;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const view = useShell((state) => state.view);
  const setView = useShell((state) => state.setView);
  const collapsed = useShell((state) => state.sidebarCollapsed);
  const toggleSidebar = useShell((state) => state.toggleSidebar);
  const editor = useNavigationEditor();
  const [query, setQuery] = useState("");
  const folded = fold(query.trim());
  const matches = (label: string) => !folded || fold(label).includes(folded);
  const sections = useMemo(
    () =>
      (snapshot?.sections ?? []).filter((section) => !section.hidden).map((section) => ({ id: section.id, section })),
    [snapshot],
  );
  const drag = useDragReorder(sections, (order, moved) =>
    applyLayoutChange((current) =>
      reorderSections(
        current,
        mergeVisibleOrder(
          current.sections.map((section) => section.id),
          order,
        ),
        moved,
      ),
    ),
  );
  if (!snapshot) return null;

  const current = view.kind === "section" ? sections.find(({ section }) => section.id === view.id)?.section : undefined;
  const effective: View = view.kind === "section" && !current ? { kind: "agent" } : view;

  return (
    <div className={`app-shell${collapsed ? " app-shell--sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Navigation principale">
        <IconButton
          appearance="navigation"
          className="sidebar__toggle"
          label={collapsed ? "Déployer la navigation" : "Replier la navigation"}
          tooltipPlacement="right"
          aria-expanded={!collapsed}
          onClick={toggleSidebar}
        >
          {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          <span className="sidebar__label sidebar__brand" aria-hidden="true">
            {snapshot.name}
          </span>
        </IconButton>
        <div className="sidebar__catalog-controls">
          <SearchField
            className="sidebar__search"
            label="Rechercher une section dans la navigation"
            placeholder={`Rechercher… · ${shortcutLabel}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
          />
        </div>
        <nav aria-label="Sections de l’espace">
          {sections.length > 0 ? <p className="sidebar__section">Espace</p> : null}
          {drag.orderedItems.map(({ section }) => {
            if (!matches(section.label)) return null;
            const selector = `[data-sortable-scope="${drag.scopeId}"][data-sortable-id="${CSS.escape(section.id)}"]`;
            const dropping = drag.dropTarget?.id === section.id ? ` is-drop-${drag.dropTarget.placement}` : "";
            return (
              <div
                className={`sidebar-product${drag.draggedId === section.id ? " is-dragging" : ""}${dropping}${editor.menuOpenFor === section.id ? " is-menu-open" : ""}`}
                key={section.id}
                data-sortable-scope={drag.scopeId}
                data-sortable-id={section.id}
              >
                <NavButton
                  label={section.label}
                  active={sameView(effective, { kind: "section", id: section.id })}
                  onClick={() => setView({ kind: "section", id: section.id })}
                  className={`product-nav product-color--${section.color ?? "steel"}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Shift+F10"
                  onPointerDown={(event) => {
                    const row = event.currentTarget.closest<HTMLElement>(".sidebar-product");
                    if (row) drag.startDrag(event, section.id, row);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    editor.openSectionMenu(section.id, { x: event.clientX, y: event.clientY }, event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (isMenuKey(event)) {
                      event.preventDefault();
                      editor.openSectionMenu(section.id, anchorOf(event.currentTarget), event.currentTarget);
                    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                      event.preventDefault();
                      if (!drag.moveItem(section.id, event.key === "ArrowUp" ? -1 : 1))
                        announceEdge(event.key === "ArrowUp" ? "premier" : "dernier");
                      refocus(selector, (element) => element.querySelector("button"));
                    }
                  }}
                >
                  <NamedIcon name={section.icon} />
                </NavButton>
                <div className="sidebar-product__actions">
                  <IconButton
                    size="small"
                    label={`Actions de la section ${section.label}`}
                    tooltip={editor.menuOpenFor === section.id ? false : "Plus"}
                    aria-haspopup="menu"
                    aria-expanded={editor.menuOpenFor === section.id}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      editor.openSectionMenu(section.id, { x: rect.left, y: rect.bottom + 4 }, event.currentTarget);
                    }}
                  >
                    <MoreHorizontal size={16} aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            );
          })}
          {sections.length > 0 && !sections.some(({ section }) => matches(section.label)) ? (
            <p className="sidebar__empty">Aucune section trouvée.</p>
          ) : null}
        </nav>
        <NavButton
          label={agentSummary ? `Agent · ${AGENT_STATE_LABEL[agentSummary.state](agentSummary.count)}` : "Agent"}
          active={sameView(effective, { kind: "agent" })}
          onClick={() => setView({ kind: "agent" })}
          className="sidebar-orchestrator"
          badge={agentSummary}
          glyph
        >
          <Bot size={16} aria-hidden="true" />
        </NavButton>
        <NavButton
          label="Réglages"
          active={sameView(effective, { kind: "settings" })}
          onClick={() => setView({ kind: "settings" })}
          className="sidebar-settings"
        >
          <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
        </NavButton>
      </aside>
      <main className="workspace">
        {effective.kind === "agent" ? agent : null}
        {effective.kind === "section" && current ? (
          <SectionView
            key={current.id}
            title={current.label}
            sectionId={current.id}
            pages={current.pages}
            waiting={current.waiting}
            renderAgentPanel={renderAgentPanel}
            onPageMenu={editor.openPageMenu}
          />
        ) : null}
        {effective.kind === "settings" ? (
          <SectionView
            title="Réglages"
            sectionId={SETTINGS_SECTION}
            pages={snapshot.settingsPages}
            builtIn={settingsTabs}
            onPageMenu={editor.openPageMenu}
            variant="settings"
          />
        ) : null}
      </main>
      {editor.elements}
      <NotificationToasts />
    </div>
  );
}
