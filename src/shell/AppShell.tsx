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
import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SetupGate } from "../features/setup/SetupGate";
import { SpaceSwitcher } from "../features/space/SpaceSwitcher";
import { inTauri, openPageWindow } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { badgeText, sectionCount, startBadges, useBadges } from "./badges";
import { NamedIcon } from "./icons";
import { NotificationBell, NotificationToasts } from "./NotificationCenter";
import { anchorOf, announce, applyLayoutChange, type MenuAnchor, useNavigationEditor } from "./navigationEditing";
import { mergeVisibleOrder, pagesOf, reorderSections, reorderTabs, SETTINGS_SECTION } from "./navigationLayout";
import { notify } from "./notifications";
import { PageFrame } from "./PageFrame";
import { ResizablePanel } from "./ResizablePanel";
import { SettingsModal } from "./SettingsModal";
import { useShell, type View } from "./store";
import { useDragReorder } from "./useDragReorder";
import "./shell.css";

/** Affiche une conversation d’agent dans le panneau de droite ; `close` rend la place au panneau de la page. */
export type AgentPanelRenderer = (conversation: string, close: () => void) => ReactNode;

/**
 * Outils de la barre du haut pour la page affichée (« Corriger un élément ») ; `container` est la zone de la page,
 * où l’outil peut poser un calque.
 */
export type PageToolsRenderer = (page: ResolvedPage, container: RefObject<HTMLDivElement | null>) => ReactNode;

export interface BuiltInTab {
  id: string;
  label: string;
  render: () => ReactNode;
  /** Réglages : icône de l’entrée dans la barre latérale. */
  icon?: ReactNode;
  /** Réglages : groupe de l’entrée ; un trait sépare deux groupes. */
  group?: string;
  /** Réglages : titre affiché au-dessus du groupe, porté par sa première entrée (« Espace de travail », « Alfred »). */
  groupTitle?: string;
}

/** Contenu d’une page de l’espace : son cadre, ou l’état qui explique pourquoi il n’y a encore rien à afficher. */
function SpacePage({ page, kind, host }: { page: ResolvedPage; kind: "page" | "panel"; host?: string }) {
  if (page.missing) {
    return (
      <EmptyState
        title="Page en cours de création"
        description="Je n’ai pas encore écrit le contenu de cette page."
        size={kind === "panel" ? "compact" : "default"}
      />
    );
  }
  // Tant qu’un service dont la page a besoin n’est pas prêt, la page d’attente remplace le cadre, qui n’est pas chargé.
  return (
    <SetupGate module={page.module} uses={page.uses} compact={kind === "panel"}>
      <PageFrame page={page} kind={kind} host={host} />
    </SetupGate>
  );
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
  renderPageTools,
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
  renderPageTools?: PageToolsRenderer;
  /** Ouvre le menu d’un onglet de page de l’espace. */
  onPageMenu?: (reference: string, anchor: MenuAnchor, returnFocus: HTMLElement | null) => void;
  /** Réglages : les rubriques intégrées prennent la mise en page des Réglages de OneApp. */
  variant?: "section" | "settings";
}) {
  const activeTab = useShell((state) => state.activeTab[sectionId]);
  const counts = useBadges((state) => state.counts);
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
            {counts[id] ? (
              <span className="shell-count" role="img" aria-label={countLabel(counts[id])}>
                {badgeText(counts[id])}
              </span>
            ) : null}
          </span>
        ),
      })),
    ],
    [builtIn, drag.orderedItems, drag.draggedId, counts],
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
  const main = useRef<HTMLDivElement>(null);

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
        {page && !builtInTab && renderPageTools ? renderPageTools(page, main) : null}
        <NotificationBell />
      </PageTopBar>
      <div
        className={`workspace-body shell-body${variant === "settings" && builtInTab ? " shell-body--settings" : ""}`}
      >
        <div ref={main} className="shell-body__main">
          {builtInTab ? (
            builtInTab.render()
          ) : waiting ? (
            <EmptyState title="En attente d’un compte" description={waiting}>
              <Button
                onClick={() => {
                  const shell = useShell.getState();
                  shell.setView({ kind: "settings" });
                  shell.setActiveTab(SETTINGS_SECTION, "modules");
                  // Ouvre la fiche du module de la section, où ses comptes se règlent.
                  shell.setActiveTab("réglages:module", sectionId.split("/")[0] ?? "");
                }}
              >
                Ajouter un compte
              </Button>
            </EmptyState>
          ) : page ? (
            <SpacePage key={page.reference} page={page} kind="page" />
          ) : (
            <EmptyState title="Section vide" description="Demandez-moi d’y créer une page." />
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
  count = 0,
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
  /** Compteur des pages de la section (`badge.set` du SDK), en pastille quand il dépasse zéro. */
  count?: number;
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
      label={count > 0 ? `${label} · ${countLabel(count)}` : label}
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
      {count > 0 ? (
        // Même pastille que celle des agents de OneApp : à place fixe, à gauche du bouton « … » de la ligne.
        collapsed ? (
          <span className="product-agents__badge is-collapsed sidebar-count" aria-hidden="true">
            {badgeText(count)}
          </span>
        ) : (
          <span className="sidebar-count" aria-hidden="true">
            <span className="product-agents__badge">{badgeText(count)}</span>
          </span>
        )
      ) : null}
      {badge && !collapsed ? (
        <span className="sidebar-orchestrator__badge">
          <AgentsBadge summary={badge} collapsed={false} />
        </span>
      ) : null}
    </IconButton>
  );
}

