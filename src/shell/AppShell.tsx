/**
 * Coquille d’Alfred sur `AppShell` et `Sidebar` de socle-ui.
 *
 * - Menu de gauche : une entrée par section (icône, compteur, menu « … »), les entrées de zone de ses pages en
 *   sous-pages, puis les conversations de l’agent ; en pied, l’entrée Agent, l’espace de travail ouvert et le compte,
 *   qui ouvre les Réglages.
 * - Barre du haut : nom de la section, onglets de ses pages (vues), actions de la page (`ActionBar` zone `topbar`),
 *   outils de la coquille et cloche du centre de notifications. Le mode « données d’exemple » se dit par un encart en
 *   haut de la page (D-253).
 * - Panneau de droite : le panneau déclaré par la page, ou la conversation d’agent qu’elle a lancée.
 */
import { AppWindow, Bot, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  type Action,
  ActionBar,
  Button,
  EmptyState,
  IconButton,
  Menu,
  NotificationCenter,
  Sidebar,
  AppShell as SocleShell,
  type TabItem,
} from "socle-ui";
import { SetupGate } from "../features/setup/SetupGate";
import { spaceList, useSpaceActions } from "../features/space/spaceActions";
import { Notice } from "../kit";
import { inTauri, openPageWindow } from "../lib/native";
import type { ResolvedPage, ResolvedSection } from "../lib/types";
import { badgeText, sectionCount, startBadges, useBadges } from "./badges";
import { EXAMPLE_HINT, setExampleMode, useExampleMode } from "./examples";
import { NamedIcon, SectionIcon } from "./icons";
import type { ZoneRow } from "./MenuZone";
import { entryTarget, type MenuZone, orderedEntries, startMenuZones, useMenuZones } from "./menuZones";
import { useNavigationEditor } from "./navigationEditing";
import { SETTINGS_SECTION } from "./navigationLayout";
import { notify } from "./notifications";
import { PageFrame } from "./PageFrame";
import { openZoneEntry, runZoneAction } from "./PageZones";
import { SettingsModal } from "./SettingsModal";
import { useShell, type View } from "./store";
import { activateTopBarAction, type TopBarActionDescriptor, useTopBarActionStore } from "./topBarActions";
import type { AgentPanelRenderer, AgentSummary, AgentZone, BuiltInTab, PageToolsRenderer } from "./types";

export type { AgentPanelRenderer, AgentSummary, AgentZone, BuiltInTab, PageToolsRenderer } from "./types";

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

/** Compteur lu par un lecteur d’écran : « 3 nouveautés ». */
export function countLabel(count: number) {
  return `${count} nouveauté${count > 1 ? "s" : ""}`;
}

const windowError = (error: unknown) =>
  notify({
    title: "La fenêtre n’a pas pu s’ouvrir",
    description: error instanceof Error ? error.message : String(error),
    tone: "error",
  });

/** Icône Lucide nommée en PascalCase par le SDK (`Plus`, `RefreshCw`). */
function LucideIcon({ name }: { name: string }) {
  return <NamedIcon name={name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()} size={16} />;
}

/**
 * Actions de la page telles que le cadre les décrit, en `Action` de Socle : un clic revient au cadre par
 * l’identifiant de l’action, et c’est lui qui l’exécute (confirmation comprise). Une bascule de vue (`group`) devient
 * une action ordinaire ; la vue affichée est désactivée.
 */
export function frameActions(reference: string, list: readonly TopBarActionDescriptor[] | undefined): Action[] {
  return (list ?? []).map((action) => ({
    id: `frame:${action.id}`,
    label: action.group && action.selected ? `${action.label} (affichée)` : action.label,
    icon: action.icon ? <LucideIcon name={action.icon} /> : undefined,
    primary: action.primary,
    // Le cadre confirme lui-même ses actions destructrices : Socle ne les confirme pas une deuxième fois.
    isDisabled: action.disabled || action.running || (Boolean(action.group) && action.selected),
    onPress: () => activateTopBarAction(reference, action.id),
  }));
}

/**
 * Encart « données d’exemple » en haut d’une page de ce mode : il dit le mode et le quitte (D-253 : un état durable se
 * dit dans le contenu, par un encart local). Hors de ce mode, rien.
 */
