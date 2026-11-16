import {
  Button,
  ChoiceButton,
  ChoiceGroup,
  EmptyState,
  FeedbackBanner,
  FormControlGroup,
  FormField,
  MenuItem,
  OverflowMenu,
  Page,
  RefreshButton,
  SearchField,
  Section,
  SelectControl,
  Spinner,
  StatusBadge,
  SwitchControl,
  Text,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { ArrowLeft, Boxes, ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModuleSummary } from "../../lib/types";
import { NamedIcon } from "../../shell/icons";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { isModuleHidden, setModuleHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { ClientNeedItem } from "../clients/api";
import { ServiceBlock, serviceNeedsAttention } from "../clients/ServiceBlock";
import { type ServiceEditing, ServiceEditor } from "../clients/ServiceEditor";
import { useClients } from "../clients/useClients";
import { remainingSummary, SETUP_FOCUS } from "../setup/api";
import { SetupFlow } from "../setup/SetupFlow";
import { useModuleSetup } from "../setup/useModuleSetup";
import {
  type CatalogModule,
  catalogAccesses,
  errorMessage,
  type Marketplace,
  type ModuleUpdate,
  marketplaceApi,
} from "./api";
import { InstallDialog, PublishDialog, UninstallDialog, UpdateDialog } from "./dialogs";
import { ModulePages } from "./ModulePages";
import { MergeDialog, modulePages, SplitDialog } from "./reorganize";
import { countPendingUpdates, useModuleUpdatesStore } from "./useModuleUpdates";
import "./modules.css";

export { useModuleUpdates } from "./useModuleUpdates";

const NO_MODULES: ModuleSummary[] = [];

type Opened =
  | { kind: "update"; module: string }
  | { kind: "uninstall"; module: ModuleSummary }
  | { kind: "publish"; module: ModuleSummary }
  | { kind: "install"; module: CatalogModule }
  | { kind: "merge"; module: ModuleSummary }
  | { kind: "split"; module: ModuleSummary };

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function checkedAt(iso: string | null) {
  if (!iso) return "Jamais vérifié";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Jamais vérifié";
  return `Vérifié le ${date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
}

type Screen =
  | { kind: "list" }
  | { kind: "module"; id: string }
  | { kind: "add" }
  /** Parcours de configuration : `intro` juste après l’installation, `resume` pour le reprendre. */
  | { kind: "setup"; id: string; start: "intro" | "resume" };
type Filter = "all" | "attention" | "updates" | "off";

/** Minuscules sans accents, pour une recherche tolérante. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

/** Clé de `activeTab` qui demande d’ouvrir la fiche d’un module (voir `openModuleSettings`). */
export const MODULE_FOCUS = "réglages:module";
export { SETUP_FOCUS } from "../setup/api";

/** D’où vient un module : créé ici, installé (et depuis où), ou détaché de son marketplace. */
function originLabel(module: ModuleSummary, update: ModuleUpdate | undefined) {
  if (!module.origin) return "Créé ici";
  if (module.origin.detached) return `Détaché de ${module.origin.marketplace} (v${module.origin.version})`;
  return `Installé depuis ${update?.marketplaceName ?? module.origin.marketplace}`;
}

/**
 * Entrée de menu dont l’action part dès la phase de capture. `OverflowMenu` ferme le menu pendant cette phase, et
 * dans une vraie fenêtre React le démonte avant la remontée du clic : un `onClick` ordinaire n’est alors jamais
 * appelé (les tests jsdom ne le voient pas, le clic y étant simulé d’un seul tenant).
 */
function MenuAction({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return <MenuItem onClickCapture={onSelect}>{children}</MenuItem>;
}

/**
 * Onglet « Modules » des Réglages : chaque module avec son interrupteur, ses pages, ses services et leurs comptes ;
 * puis les dépôts de modules et ce qu’ils proposent.
 */
export function ModulesSettings() {
  const modules = useShell((state) => state.snapshot?.modules) ?? NO_MODULES;
  const refreshSpace = useShell((state) => state.refresh);
  const updates = useModuleUpdatesStore((state) => state.updates);
  const checking = useModuleUpdatesStore((state) => state.checking);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);

  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogModule[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /** Opération en cours, pour désactiver ce qui la doublerait : `add`, `all`, `refresh:<id>`, `module:<id>`. */
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const addErrorId = useId();
  const snapshot = useShell((state) => state.snapshot);
  const services = useClients();
  // Relu avec les services et l’espace : ce sont eux qui font avancer la configuration des modules.
  const setups = useModuleSetup({ listen: false });
  const reloadSetups = setups.load;
  useEffect(() => {
    if (services.overview || snapshot) void reloadSetups();
  }, [services.overview, snapshot, reloadSetups]);
  const [editingService, setEditingService] = useState<ServiceEditing>();
  /** Vue affichée : la liste des modules, la fiche d’un module, ou l’ajout de modules (dépôts et catalogue). */
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [catalogQuery, setCatalogQuery] = useState("");
  // Un module désigné de l’extérieur (une section qui attend un compte) s’ouvre et se montre.
  const focused = useShell((state) => state.activeTab[MODULE_FOCUS]);
  useEffect(() => {
    if (!focused) return;
    setScreen({ kind: "module", id: focused });
    useShell.getState().setActiveTab(MODULE_FOCUS, "");
  }, [focused]);
  const setupFocused = useShell((state) => state.activeTab[SETUP_FOCUS]);
  useEffect(() => {
    if (!setupFocused) return;
    setScreen({ kind: "setup", id: setupFocused, start: "resume" });
    useShell.getState().setActiveTab(SETUP_FOCUS, "");
  }, [setupFocused]);

  const updateOf = useMemo(() => new Map(updates.map((update) => [update.module, update])), [updates]);
  const pending = countPendingUpdates(updates);
  const current = marketplaces?.find((marketplace) => marketplace.id === selected) ?? marketplaces?.[0] ?? null;
  const currentId = current?.id ?? null;

  const loadMarketplaces = useCallback(async () => {
    try {
      setMarketplaces(await marketplaceApi.list());
    } catch (failure) {
      setMarketplaces([]);
      notify({ title: "Dépôts de modules illisibles", description: errorMessage(failure), tone: "error" });
    }
  }, []);

  const catalogRequest = useRef(0);
  const loadCatalog = useCallback(async (id: string | null) => {
    const request = ++catalogRequest.current;
    if (!id) {
      setCatalog(null);
      setCatalogError(null);
      return;
    }
    try {
      const entries = await marketplaceApi.modules(id);
      if (request !== catalogRequest.current) return;
      setCatalog(entries);
      setCatalogError(null);
    } catch (failure) {
      if (request !== catalogRequest.current) return;
      setCatalog([]);
      setCatalogError(errorMessage(failure));
    }
  }, []);

  /** Interroge les marketplaces distants, puis relit ce qui en dépend. */
  const checkNow = useCallback(async () => {
    try {
      await loadUpdates(true);
    } catch (failure) {
      notify({ title: "Vérification des mises à jour impossible", description: errorMessage(failure), tone: "error" });
    }
    await loadMarketplaces();
  }, [loadMarketplaces, loadUpdates]);

  // À l’ouverture : l’état connu s’affiche tout de suite, la vérification réseau suit.
  useEffect(() => {
    void (async () => {
      await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
      await checkNow();
    })();
  }, [checkNow, loadMarketplaces, loadUpdates]);

  // Le catalogue suit le marketplace choisi, et se relit quand les modules de l’espace ou le clone changent.
  const catalogKey = `${currentId ?? ""}|${current?.lastChecked ?? ""}|${modules.map((module) => `${module.id}@${module.origin?.version ?? ""}`).join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalogKey` résume ce qui périme le catalogue affiché.
  useEffect(() => {
    void loadCatalog(currentId);
  }, [catalogKey, currentId, loadCatalog]);

  /** Après une opération qui change l’espace : la navigation et l’état des modules se relisent sans attendre. */
  const afterSpaceChange = async () => {
    await Promise.all([refreshSpace().catch(() => undefined), loadUpdates(false).catch(() => undefined)]);
  };

  const run = async (key: string, action: () => Promise<void>, failureTitle: string) => {
    setBusy(key);
    try {
      await action();
    } catch (failure) {
      notify({ title: failureTitle, description: errorMessage(failure), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const updateAll = () =>
    run(
      "all",
      async () => {
        const result = await marketplaceApi.updateAll();
        await afterSpaceChange();
        if (result.updated.length > 0) {
          notify({
            title: `${plural(result.updated.length, "module")} mis à jour`,
            description: result.updated.map((entry) => `${entry.name} v${entry.to}`).join(", "),
            tone: "success",
          });
        }
        for (const failure of result.failed) {
          notify({ title: `Mise à jour de ${failure.name} impossible`, description: failure.message, tone: "error" });
        }
        if (result.updated.length === 0 && result.failed.length === 0) notify({ title: "Tout est déjà à jour" });
      },
      "Mise à jour impossible",
    );

  const togglePin = (module: ModuleSummary, pinned: boolean) =>
    run(
      `module:${module.id}`,
      async () => {
        await marketplaceApi.pin(module.id, pinned);
        await afterSpaceChange();
        notify({
          title: pinned ? `${module.name} figé sur la v${module.version}` : `${module.name} libéré`,
          description: pinned
            ? "Ses mises à jour restent signalées, mais « Tout mettre à jour » le laisse de côté."
            : "« Tout mettre à jour » le prend de nouveau en compte.",
          tone: "success",
        });
      },
      "Changement impossible",
    );

  const detach = async (module: ModuleSummary) => {
    const accepted = await confirm({
      title: `Détacher ${module.name} ?`,
      message:
        "Le module devient le vôtre et modifiable. Il garde la trace de son origine, mais ne recevra plus aucune mise à jour de son dépôt.",
      confirmLabel: "Détacher",
    });
    if (!accepted) return;
    await run(
      `module:${module.id}`,
      async () => {
        await marketplaceApi.detach(module.id);
        await afterSpaceChange();
        notify({ title: `${module.name} détaché`, description: "Il est maintenant modifiable.", tone: "success" });
      },
      "Détachement impossible",
    );
  };

  const addMarketplace = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy("add");
    setAddError(null);
    try {
      const added = await marketplaceApi.add(url.trim());
      setUrl("");
      setSelected(added.id);
      await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
      notify({ title: `Dépôt ${added.name} ajouté`, tone: "success" });
    } catch (failure) {
      setAddError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const removeMarketplace = async (marketplace: Marketplace) => {
    const installed = updates.filter((update) => update.marketplace === marketplace.id).length;
    const accepted = await confirm({
      title: `Retirer ${marketplace.name} ?`,
      message:
        installed > 0
          ? `${plural(installed, "module installé", "modules installés")} depuis ce dépôt ${installed > 1 ? "restent" : "reste"} dans l’espace : plus de mise à jour tant qu’il n’est pas ajouté de nouveau.`
          : "Ses modules ne seront plus proposés. Aucun de vos modules n’en vient.",
      confirmLabel: "Retirer",
      tone: "danger",
    });
    if (!accepted) return;
    await run(
      `refresh:${marketplace.id}`,
      async () => {
        await marketplaceApi.remove(marketplace.id);
        await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
        notify({ title: `Dépôt ${marketplace.name} retiré` });
      },
      "Retrait impossible",
    );
  };

  const refreshMarketplace = (marketplace: Marketplace) =>
    run(
      `refresh:${marketplace.id}`,
      async () => {
        try {
          await marketplaceApi.refresh(marketplace.id);
        } finally {
          // L’échec aussi s’inscrit sur le marketplace : la liste doit le montrer.
          await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
        }
        notify({ title: `${marketplace.name} est à jour`, tone: "success" });
      },
      `Rafraîchissement de ${marketplace.name} impossible`,
    );

  const openedUpdate = opened?.kind === "update" ? updateOf.get(opened.module) : undefined;

  if (editingService) {
    return (
      <ServiceEditor
        editing={editingService}
        redirectUri={services.overview?.redirectUri ?? null}
        onEdit={setEditingService}
        onDone={() => {
          setEditingService(undefined);
          void services.load();
        }}
      />
    );
  }

  const clients = services.overview?.clients ?? [];
  const needs = services.overview?.needs ?? [];
  const nameOf = (id: string) => modules.find((candidate) => candidate.id === id)?.name || id;
  const orphans = clients.filter((client) => client.usedBy.length === 0);
  const clientOf = (need: ClientNeedItem) => clients.find((client) => client.id === need.client);
  const hiddenOf = (module: ModuleSummary) => (snapshot ? isModuleHidden(snapshot, module.id) : module.hidden);
  // Un module est « à configurer » tant que son parcours n’est pas terminé (services prêts et testés, dépendances
  // comprises) ; avant la première lecture de ce parcours, on s’en tient à l’état de ses services.
  const needsAttention = (module: ModuleSummary) => {
    const setup = setups.of(module.id);
    if (setup) return !setup.ready;
    return (
      services.overview !== undefined &&
      needs.some((need) => need.module === module.id && serviceNeedsAttention(clientOf(need)))
    );
  };
  const counts = {
    attention: modules.filter(needsAttention).length,
    updates: modules.filter((module) => updateOf.get(module.id)?.available).length,
    off: modules.filter(hiddenOf).length,
  };
  const folded = fold(query.trim());
  const shown = modules.filter((module) => {
    if (filter === "attention" && !needsAttention(module)) return false;
    if (filter === "updates" && !updateOf.get(module.id)?.available) return false;
    if (filter === "off" && !hiddenOf(module)) return false;
    return !folded || fold(`${module.name} ${module.description} ${module.id}`).includes(folded);
  });
  const opened_ = screen.kind === "module" ? modules.find((module) => module.id === screen.id) : undefined;
  const back = (
    <Button onClick={() => setScreen({ kind: "list" })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Tous les modules
    </Button>
  );

  /** Icône du module : celle de sa première section dans le menu, dans sa couleur. */
  const moduleIcon = (module: ModuleSummary) => {
    const section = snapshot?.sections.find((candidate) => candidate.module === module.id);
    return (
      <span className={`module-row__icon product-color--${section?.color ?? "steel"}`} aria-hidden="true">
        {section?.icon ? <NamedIcon name={section.icon} size={15} /> : <Boxes size={15} />}
      </span>
    );
  };

  /** Résumé en mots simples : d’où vient le module, ce qu’il contient. */
  const moduleSummary = (module: ModuleSummary, withVersion: boolean) => {
    const update = updateOf.get(module.id);
    const installed = module.origin !== null && !module.origin.detached;
    const serviceCount = needs.filter((need) => need.module === module.id).length;
    return [
      originLabel(module, update),
      withVersion ? `version ${module.version}` : null,
      plural(module.pages, "page"),
      serviceCount > 0 ? plural(serviceCount, "service") : null,
      installed ? "lecture seule" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  /** Pastilles d’état : ce qui demande l’attention de l’utilisateur. */
  const moduleBadges = (module: ModuleSummary) => {
    const update = updateOf.get(module.id);
    return (
      <>
        {hiddenOf(module) ? <StatusBadge size="compact">Désactivé</StatusBadge> : null}
        {needsAttention(module) ? (
          <StatusBadge tone="warning" size="compact">
            À configurer
          </StatusBadge>
        ) : null}
        {update?.available ? (
          <StatusBadge tone="warning" size="compact">
            Mise à jour disponible : v{update.available}
          </StatusBadge>
        ) : null}
        {update?.pinned ? <StatusBadge size="compact">Figé</StatusBadge> : null}
        {update?.locallyModified ? (
          <StatusBadge tone="warning" size="compact" title="Le dossier du module diffère de ce qui a été installé.">
            Modifié sur place
          </StatusBadge>
        ) : null}
        {update?.sourceMissing ? (
          <StatusBadge tone="danger" size="compact" title={`Dépôt d’origine : ${update.source}`}>
            Sans dépôt
          </StatusBadge>
        ) : null}
        {update?.withdrawn ? (
          <StatusBadge tone="danger" size="compact">
            Retiré de son dépôt
          </StatusBadge>
        ) : null}
      </>
    );
  };

  /** Interrupteur, mise à jour et menu « … » d’un module : les mêmes dans la liste et dans sa fiche. */
  const moduleActions = (module: ModuleSummary) => {
    const update = updateOf.get(module.id);
    const installed = module.origin !== null && !module.origin.detached;
    const working = busy === `module:${module.id}`;
    return (
      <div className="modules-list__actions module-row__actions">
        {update?.available ? (
          <Button disabled={busy !== null} onClick={() => setOpened({ kind: "update", module: module.id })}>
            Mettre à jour
          </Button>
        ) : null}
        {working ? <Spinner label={`Opération en cours sur ${module.name}`} /> : null}
        <SwitchControl
          label=""
          aria-label={`Activer le module ${module.name}`}
          checked={!hiddenOf(module)}
          onChange={(event) =>
            void applyLayoutChange((current) => setModuleHidden(current, module.id, !event.target.checked))
          }
        />
        <OverflowMenu label={`Actions du module ${module.name}`} disabled={busy !== null}>
          {installed ? (
            <>
              <MenuAction onSelect={() => void togglePin(module, !module.origin?.pinned)}>
                {module.origin?.pinned ? "Libérer" : "Figer sur cette version"}
              </MenuAction>
              <MenuAction onSelect={() => void detach(module)}>Détacher…</MenuAction>
            </>
          ) : (
            <>
              <MenuAction onSelect={() => setOpened({ kind: "publish", module })}>Publier…</MenuAction>
              <MenuAction onSelect={() => setOpened({ kind: "merge", module })}>Fusionner avec…</MenuAction>
              <MenuAction onSelect={() => setOpened({ kind: "split", module })}>Scinder…</MenuAction>
            </>
          )}
          <MenuAction onSelect={() => setOpened({ kind: "uninstall", module })}>
            {installed ? "Désinstaller…" : "Supprimer…"}
          </MenuAction>
        </OverflowMenu>
      </div>
    );
  };

  /** Ligne d’un module dans la liste : toute la ligne ouvre sa fiche, sauf ses propres contrôles. */
  const moduleRow = (module: ModuleSummary) => (
    <li key={module.id} className="module-row" data-module={module.id}>
      {moduleIcon(module)}
      <div className="module-row__main">
        <button
          type="button"
          className="module-row__open"
          aria-label={`Ouvrir la fiche de ${module.name}`}
          onClick={() => setScreen({ kind: "module", id: module.id })}
        >
          {module.name}
        </button>
        {module.description ? <p className="module-row__description">{module.description}</p> : null}
        <p className="module-row__summary">
          <span>{moduleSummary(module, false)}</span>
          {moduleBadges(module)}
        </p>
      </div>
      {moduleActions(module)}
      <ChevronRight size={16} aria-hidden="true" className="module-row__chevron" />
    </li>
  );

  /** Fiche d’un module : ses pages, puis ses services et leurs comptes. */
  const moduleBody = (module: ModuleSummary) => {
    const hidden = hiddenOf(module);
    const update = updateOf.get(module.id);
    const moduleNeeds = needs.filter((need) => need.module === module.id);
    // Un seul service à plusieurs comptes : la fiche montre ses comptes directement, sans niveau intermédiaire.
    const onlyClient = moduleNeeds.length === 1 ? clientOf(moduleNeeds[0]) : undefined;
    const single = onlyClient && !onlyClient.simple ? onlyClient : undefined;
    const perInstance = Boolean(snapshot?.sections.some((section) => section.module === module.id && section.instance));
    const setup = setups.of(module.id);
    return (
      <div className="module-page__body">
        {setup && !setup.ready ? (
          <FeedbackBanner
            tone="warning"
            appearance="contained"
            action={
              <Button variant="primary" onClick={() => setScreen({ kind: "setup", id: module.id, start: "resume" })}>
                Terminer la configuration
              </Button>
            }
          >
            Ce module n’est pas encore prêt. {remainingSummary(setup)}
          </FeedbackBanner>
        ) : null}
        {update?.sourceMissing ? (
          <Text size="meta" tone="muted">
            Son dépôt ({update.source}) n’est plus ajouté : l’ajouter de nouveau pour recevoir les mises à jour, ou
            détacher le module.
          </Text>
        ) : null}
        {hidden ? (
          <Text size="meta" tone="muted">
            Module désactivé : ses pages n’apparaissent pas dans le menu.
            {module.requiredBy.length > 0
              ? ` Ses services restent utilisés par ${module.requiredBy.map(nameOf).join(", ")}.`
              : ""}
          </Text>
        ) : null}
        <div className="module-part">
          <div className="module-part__head">
            <h3>Pages</h3>
            <p>Choisissez les pages qui apparaissent dans le menu de gauche.</p>
          </div>
          {snapshot ? <ModulePages snapshot={snapshot} module={module.id} disabled={hidden} /> : null}
        </div>
        <div className="module-part">
          <div className="module-part__head">
            {single ? (
              <>
                <h3>Comptes</h3>
                <p>
                  Chaque compte est une connexion à {single.label} (une boîte mail, un site…).
                  {perInstance ? " Le module affiche une page par compte." : ""}
                </p>
              </>
            ) : (
              <>
                <h3>Services connectés</h3>
                <p>Les services en ligne dont ce module a besoin, et vos comptes chez eux.</p>
              </>
            )}
          </div>
          {services.overview === undefined ? (
            services.error ? (
              <Text size="meta" tone="danger">
                Les services n’ont pas pu être lus. {services.error}
              </Text>
            ) : (
              <Spinner label="Chargement des services" />
            )
          ) : moduleNeeds.length === 0 ? (
            <Text size="meta" tone="muted">
              Ce module n’a besoin d’aucun service.
            </Text>
          ) : (
            <div className="service-list">
              {moduleNeeds.map((need) => (
                <ServiceBlock
                  key={need.key}
                  need={need}
                  client={clientOf(need)}
                  clients={clients}
                  controller={services}
                  onEdit={setEditingService}
                  flat={Boolean(single)}
                  describeInstance={(instance) => {
                    const page = snapshot?.sections.find(
                      (section) => section.module === module.id && section.instance === instance,
                    );
                    return page ? `Page « ${page.label} » dans le menu` : undefined;
                  }}
                />
              ))}
            </div>
          )}
          {module.requires.length > 0 ? (
            <Text size="meta" tone="muted">
              Utilise aussi les services de {module.requires.map((required) => nameOf(required.module)).join(", ")}.
            </Text>
          ) : null}
        </div>
      </div>
    );
  };

  const filters: Array<{ id: Filter; label: string; count?: number }> = [
    { id: "all", label: "Tous" },
    { id: "attention", label: "À configurer", count: counts.attention },
    { id: "updates", label: "Mises à jour", count: counts.updates },
    { id: "off", label: "Désactivés", count: counts.off },
  ];

  const listScreen = (
    <>
      <Section
        title="Mes modules"
        description="Chaque module apporte des pages et peut avoir besoin de services (une messagerie, Jira…). Ouvrez un module pour choisir ses pages et connecter ses services."
        actions={
          <>
            {checking ? <Spinner label="Vérification des mises à jour" /> : null}
            <RefreshButton label="Vérifier les mises à jour" disabled={checking} onClick={() => void checkNow()} />
            {pending > 0 ? (
              <Button loading={busy === "all"} disabled={busy !== null} onClick={() => void updateAll()}>
                Tout mettre à jour ({pending})
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setScreen({ kind: "add" })}>
              Ajouter des modules
            </Button>
          </>
        }
      >
        {modules.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucun module"
            description="Demandez une page à l’agent : il crée un module pour vous. Vous pouvez aussi en installer depuis un dépôt, avec « Ajouter des modules »."
          />
        ) : (
          <div className="module-list-view">
            {counts.attention > 0 && filter !== "attention" ? (
              <FeedbackBanner
                tone="warning"
                appearance="contained"
                action={<Button onClick={() => setFilter("attention")}>Les afficher</Button>}
              >
                {counts.attention > 1
                  ? `${counts.attention} modules ont une configuration à terminer : connectez et testez les services qui leur manquent.`
                  : "Un module a une configuration à terminer : connectez et testez le service qui lui manque."}
              </FeedbackBanner>
            ) : null}
            {modules.length > 5 || filter !== "all" || query ? (
              <div className="module-list-view__tools">
                <SearchField
                  label="Rechercher un module"
                  placeholder="Rechercher un module…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <ChoiceGroup label="Afficher" appearance="segmented">
                  {filters
                    .filter((choice) => choice.id === "all" || choice.id === filter || (choice.count ?? 0) > 0)
                    .map((choice) => (
                      <ChoiceButton
                        key={choice.id}
                        variant="label"
                        size="compact"
                        label={choice.count ? `${choice.label} (${choice.count})` : choice.label}
                        selected={filter === choice.id}
                        onClick={() => setFilter(choice.id)}
                      >
                        {choice.count ? `${choice.label} (${choice.count})` : choice.label}
                      </ChoiceButton>
                    ))}
                </ChoiceGroup>
              </div>
            ) : null}
            {shown.length === 0 ? (
              <EmptyState
                size="compact"
                title="Aucun module ne correspond"
                description="Changez la recherche ou le filtre."
              />
            ) : (
              <ul className="module-rows" aria-label="Modules de l’espace">
                {shown.map(moduleRow)}
              </ul>
            )}
          </div>
        )}
      </Section>

      {orphans.length > 0 ? (
        <Section
          title="Autres services"
          description="Services qu’aucun module n’utilise pour l’instant. Les pages peuvent quand même les appeler."
          actions={<Button onClick={() => setEditingService({ kind: "client" })}>Nouveau service</Button>}
        >
          <div className="service-list">
            {orphans.map((client) => (
              <ServiceBlock
                key={client.id}
                client={client}
                clients={clients}
                controller={services}
                onEdit={setEditingService}
              />
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );

  const setupModule = screen.kind === "setup" ? modules.find((module) => module.id === screen.id) : undefined;
  const firstSection = (module: string) =>
    snapshot?.sections.find((section) => section.module === module && !section.hidden) ??
    snapshot?.sections.find((section) => section.module === module);
  const setupScreen =
    screen.kind === "setup" && setupModule ? (
      <SetupFlow
        key={`${setupModule.id}:${screen.start}`}
        setup={setups.of(setupModule.id)}
        modules={modules}
        services={services}
        start={screen.start}
        onEdit={setEditingService}
        onClose={() => setScreen({ kind: "module", id: setupModule.id })}
        onOpenModule={
          firstSection(setupModule.id)
            ? () => {
                const section = firstSection(setupModule.id);
                if (section) useShell.getState().setView({ kind: "section", id: section.id });
              }
            : undefined
        }
      />
    ) : null;

  const moduleScreen = opened_ ? (
    <Section title={opened_.name} description={opened_.description || undefined} actions={back}>
      <div className="module-page" data-module={opened_.id}>
        <div className="module-row module-row--header">
          {moduleIcon(opened_)}
          <div className="module-row__main">
            <p className="module-row__summary">
              <span>{moduleSummary(opened_, true)}</span>
              {moduleBadges(opened_)}
            </p>
          </div>
          {moduleActions(opened_)}
        </div>
        {moduleBody(opened_)}
      </div>
    </Section>
  ) : null;

  const foldedCatalog = fold(catalogQuery.trim());
  const catalogShown = (catalog ?? []).filter(
    (entry) => !foldedCatalog || fold(`${entry.name} ${entry.description ?? ""} ${entry.id}`).includes(foldedCatalog),
  );

  const addScreen = (
    <>
      <Section
        title="Où trouver des modules"
        description="Un dépôt est un dossier partagé (git) où une équipe range ses modules. Ajoutez celui de votre équipe pour installer ses modules ou y publier les vôtres. Alfred s’y connecte avec les accès git déjà réglés sur ce poste."
        actions={back}
      >
        <form onSubmit={addMarketplace}>
          <FormControlGroup>
            <FormField label="Adresse du dépôt">
              <TextInput
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setAddError(null);
                }}
                placeholder="git@exemple.fr:equipe/modules.git"
                spellCheck={false}
                autoCapitalize="off"
                disabled={busy === "add"}
                aria-invalid={addError ? true : undefined}
                aria-describedby={addError ? addErrorId : undefined}
              />
            </FormField>
            <Button
              type="submit"
              loading={busy === "add"}
              loadingLabel="Ajout…"
              disabled={!url.trim() || busy !== null}
            >
              Ajouter
            </Button>
          </FormControlGroup>
          {/* Sous le groupe entier : le bouton reste aligné sur le champ quand le message apparaît. */}
          {addError ? (
            <p id={addErrorId} role="alert" className="modules-list__meta modules-list__meta--danger modules-add-error">
              {addError}
            </p>
          ) : null}
        </form>
        {marketplaces === null ? (
          <Spinner label="Chargement des dépôts" />
        ) : marketplaces.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucun dépôt ajouté"
            description="Ajoutez l’adresse du dépôt de votre équipe pour installer ses modules ou y publier les vôtres."
          />
        ) : (
          <ul className="modules-list" aria-label="Dépôts de modules">
            {marketplaces.map((marketplace) => (
              <li key={marketplace.id}>
                <div className="modules-list__main">
                  <div className="modules-list__title">
                    <span>{marketplace.name}</span>
                    {marketplace.error ? (
                      <StatusBadge tone="danger" size="compact">
                        Inaccessible
                      </StatusBadge>
                    ) : null}
                  </div>
                  <p className="modules-list__meta">
                    {marketplace.url} · {checkedAt(marketplace.lastChecked)}
                  </p>
                  {marketplace.error ? (
                    <p className="modules-list__meta modules-list__meta--danger">{marketplace.error}</p>
                  ) : null}
                </div>
                <div className="modules-list__actions">
                  <RefreshButton
                    label={`Rafraîchir ${marketplace.name}`}
                    loading={busy === `refresh:${marketplace.id}`}
                    disabled={busy !== null}
                    onClick={() => void refreshMarketplace(marketplace)}
                  />
                  <Button disabled={busy !== null} onClick={() => void removeMarketplace(marketplace)}>
                    Retirer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {current ? (
        <Section
          title={`Modules disponibles — ${current.name}`}
          description="Ce que propose ce dépôt, avec ce que contient chaque module et ce à quoi il demande accès."
          actions={
            marketplaces && marketplaces.length > 1 ? (
              <SelectControl
                aria-label="Dépôt affiché"
                value={current.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {marketplaces.map((marketplace) => (
                  <option key={marketplace.id} value={marketplace.id}>
                    {marketplace.name}
                  </option>
                ))}
              </SelectControl>
            ) : undefined
          }
        >
          {catalogError ? (
            <FeedbackBanner tone="error" appearance="contained">
              {catalogError}
            </FeedbackBanner>
          ) : catalog === null ? (
            <Spinner label="Chargement des modules disponibles" />
          ) : catalog.length === 0 ? (
            <EmptyState
              size="compact"
              title="Aucun module dans ce dépôt"
              description="Publiez l’un de vos modules (menu « … » de sa fiche) pour le partager ici."
            />
          ) : (
            <div className="module-list-view">
              {catalog.length > 5 ? (
                <div className="module-list-view__tools">
                  <SearchField
                    label="Rechercher un module disponible"
                    placeholder="Rechercher un module…"
                    value={catalogQuery}
                    onChange={(event) => setCatalogQuery(event.target.value)}
                  />
                </div>
              ) : null}
              <ul className="modules-list" aria-label={`Modules proposés par ${current.name}`}>
                {catalogShown.map((entry) => {
                  const accesses = catalogAccesses(entry);
                  return (
                    <li key={entry.id}>
                      <div className="modules-list__main">
                        <div className="modules-list__title">
                          <span>{entry.name}</span>
                          {entry.version ? <span className="modules-list__version">v{entry.version}</span> : null}
                          {entry.installed ? (
                            <StatusBadge tone="success" size="compact">
                              Installé{entry.installed !== entry.version ? ` (v${entry.installed})` : ""}
                            </StatusBadge>
                          ) : null}
                        </div>
                        {entry.error ? (
                          <p className="modules-list__meta modules-list__meta--danger">{entry.error}</p>
                        ) : (
                          <>
                            {entry.description ? <p className="modules-list__meta">{entry.description}</p> : null}
                            <p className="modules-list__meta">
                              {plural(entry.pages?.length ?? 0, "page")}
                              {accesses.length > 0
                                ? ` · demande ${accesses.map((access) => access.label).join(", ")}`
                                : ""}
                            </p>
                            {entry.conflict ? (
                              <p className="modules-list__meta">
                                Un module « {entry.id} » existe déjà dans l’espace sans venir de ce dépôt : le supprimer
                                pour installer celui-ci.
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                      <div className="modules-list__actions">
                        {entry.error || entry.installed ? null : (
                          <Button
                            disabled={busy !== null || entry.conflict}
                            onClick={() => setOpened({ kind: "install", module: entry })}
                          >
                            Installer
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Section>
      ) : null}
    </>
  );

  return (
    <Page>
      {screen.kind === "add"
        ? addScreen
        : screen.kind === "setup" && setupScreen
          ? setupScreen
          : screen.kind === "module" && moduleScreen
            ? moduleScreen
            : listScreen}

      {openedUpdate ? (
        <UpdateDialog
          update={openedUpdate}
          onClose={() => setOpened(null)}
          onConfirm={async () => {
            const result = await marketplaceApi.update(openedUpdate.module);
            setOpened(null);
            await afterSpaceChange();
            notify({
              title: `${openedUpdate.name} mis à jour`,
              description: `v${result.from} → v${result.to}`,
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "uninstall" ? (
        <UninstallDialog
          module={opened.module}
          onClose={() => setOpened(null)}
          onConfirm={async (deleteData) => {
            await marketplaceApi.uninstall(opened.module.id, deleteData);
            setOpened(null);
            await afterSpaceChange();
            notify({
              title: `${opened.module.name} retiré de l’espace`,
              description: deleteData ? "Ses données sont supprimées." : "Ses données sont conservées.",
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "publish" ? (
        <PublishDialog
          module={opened.module}
          marketplaces={marketplaces ?? []}
          onClose={() => setOpened(null)}
          onPublished={(version, marketplace) => {
            setOpened(null);
            notify({
              title: `${opened.module.name} v${version} publié`,
              description: `Sur ${marketplace.name}.`,
              tone: "success",
            });
            void afterSpaceChange();
            void loadCatalog(currentId);
          }}
        />
      ) : null}
      {opened?.kind === "install" && current ? (
        <InstallDialog
          module={opened.module}
          marketplace={current}
          onClose={() => setOpened(null)}
          onConfirm={async () => {
            await marketplaceApi.install(current.id, opened.module.id);
            setOpened(null);
            await afterSpaceChange();
            await setups.load();
            notify({ title: `${opened.module.name} installé`, tone: "success" });
            // Juste après l’installation : le parcours guidé présente le module et demande ce qui lui manque.
            setScreen({ kind: "setup", id: opened.module.id, start: "intro" });
          }}
        />
      ) : null}
      {opened?.kind === "merge" ? (
        <MergeDialog
          module={opened.module}
          modules={modules}
          onClose={() => setOpened(null)}
          onMerged={(target) => {
            setOpened(null);
            void afterSpaceChange();
            notify({
              title: `${opened.module.name} fusionné dans ${target.name}`,
              description: "Annulable depuis l’historique de l’espace.",
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "split" ? (
        <SplitDialog
          module={opened.module}
          pages={modulePages(useShell.getState().snapshot, opened.module.id)}
          onClose={() => setOpened(null)}
          onSplit={(_created, name) => {
            setOpened(null);
            void afterSpaceChange();
            notify({
              title: `Module ${name} créé`,
              description: `Pages reprises de ${opened.module.name}. Annulable depuis l’historique de l’espace.`,
              tone: "success",
            });
          }}
        />
      ) : null}
      {confirmDialog}
      {services.confirmDialog}
    </Page>
  );
}