/** Compteur lu par un lecteur d’écran : « 3 nouveautés ». */
function countLabel(count: number) {
  return `${count} nouveauté${count > 1 ? "s" : ""}`;
}

/** État résumé des conversations de l’agent, affiché en pastille sur l’entrée Agent du menu. */
export interface AgentSummary {
  state: "attention" | "working" | "done";
  count: number;
  /** Réponses attendues, conversations au travail et à consulter : le libellé de l’entrée les cite toutes. */
  counts?: { attention: number; working: number; unread: number };
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

/**
 * Libellé de l’entrée Agent, comme celui de l’entrée Agents de OneApp : les réponses attendues, l’activité en cours,
 * puis les conversations à consulter, chacun s’il y a lieu.
 */
export function agentEntryLabel(summary: AgentSummary | undefined): string {
  if (!summary) return "Agent";
  const counts = summary.counts ?? {
    attention: summary.state === "attention" ? summary.count : 0,
    working: summary.state === "working" ? summary.count : 0,
    unread: summary.state === "done" ? summary.count : 0,
  };
  const plural = counts.attention > 1 ? "s" : "";
  return [
    "Agent",
    counts.attention ? `${counts.attention} réponse${plural} attendue${plural}` : "",
    counts.working ? "Activité en cours" : "",
    counts.unread ? `${counts.unread} à consulter` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

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
  renderPageTools,
  agentSummary,
  agentAvailable = true,
}: {
  /** Contenu de la page Agent. */
  agent: ReactNode;
  /**
   * Faux quand aucun agent (Claude Code, Codex, OpenCode) n’est installé : la page Agent laisse la place à la
   * première section, ou à un mot qui dit quoi installer. `null` pendant la vérification : l’entrée Agent reste cachée
   * et la page Agent attend, sans rien afficher, d’être confirmée ou remplacée.
   */
  agentAvailable?: boolean | null;
  /** Conversations qui attendent l’utilisateur, travaillent ou sont à lire. */
  agentSummary?: AgentSummary;
  /** Onglets intégrés des Réglages ; les pages de l’espace placées dans les Réglages s’y ajoutent. */
  settingsTabs: BuiltInTab[];
  renderAgentPanel?: AgentPanelRenderer;
  renderPageTools?: PageToolsRenderer;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const shown = useShell((state) => state.view);
  const behind = useShell((state) => state.behind);
  const settingsOpen = shown.kind === "settings";
  // Les Réglages s’ouvrent par-dessus : la vue d’où ils ont été ouverts reste affichée derrière.
  const view: View = settingsOpen ? behind : shown;
  const setView = useShell((state) => state.setView);
  const collapsed = useShell((state) => state.sidebarCollapsed);
  const toggleSidebar = useShell((state) => state.toggleSidebar);
  const editor = useNavigationEditor();
  const counts = useBadges((state) => state.counts);
  useEffect(() => startBadges(), []);
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
  const wanted: View = view.kind === "section" && !current ? { kind: "agent" } : view;
  // Sans agent installé, la page Agent n’existe pas : la première section s’affiche à sa place.
  const fallback = sections[0]?.section;
  const effective: View =
    wanted.kind === "agent" && agentAvailable === false && fallback ? { kind: "section", id: fallback.id } : wanted;
  const shownSection =
    effective.kind === "section" ? sections.find(({ section }) => section.id === effective.id)?.section : undefined;

  return (
    <div className={`app-shell${collapsed ? " app-shell--sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Navigation principale" inert={settingsOpen}>
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
        <nav aria-label="Sections de l’espace de travail">
          {sections.length > 0 ? <p className="sidebar__section">Espace de travail</p> : null}
          {drag.orderedItems.map(({ section }) => {
            if (!matches(section.label)) return null;
            const selector = `[data-sortable-scope="${drag.scopeId}"][data-sortable-id="${CSS.escape(section.id)}"]`;
            const dropping = drag.dropTarget?.id === section.id ? ` is-drop-${drag.dropTarget.placement}` : "";
            return (
              <div
                className={`sidebar-product${sectionCount(counts, section.pages) > 0 ? " has-count" : ""}${drag.draggedId === section.id ? " is-dragging" : ""}${dropping}${editor.menuOpenFor === section.id ? " is-menu-open" : ""}`}
                key={section.id}
                data-sortable-scope={drag.scopeId}
                data-sortable-id={section.id}
              >
                <NavButton
                  label={section.label}
                  count={sectionCount(counts, section.pages)}
                  active={!settingsOpen && sameView(effective, { kind: "section", id: section.id })}
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
        {agentAvailable === true ? (
          <NavButton
            label={agentEntryLabel(agentSummary)}
            active={!settingsOpen && sameView(effective, { kind: "agent" })}
            onClick={() => setView({ kind: "agent" })}
            className="sidebar-orchestrator"
            badge={agentSummary}
            glyph
          >
            <Bot size={16} aria-hidden="true" />
          </NavButton>
        ) : null}
        <NavButton
          label="Réglages"
          active={settingsOpen}
          onClick={() => setView({ kind: "settings" })}
          className="sidebar-settings"
        >
          <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
        </NavButton>
        <SpaceSwitcher />
      </aside>
      <main className="workspace" inert={settingsOpen}>
        {effective.kind === "agent" && agentAvailable !== null ? (
          agentAvailable ? (
            agent
          ) : (
            <div className="workspace__empty">
              <EmptyState
                title="Aucun agent installé"
                description="Alfred se construit en parlant à un agent. Installez Claude Code, Codex ou OpenCode sur ce poste et connectez-vous-y dans un terminal : il apparaîtra ici."
              >
                <Button
                  onClick={() => {
                    const shell = useShell.getState();
                    shell.setView({ kind: "settings" });
                    shell.setActiveTab(SETTINGS_SECTION, "agents");
                  }}
                >
                  Vérifier dans les Réglages
                </Button>
              </EmptyState>
            </div>
          )
        ) : null}
        {effective.kind === "section" && shownSection ? (
          <SectionView
            key={shownSection.id}
            title={shownSection.label}
            sectionId={shownSection.id}
            pages={shownSection.pages}
            waiting={shownSection.waiting}
            renderAgentPanel={renderAgentPanel}
            renderPageTools={renderPageTools}
            onPageMenu={editor.openPageMenu}
          />
        ) : null}
      </main>
      {settingsOpen ? (
        <SettingsModal
          tabs={settingsTabs}
          pages={snapshot.settingsPages}
          onPageMenu={editor.openPageMenu}
          onClose={() => useShell.getState().closeSettings()}
        />
      ) : null}
      {editor.elements}
      <NotificationToasts />
    </div>
  );
}