export function ExampleNotice({ module }: { module: string }) {
  const examples = useExampleMode(module);
  if (!examples || !module) return null;
  return (
    <Notice
      title="Données d’exemple"
      action={
        <Button
          onPress={() =>
            void setExampleMode(module, false).catch((error: unknown) =>
              notify({
                title: "Les données d’exemple n’ont pas pu être quittées",
                description: error instanceof Error ? error.message : String(error),
                tone: "error",
              }),
            )
          }
        >
          Quitter les données d’exemple
        </Button>
      }
    >
      {EXAMPLE_HINT}.
    </Notice>
  );
}

/** Ce que la coquille montre pour une section : la barre du haut, la page, et son panneau de droite. */
export interface SectionFrame {
  pageTitle: string;
  views?: TabItem[];
  activeView?: string;
  onViewChange?: (id: string) => void;
  actions: ReactNode;
  detail?: ReactNode;
  main: ReactNode;
}

/**
 * Corps d’une section : les onglets de ses pages, la page de l’onglet actif et, si elle en déclare un, son panneau
 * de droite ; dans la fenêtre principale comme dans une fenêtre de page.
 */
export function useSectionFrame({
  title,
  sectionId,
  pages,
  builtIn = [],
  waiting: sectionWaiting,
  detachable = true,
  renderAgentPanel,
  renderPageTools,
  pageActions,
}: {
  title: string;
  sectionId: string;
  pages: ResolvedPage[];
  builtIn?: BuiltInTab[];
  /**
   * Section par instance qui attend encore une instance : ce qu’il faut faire, à la place de ses pages par compte
   * (une page commune de la section, `perInstance` nul, s’affiche).
   */
  waiting?: string | null;
  /** Propose d’ouvrir la page affichée dans sa propre fenêtre (pas dans une fenêtre de page elle-même). */
  detachable?: boolean;
  renderAgentPanel?: AgentPanelRenderer;
  renderPageTools?: PageToolsRenderer;
  /** Actions de la coquille sur la page affichée (renommer, déplacer…), dans le « … » de la barre du haut. */
  pageActions?: (reference: string) => Action[];
}): SectionFrame {
  const activeTab = useShell((state) => state.activeTab[sectionId]);
  const counts = useBadges((state) => state.counts);
  const setActiveTab = useShell((state) => state.setActiveTab);
  const visible = useMemo(() => pages.filter((page) => !page.hidden), [pages]);
  const views: TabItem[] = [
    ...builtIn.map((tab) => ({ id: tab.id, label: tab.label })),
    ...visible.map((page) => ({
      id: page.reference,
      label: counts[page.reference] ? `${page.title} (${badgeText(counts[page.reference])})` : page.title,
    })),
  ];
  const activeId = views.some((tab) => tab.id === activeTab) ? activeTab : views[0]?.id;
  // L’onglet affiché par défaut est retenu : réordonner ou déplacer les onglets ne change pas la page ouverte.
  useEffect(() => {
    if (activeId && activeId !== activeTab) setActiveTab(sectionId, activeId);
  }, [activeId, activeTab, sectionId, setActiveTab]);
  const builtInTab = builtIn.find((tab) => tab.id === activeId);
  const page = visible.find((candidate) => candidate.reference === activeId);
  const panel = page?.panel && !page.panel.hidden ? page.panel : null;
  // La page attend un compte (le sien, ou à défaut celui de sa section) : ce qu’il faut faire, à sa place.
  const waiting = page?.waiting ?? (sectionWaiting && page?.perInstance !== null ? sectionWaiting : null);
  // Un agent lancé par la page prend la place de son panneau tant que sa conversation est ouverte.
  const agentConversation = useShell((state) => (page ? state.agentPanel[page.reference] : undefined));
  const closeAgentPanel = useShell((state) => state.closeAgentPanel);
  const described = useTopBarActionStore((state) => (page ? state.actions[page.reference] : undefined));
  const main = useRef<HTMLDivElement>(null);
  const live = Boolean(page && !builtInTab && !waiting);

  const actions: Action[] = live && page ? [...frameActions(page.reference, described)] : [];
  if (live && page && pageActions) actions.push(...pageActions(page.reference));

  const body = builtInTab ? (
    builtInTab.render?.()
  ) : waiting ? (
    <EmptyState
      title="En attente d’un compte"
      description={waiting}
      action={
        <Button
          variant="primary"
          onPress={() => {
            const shell = useShell.getState();
            shell.setView({ kind: "settings" });
            shell.setActiveTab(SETTINGS_SECTION, "modules");
            // Ouvre la fiche du module de la section, où ses comptes se règlent.
            shell.setActiveTab("réglages:module", sectionId.split("/")[0] ?? "");
          }}
        >
          Ajouter un compte
        </Button>
      }
    />
  ) : page ? (
    <SpacePage key={page.reference} page={page} kind="page" />
  ) : (
    <EmptyState title="Section vide" description="Demandez-moi d’y créer une page." />
  );

  const detail =
    waiting || !page ? undefined : agentConversation && renderAgentPanel ? (
      renderAgentPanel(agentConversation, () => closeAgentPanel(page.reference))
    ) : panel ? (
      <SpacePage key={panel.reference} page={panel} kind="panel" host={page.reference} />
    ) : undefined;

  return {
    pageTitle: title,
    views: views.length > 1 ? views : undefined,
    activeView: activeId,
    onViewChange: (id) => setActiveTab(sectionId, id),
    actions: (
      <>
        {actions.length ? <ActionBar actions={actions} zone="topbar" subject={page?.title ?? title} /> : null}
        {detachable && inTauri && live && page ? (
          <IconButton
            icon={<AppWindow size={16} aria-hidden="true" />}
            label="Ouvrir dans une nouvelle fenêtre"
            onPress={() => {
              // Une entrée de zone ouverte suit la page dans sa fenêtre.
              const entry = useShell.getState().activeEntry[page.reference];
              void openPageWindow(
                page.reference,
                entry ? { params: { entry }, key: `entry:${entry.zone}:${entry.id}`, title: entry.label } : {},
              ).catch(windowError);
            }}
          />
        ) : null}
        {page && !builtInTab && renderPageTools ? renderPageTools(page, main) : null}
        <NotificationCenter />
      </>
    ),
    detail,
    main: (
      <div ref={main} className="flex h-full min-h-0 min-w-0 flex-col">
        {live && page ? (
          <div className="shrink-0 px-4 pt-3 empty:hidden">
            <ExampleNotice module={page.module} />
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
      </div>
    ),
  };
}

function agentCounts(summary: AgentSummary) {
  return (
    summary.counts ?? {
      attention: summary.state === "attention" ? summary.count : 0,
      working: summary.state === "working" ? summary.count : 0,
      unread: summary.state === "done" ? summary.count : 0,
    }
  );
}

/**
 * Libellé de l’entrée Agent : les réponses attendues, l’activité en cours, puis les conversations à consulter,
 * chacun s’il y a lieu.
 */
export function agentEntryLabel(summary: AgentSummary | undefined): string {
  if (!summary) return "Agent";
  const counts = agentCounts(summary);
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

/** Identifiants de la navigation : une section, une entrée de zone, l’agent ou une de ses conversations. */
const navId = {
  section: (id: string) => `section:${id}`,
  entry: (page: string, entry: string) => `entry:${page}\u0000${entry}`,
  agent: "agent",
  conversation: (id: string) => `agent:${id}`,
};

type Rename = (title: string, initial: string, apply: (value: string) => void) => void;

/** Une ligne de zone, en sous-page de la section : compteur, ou activité pour une entrée au travail. */
function zoneItem(id: string, row: ZoneRow, onAction: (action: string) => void) {
  const actions = (row.actions ?? []).slice(0, 2).map((action) => ({
    icon: <NamedIcon name={action.icon} size={14} />,
    label: `${action.label} ${row.label}`,
    onPress: () => onAction(action.id),
  }));
  return (
    <Sidebar.Item
      key={id}
      id={id}
      label={row.label}
      count={row.badge ? row.badge : undefined}
      indicator={!row.badge && (row.status === "running" || row.status === "waiting") ? "activity" : undefined}
      actions={actions.length ? actions : undefined}
    />
  );
}

/**
 * Entrée d’une section, avec les entrées de zone de ses pages visibles en sous-pages, dans l’ordre de ses onglets.
 * `Sidebar` lit les options de ses enfants directs : l’élément est rendu tel quel, sans composant intermédiaire.
 */
function sectionItem(
  section: ResolvedSection,
  {
    zones,
    counts,
    menu,
    rename,
  }: { zones: Record<string, MenuZone>; counts: Record<string, number>; menu: ReactNode; rename: Rename },
) {
  const entries = section.pages
    .filter((page) => !page.hidden && zones[page.reference]?.entries.length)
    .flatMap((page) =>
      orderedEntries(zones[page.reference]).map((entry) =>
        zoneItem(navId.entry(page.reference, entry.id), entry, (action) => {
          if (action !== "rename") return runZoneAction(page.reference, entry, action);
          rename(`Renommer « ${entry.label} »`, entry.label, (value) => {
            const next = value.trim();
            if (next && next !== entry.label) runZoneAction(page.reference, entry, "rename", next);
          });
        }),
      ),
    );
  const count = sectionCount(counts, section.pages);
  return (
    <Sidebar.Item
      key={section.id}
      id={navId.section(section.id)}
      icon={<SectionIcon section={section} size={16} />}
      label={section.label}
      count={count > 0 ? count : undefined}
      actions={[
        {
          icon: <MoreHorizontal size={16} aria-hidden="true" />,
          label: `Actions de la section ${section.label}`,
          menu,
        },
      ]}
    >
      {entries.length ? entries : undefined}
    </Sidebar.Item>
  );
}

export function AppShell({
  agent,
  agentZone,
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
  /** Conversations rangées sous l’entrée Agent. */
  agentZone?: AgentZone;
  /** Rubriques intégrées des Réglages ; les pages de l’espace placées dans les Réglages s’y ajoutent. */
  settingsTabs: BuiltInTab[];
  renderAgentPanel?: AgentPanelRenderer;
  renderPageTools?: PageToolsRenderer;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const recent = useShell((state) => state.recentSpaces);
  const shown = useShell((state) => state.view);
  const behind = useShell((state) => state.behind);
  const settingsOpen = shown.kind === "settings";
  // Les Réglages s’ouvrent par-dessus : la vue d’où ils ont été ouverts reste affichée derrière.
  const view: View = settingsOpen ? behind : shown;
  const setView = useShell((state) => state.setView);
  const activeTabs = useShell((state) => state.activeTab);
  const activeEntry = useShell((state) => state.activeEntry);
  const zones = useMenuZones((state) => state.zones);
  const badgeCounts = useBadges((state) => state.counts);
  const editor = useNavigationEditor();
  const spaces = useSpaceActions();
  useEffect(() => startBadges(), []);
  useEffect(() => startMenuZones(), []);
  const sections = useMemo(() => (snapshot?.sections ?? []).filter((section) => !section.hidden), [snapshot]);

  const current = view.kind === "section" ? sections.find((section) => section.id === view.id) : undefined;
  const wanted: View = view.kind === "section" && !current ? { kind: "agent" } : view;
  // Sans agent installé, la page Agent n’existe pas : la première section s’affiche à sa place.
  const fallback = sections[0];
  const effective: View =
    wanted.kind === "agent" && agentAvailable === false && fallback ? { kind: "section", id: fallback.id } : wanted;
  const shownSection =
    effective.kind === "section" ? sections.find((section) => section.id === effective.id) : undefined;

  const frame = useSectionFrame({
    title: shownSection?.label ?? "Agent",
    sectionId: shownSection?.id ?? "agent",
    pages: shownSection?.pages ?? [],
    waiting: shownSection?.waiting,
    renderAgentPanel,
    renderPageTools,
    pageActions: shownSection ? (reference) => editor.pageActions(reference, shownSection.id) : undefined,
  });

  if (!snapshot) return null;

  // Élément sélectionné : l’entrée de zone ouverte, sinon la section ; la conversation ouverte, sinon l’agent.
  let selectedId = navId.agent;
  if (effective.kind === "section" && shownSection) {
    const page = activeTabs[shownSection.id];
    const opened = page ? activeEntry[page] : undefined;
    selectedId = opened ? navId.entry(opened.zone, opened.id) : navId.section(shownSection.id);
  } else if (effective.kind === "agent" && agentZone?.activeId) {
    selectedId = navId.conversation(agentZone.activeId);
  }

  const select = (id: string) => {
    if (id === navId.agent) return setView({ kind: "agent" });
    if (id.startsWith("agent:")) {
      agentZone?.onOpen(id.slice("agent:".length));
      return setView({ kind: "agent" });
    }
    if (id.startsWith("section:")) {
      const sectionId = id.slice("section:".length);
      const section = sections.find((candidate) => candidate.id === sectionId);
      // L’entrée de la section ouvre ses pages sans entrée de zone.
      useShell.getState().clearEntries((section?.pages ?? []).map((page) => page.reference));
      return setView({ kind: "section", id: sectionId });
    }
    if (id.startsWith("entry:")) {
      const [zonePage = "", entryId] = id.slice("entry:".length).split("\u0000");
      const entry = zones[zonePage]?.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      openZoneEntry(zonePage, entry);
      // La page de l’entrée s’ouvre dans sa section.
      const target = entryTarget(zonePage, entry);
      const section = sections.find((candidate) => candidate.pages.some((page) => page.reference === target));
      if (section) setView({ kind: "section", id: section.id });
    }
  };

  const counts = agentSummary ? agentCounts(agentSummary) : { attention: 0, working: 0, unread: 0 };
  const agentCount = counts.attention + counts.unread;
  const agentItem =
    agentAvailable === true ? (
      <Sidebar.Item
        id={navId.agent}
        icon={<Bot size={16} aria-hidden="true" />}
        label="Agent"
        tabbar
        count={agentCount > 0 ? agentCount : undefined}
        indicator={agentCount === 0 && counts.working > 0 ? "activity" : undefined}
      />
    ) : null;

  const renameConversation = (row: ZoneRow) =>
    editor.rename(`Renommer « ${row.label} »`, row.label, (value) => {
      const next = value.trim();
      if (next && next !== row.label) agentZone?.onAction(row.id, "rename", next);
    });

  const sidebar = (
    <Sidebar
      selectedId={selectedId}
      onSelectionChange={select}
      footer={agentItem}
      workspace={
        <Sidebar.Workspace
          workspaces={spaceList(recent, snapshot).map((space) => ({ id: space.path, name: space.name }))}
          currentId={snapshot.path}
          isDisabled={spaces.busy}
          onChange={(path) => void spaces.open(path, undefined, true)}
          actions={
            <>
              <Menu.Item label="Ouvrir un autre dossier…" onAction={spaces.openOther} />
              <Menu.Item label="Créer un espace de travail…" onAction={spaces.create} />
            </>
          }
        />
      }
      account={<Sidebar.Account name="Alfred" onSettings={() => setView({ kind: "settings" })} />}
    >
      {sections.map((section) =>
        sectionItem(section, {
          zones,
          counts: badgeCounts,
          menu: editor.sectionMenu(section.id),
          rename: editor.rename,
        }),
      )}
      {agentAvailable === true && agentZone?.rows.length ? (
        <Sidebar.Section id="agent-conversations" title="Conversations" limit={agentZone.visible}>
          {agentZone.rows.map((row) => (
            <Sidebar.TreeItem
              key={row.id}
              id={navId.conversation(row.id)}
              title={row.label}
              subtitle={row.details}
              status={row.status === "error" || row.status === "warning" ? "warning" : undefined}
              unread={Boolean(row.badge)}
              actions={
                row.actions?.length
                  ? row.actions.map((action) => (
                      <Menu.Item
                        key={action.id}
                        label={action.label}
                        icon={<NamedIcon name={action.icon} size={16} />}
                        onAction={() =>
                          action.id === "rename" ? renameConversation(row) : agentZone.onAction(row.id, action.id)
                        }
                      />
                    ))
                  : undefined
              }
            />
          ))}
        </Sidebar.Section>
      ) : null}
    </Sidebar>
  );

  const agentPage =
    agentAvailable === null ? null : agentAvailable ? (
      agent
    ) : (
      <EmptyState
        title="Aucun agent installé"
        description="Alfred se construit en parlant à un agent. Installez Claude Code, Codex ou OpenCode sur ce poste et connectez-vous-y dans un terminal : il apparaîtra ici."
        action={
          <Button
            onPress={() => {
              const shell = useShell.getState();
              shell.setView({ kind: "settings" });
              shell.setActiveTab(SETTINGS_SECTION, "agents");
            }}
          >
            Vérifier dans les Réglages
          </Button>
        }
      />
    );

  const onAgent = effective.kind === "agent";
  return (
    <>
      <SocleShell
        sidebar={sidebar}
        pageTitle={onAgent ? "Agent" : frame.pageTitle}
        views={onAgent ? undefined : frame.views}
        activeView={onAgent ? undefined : frame.activeView}
        onViewChange={onAgent ? undefined : frame.onViewChange}
        actions={onAgent ? <NotificationCenter /> : frame.actions}
        detail={onAgent ? undefined : frame.detail}
        detailExpandable
        history={false}
      >
        {onAgent ? agentPage : shownSection ? frame.main : null}
      </SocleShell>
      {settingsOpen ? (
        <SettingsModal
          tabs={settingsTabs}
          pages={snapshot.settingsPages}
          onClose={() => useShell.getState().closeSettings()}
        />
      ) : null}
      {editor.elements}
      {spaces.elements}
    </>
  );
}
