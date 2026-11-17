import {
  Button,
  ChoiceButton,
  ChoiceGroup,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  MenuItem,
  OverflowMenu,
  Page,
  RefreshButton,
  SearchField,
  Section,
  Spinner,
  StatusBadge,
  SwitchControl,
  Text,
  useConfirm,
} from "@alfred/ui";
import { ArrowLeft, Boxes } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ModuleSummary } from "../../lib/types";
import { NamedIcon } from "../../shell/icons";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { isModuleHidden, SETTINGS_SECTION, setModuleHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { ClientNeedItem } from "../clients/api";
import { templateOf } from "../clients/fromTemplate";
import { ServiceBlock, serviceNeedsAttention } from "../clients/ServiceBlock";
import { type ServiceEditing, ServiceEditor } from "../clients/ServiceEditor";
import { useClients } from "../clients/useClients";
import { ModuleFunctions } from "../functions/ModuleFunctions";
import { ModuleJobs } from "../jobs/ModuleJobs";
import { ModuleSchedules } from "../schedules/ModuleSchedules";
import { remainingSummary } from "../setup/api";
import { openOnboarding } from "../setup/Onboarding";
import { useModuleSetup } from "../setup/useModuleSetup";
import { TeamSync } from "../teamSync/TeamSync";
import { ModuleWebhooks } from "../webhooks/ModuleWebhooks";
import { errorMessage, type Marketplace, type ModulePublication, type ModuleUpdate, marketplaceApi } from "./api";
import { PublishDialog, UninstallDialog, UpdateDialog } from "./dialogs";
import { ModulePages } from "./ModulePages";
import { ModulePart } from "./ModulePart";
import { MergeDialog, modulePages, SplitDialog } from "./reorganize";
import { countPendingUpdates, useModuleUpdatesStore } from "./useModuleUpdates";
import "./modules.css";

export { useModuleUpdates } from "./useModuleUpdates";

const NO_MODULES: ModuleSummary[] = [];

type Opened =
  | { kind: "update"; module: string }
  | { kind: "uninstall"; module: ModuleSummary }
  | { kind: "publish"; module: ModuleSummary }
  | { kind: "merge"; module: ModuleSummary }
  | { kind: "split"; module: ModuleSummary };

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

type Screen = { kind: "list" } | { kind: "module"; id: string };
type Filter = "all" | "attention" | "updates" | "off";

/** Minuscules sans accents, pour une recherche tolérante. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

/** Clé de `activeTab` qui demande d’ouvrir la fiche d’un module (voir `openModuleSettings`). */
export const MODULE_FOCUS = "réglages:module";

/** Ouvre la rubrique Marketplace des Réglages : catalogue des modules à importer, et marketplaces branchés. */
export function openMarketplaces() {
  useShell.getState().setActiveTab(SETTINGS_SECTION, "marketplace");
}

/**
 * D’où vient un module : importé d’un marketplace, développé ici (et publié, et où), ou détaché de son
 * marketplace.
 */
function originLabel(
  module: ModuleSummary,
  update: ModuleUpdate | undefined,
  published: ModulePublication[],
  nameOf: (url: string) => string,
) {
  if (module.origin && !module.origin.detached)
    return `Importé de ${update?.marketplaceName ?? nameOf(module.origin.marketplace)}`;
  const base = module.origin?.detached
    ? `Détaché de ${nameOf(module.origin.marketplace)} (v${module.origin.version})`
    : "Développé ici";
  if (published.length === 0) return base;
  const where = published
    .map((publication) => `${publication.marketplaceName ?? publication.source} en v${publication.version}`)
    .join(", ");
  return `${base} · publié sur ${where}`;
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
 * Onglet « Modules » des Réglages : les modules installés dans l’espace de travail, en tableau (activer, mettre à
 * jour, publier, retirer), et la fiche de chacun avec tout ce qu’il contient : pages, fonctions, services et comptes,
 * webhooks, planifications, tâches de fond, dépendances. Importer un module se fait dans la rubrique Marketplace
 * (`MarketplaceSettings`).
 */
export function ModulesSettings() {
  const modules = useShell((state) => state.snapshot?.modules) ?? NO_MODULES;
  const refreshSpace = useShell((state) => state.refresh);
  const updates = useModuleUpdatesStore((state) => state.updates);
  const checking = useModuleUpdatesStore((state) => state.checking);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);

  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [publications, setPublications] = useState<ModulePublication[]>([]);
  /** Opération en cours, pour désactiver ce qui la doublerait : `all`, `module:<id>`. */
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const snapshot = useShell((state) => state.snapshot);
  const services = useClients();
  // Relu avec les services et l’espace : ce sont eux qui font avancer la configuration des modules.
  const setups = useModuleSetup({ listen: false });
  const reloadSetups = setups.load;
  useEffect(() => {
    if (services.overview || snapshot) void reloadSetups();
  }, [services.overview, snapshot, reloadSetups]);
  const [editingService, setEditingService] = useState<ServiceEditing>();
  /** Vue affichée : la liste des modules, la fiche d’un module, ou l’import depuis un marketplace. */
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Un module désigné de l’extérieur (une section qui attend un compte) s’ouvre et se montre.
  const focused = useShell((state) => state.activeTab[MODULE_FOCUS]);
  useEffect(() => {
    if (!focused) return;
    setScreen({ kind: "module", id: focused });
    useShell.getState().setActiveTab(MODULE_FOCUS, "");
  }, [focused]);

  const updateOf = useMemo(() => new Map(updates.map((update) => [update.module, update])), [updates]);
  const pending = countPendingUpdates(updates);

  const loadMarketplaces = useCallback(async () => {
    try {
      setMarketplaces(await marketplaceApi.list());
    } catch (failure) {
      setMarketplaces([]);
      notify({ title: "Marketplaces illisibles", description: errorMessage(failure), tone: "error" });
    }
  }, []);

  const loadPublications = useCallback(async () => {
    setPublications(await marketplaceApi.publications().catch(() => []));
  }, []);
  // Relu à chaque changement de l’espace de travail : une retouche rend un module « modifié depuis sa publication ».
  useEffect(() => {
    if (snapshot) void loadPublications();
  }, [snapshot, loadPublications]);

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
        "Le module devient le vôtre et modifiable. Il garde la trace de son origine, mais ne recevra plus aucune mise à jour de son marketplace.",
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

  const openedUpdate = opened?.kind === "update" ? updateOf.get(opened.module) : undefined;

  if (editingService) {
    return (
      <ServiceEditor
        editing={editingService}
        redirectUri={services.overview?.redirectUri ?? null}
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

  const marketplaceName = (url: string) =>
    marketplaces?.find((marketplace) => marketplace.url.replace(/(\.git)?\/?$/, "") === url.replace(/(\.git)?\/?$/, ""))
      ?.name ?? url;
  const publishedOf = (module: ModuleSummary) => publications.filter((publication) => publication.module === module.id);

  /** Résumé en mots simples : d’où vient le module, ce qu’il contient. */
  const moduleSummary = (module: ModuleSummary, withVersion: boolean) => {
    const update = updateOf.get(module.id);
    const installed = module.origin !== null && !module.origin.detached;
    const serviceCount = needs.filter((need) => need.module === module.id).length;
    return [
      originLabel(module, update, publishedOf(module), marketplaceName),
      withVersion ? `version ${module.version}` : null,
      plural(module.pages, "page"),
      module.functions > 0 ? plural(module.functions, "fonction") : null,
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
          update.blocked ? (
            <StatusBadge size="compact" title={update.blocked}>
              v{update.available} bloquée
            </StatusBadge>
          ) : (
            <StatusBadge tone="warning" size="compact">
              Mise à jour disponible : v{update.available}
            </StatusBadge>
          )
        ) : null}
        {publishedOf(module).some((publication) => publication.modified) ? (
          <StatusBadge size="compact" title="Le module a changé depuis sa dernière publication.">
            Modifié depuis la publication
          </StatusBadge>
        ) : null}
        {update?.pinned ? <StatusBadge size="compact">Figé</StatusBadge> : null}
        {update?.locallyModified ? (
          <StatusBadge tone="warning" size="compact" title="Le dossier du module diffère de ce qui a été installé.">
            Modifié sur place
          </StatusBadge>
        ) : null}
        {update?.sourceMissing ? (
          <StatusBadge tone="danger" size="compact" title={`Marketplace d’origine : ${update.source}`}>
            Sans marketplace
          </StatusBadge>
        ) : null}
        {update?.withdrawn ? (
          <StatusBadge tone="danger" size="compact">
            Retiré de son marketplace
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
          <MenuAction onSelect={() => openOnboarding(module.id, "intro")}>Configurer…</MenuAction>
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
            {installed ? "Retirer de l’espace de travail…" : "Supprimer…"}
          </MenuAction>
        </OverflowMenu>
      </div>
    );
  };

  /** D’où vient le module, en un mot pour le tableau. */
  const originShort = (module: ModuleSummary) => {
    if (module.origin && !module.origin.detached)
      return updateOf.get(module.id)?.marketplaceName ?? marketplaceName(module.origin.marketplace);
    if (module.origin?.detached) return "Détaché";
    return publishedOf(module).length > 0 ? "Local, publié" : "Local";
  };

  /** Tableau des modules installés : une ligne par module, qui ouvre sa fiche. */
  const columns: DataTableColumn<ModuleSummary>[] = [
    {
      key: "name",
      header: "Module",
      sortValue: (module) => module.name,
      render: (module) => (
        <span className="modules-table__module">
          {moduleIcon(module)}
          <span className="modules-table__text">
            <span className="modules-table__name">{module.name}</span>
            {module.description ? (
              <span className="modules-table__description" title={module.description}>
                {module.description}
              </span>
            ) : null}
          </span>
        </span>
      ),
    },
    { key: "version", header: "Version", width: "90px", sortValue: (module) => module.version },
    { key: "origin", header: "Origine", width: "150px", sortValue: originShort, render: originShort },
    {
      key: "state",
      header: "État",
      width: "190px",
      sortable: false,
      render: (module) => <span className="modules-table__badges">{moduleBadges(module)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      headerLabel: "Actions",
      align: "end",
      width: "150px",
      sortable: false,
      render: (module) => moduleActions(module),
    },
  ];

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
              <Button variant="primary" onClick={() => openOnboarding(module.id)}>
                Terminer la configuration
              </Button>
            }
          >
            Ce module n’est pas encore prêt. {remainingSummary(setup)}
          </FeedbackBanner>
        ) : null}
        {update?.sourceMissing ? (
          <Text size="meta" tone="muted">
            Son marketplace ({update.source}) n’est plus branché : l’ajouter de nouveau dans Réglages › Marketplace pour
            recevoir les mises à jour, ou détacher le module.
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
        {module.pages > 0 ? (
          <ModulePart
            part="pages"
            title="Pages"
            description="Choisissez les pages qui apparaissent dans le menu de gauche."
          >
            {snapshot ? <ModulePages snapshot={snapshot} module={module.id} disabled={hidden} /> : null}
          </ModulePart>
        ) : null}
        <ModuleFunctions module={module} clientLabels={module.clients.map((need) => need.label || need.id)} />
        <div className="module-part">
          <div className="module-part__head">
            <h3>Comptes</h3>
            <p>
              {single
                ? `Vos comptes ${single.label} (une boîte mail, un site…).${perInstance ? " Le module affiche une page par compte." : ""}`
                : "Vos comptes chez les services dont ce module a besoin. Le module sait comment s’y connecter : il ne vous demande que vos identifiants."}
            </p>
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
                  template={templateOf(modules, need.module, need.id)}
                  help={module.clients.find((item) => item.id === need.id)?.help || undefined}
                  controller={services}
                  onEdit={setEditingService}
                  titled={moduleNeeds.length > 1}
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
        </div>
        <TeamSync module={module} />
        <ModuleWebhooks module={module.id} />
        <ModuleSchedules module={module.id} />
        <ModuleJobs module={module.id} />
        {module.requires.length > 0 || module.requiredBy.length > 0 ? (
          <ModulePart part="dependencies" title="Dépendances">
            <ul className="modules-facts">
              {module.requires.map((required) => (
                <li key={`requires:${required.module}`}>
                  Utilise les fonctions et les services de{" "}
                  <button
                    type="button"
                    className="setup-flow__link"
                    onClick={() => setScreen({ kind: "module", id: required.module })}
                  >
                    {nameOf(required.module)}
                  </button>
                  {required.minVersion ? ` (v${required.minVersion} ou plus)` : ""}
                </li>
              ))}
              {module.requiredBy.map((user) => (
                <li key={`by:${user}`}>
                  Utilisé par{" "}
                  <button
                    type="button"
                    className="setup-flow__link"
                    onClick={() => setScreen({ kind: "module", id: user })}
                  >
                    {nameOf(user)}
                  </button>
                </li>
              ))}
            </ul>
          </ModulePart>
        ) : null}
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
        title="Modules installés"
        description="Ouvrez un module pour voir tout ce qu’il contient et connecter ses services."
        actions={
          <>
            {checking ? <Spinner label="Vérification des mises à jour" /> : null}
            <RefreshButton label="Vérifier les mises à jour" disabled={checking} onClick={() => void checkNow()} />
            {pending > 0 ? (
              <Button loading={busy === "all"} disabled={busy !== null} onClick={() => void updateAll()}>
                Tout mettre à jour ({pending})
              </Button>
            ) : null}
            <Button variant="primary" onClick={openMarketplaces}>
              Parcourir le marketplace
            </Button>
          </>
        }
      >
        {modules.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucun module"
            description="Demandez une page à l’agent : il crée un module pour vous. Vous pouvez aussi en importer un depuis le Marketplace."
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
              <DataTable
                label="Modules de l’espace de travail"
                columns={columns}
                rows={shown}
                rowKey={(module) => module.id}
                onRowClick={(module) => setScreen({ kind: "module", id: module.id })}
              />
            )}
          </div>
        )}
      </Section>
    </>
  );

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

  return (
    <Page>
      {screen.kind === "module" && moduleScreen ? moduleScreen : listScreen}

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
              title: `${opened.module.name} retiré de l’espace de travail`,
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
          onManage={() => {
            setOpened(null);
            openMarketplaces();
          }}
          onClose={() => setOpened(null)}
          onPublished={(version, marketplace) => {
            setOpened(null);
            notify({
              title: `${opened.module.name} v${version} publié`,
              description: `Sur ${marketplace.name}.`,
              tone: "success",
            });
            void afterSpaceChange();
            void loadPublications();
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
              description: "Annulable depuis l’historique de l’espace de travail.",
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
              description: `Pages reprises de ${opened.module.name}. Annulable depuis l’historique de l’espace de travail.`,
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
