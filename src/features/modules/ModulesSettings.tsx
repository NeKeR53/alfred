import { ArrowLeft, ChevronRight, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Action,
  SearchField,
  Select,
  type Setting,
  type SettingsSection,
  type SettingTag,
  useConfirm,
} from "socle-ui";
import { Row } from "../../kit";
import type { ModuleSummary } from "../../lib/types";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { isModuleHidden, SETTINGS_SECTION, setModuleHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { useAutomationsSection } from "../automations/ModuleAutomations";
import type { ClientNeedItem } from "../clients/api";
import { serviceNeedsAttention } from "../clients/ServiceBlock";
import { type ServiceEditing, ServiceEditor } from "../clients/ServiceEditor";
import { useClients } from "../clients/useClients";
import { useFoldersSection } from "../folders/ModuleFolders";
import { useJobsSection } from "../jobs/ModuleJobs";
import { MODULE_FOCUS } from "../settings/open";
import { remainingSummary, type SetupStep } from "../setup/api";
import { openOnboarding, useOnboarding } from "../setup/Onboarding";
import { verify } from "../setup/SetupGate";
import { useModuleSetup } from "../setup/useModuleSetup";
import { ModuleExportDialog } from "../space/ModuleDataDialog";
import { TeamSync } from "../teamSync/TeamSync";
import { errorMessage, type Marketplace, type ModulePublication, type ModuleUpdate, marketplaceApi } from "./api";
import { PublishDialog, UninstallDialog, UpdateDialog } from "./dialogs";
import { useModuleContentSections } from "./ModuleContents";
import { MergeDialog, modulePages, SplitDialog } from "./reorganize";
import { countPendingUpdates, useModuleUpdatesStore } from "./useModuleUpdates";

export { useModuleUpdates } from "./useModuleUpdates";

const NO_MODULES: ModuleSummary[] = [];

type Opened =
  | { kind: "update"; module: string }
  | { kind: "uninstall"; module: ModuleSummary }
  | { kind: "publish"; module: ModuleSummary }
  | { kind: "merge"; module: ModuleSummary }
  | { kind: "split"; module: ModuleSummary }
  | { kind: "export"; module: ModuleSummary };

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

export { MODULE_FOCUS } from "../settings/open";

/** Ouvre la rubrique Marketplace des Réglages : catalogue des modules à importer, et marketplaces branchés. */
export function openMarketplaces() {
  useShell.getState().setActiveTab(SETTINGS_SECTION, "marketplace");
}

const icon16 = { size: 16, "aria-hidden": true } as const;

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
 * Rubrique « Modules » des Réglages, décrite par sections : les modules installés dans l’espace de travail (une
 * ligne chacun : activer, mettre à jour, publier, retirer), et la fiche de chacun avec tout ce qu’il contient :
 * pages, services et comptes, fonctions, automatisations, tâches de fond, dossiers, dépendances. Importer un module
 * se fait dans la rubrique Marketplace (`useMarketplaceSections`).
 */
export function useModulesSections(): SettingsSection[] {
  const modules = useShell((state) => state.snapshot?.modules) ?? NO_MODULES;
  const refreshSpace = useShell((state) => state.refresh);
  const updates = useModuleUpdatesStore((state) => state.updates);
  const checking = useModuleUpdatesStore((state) => state.checking);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);

  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [publications, setPublications] = useState<ModulePublication[]>([]);
  /** Modules dont les comptes ont déjà été testés d’office. */
  const autoTested = useRef(new Set<string>());
  const [opened, setOpened] = useState<Opened | null>(null);
  const confirm = useConfirm();
  const snapshot = useShell((state) => state.snapshot);
  const services = useClients();
  // Relu avec les services et l’espace : ce sont eux qui font avancer la configuration des modules.
  const setups = useModuleSetup({ listen: false });
  const reloadSetups = setups.load;
  useEffect(() => {
    if (services.overview || snapshot) void reloadSetups();
  }, [services.overview, snapshot, reloadSetups]);
  const [editingService, setEditingService] = useState<ServiceEditing>();
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

  const run = async (action: () => Promise<void>, failureTitle: string) => {
    try {
      await action();
    } catch (failure) {
      notify({ title: failureTitle, description: errorMessage(failure), tone: "error" });
    }
  };

  const updateAll = () =>
    run(async () => {
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
    }, "Mise à jour impossible");

  const togglePin = (module: ModuleSummary, pinned: boolean) =>
    run(async () => {
      await marketplaceApi.pin(module.id, pinned);
      await afterSpaceChange();
      notify({
        title: pinned ? `${module.name} figé sur la v${module.version}` : `${module.name} libéré`,
        description: pinned
          ? "Ses mises à jour restent signalées, mais « Tout mettre à jour » le laisse de côté."
          : "« Tout mettre à jour » le prend de nouveau en compte.",
        tone: "success",
      });
    }, "Changement impossible");

  const detach = async (module: ModuleSummary) => {
    const accepted = await confirm({
      title: `Détacher ${module.name} ?`,
      message:
        "Le module devient le vôtre et modifiable. Il garde la trace de son origine, mais ne recevra plus aucune mise à jour de son marketplace.",
      confirmLabel: "Détacher",
      tone: "default",
    });
    if (!accepted) return;
    await run(async () => {
      await marketplaceApi.detach(module.id);
      await afterSpaceChange();
      notify({ title: `${module.name} détaché`, description: "Il est maintenant modifiable.", tone: "success" });
    }, "Détachement impossible");
  };

  const openedUpdate = opened?.kind === "update" ? updateOf.get(opened.module) : undefined;
  const openedModule = screen.kind === "module" ? modules.find((module) => module.id === screen.id) : undefined;
  const openedId = openedModule?.id;
  const focusedSetup = openedId ? setups.of(openedId) : undefined;
  // Les comptes d’un service à un seul compte n’ont pas de nom à eux : la phrase nomme le service seul.
  const accountsOfStep = (step: SetupStep) => {
    const client = services.overview?.clients.find((candidate) => candidate.id === step.client);
    return client && !client.simple ? client.instances : [];
  };
  const openedLeft = focusedSetup?.steps.filter((step) => !step.optional && step.state !== "ready") ?? [];
  /** Il ne manque qu’un test (réussi) : le bouton teste, au lieu d’ouvrir la configuration. */
  const onlyTests =
    openedLeft.length > 0 && openedLeft.every((step) => step.state === "untested" || step.state === "failed");
  // Un compte prêt jamais testé l’est d’office, une fois par fiche, comme sur la page d’attente.
  // L’onboarding ouvert teste lui-même ses comptes : la fiche, derrière, ne le double pas.
  const onboarding = useOnboarding((state) => state.module);
  const untested = !onboarding && openedLeft.some((step) => step.state === "untested");
  const runTestsRef = useRef<(again: boolean) => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!openedId || !untested || autoTested.current.has(openedId)) return;
    autoTested.current.add(openedId);
    void runTestsRef.current(false);
  }, [openedId, untested]);
  const runTests = async (again: boolean) => {
    try {
      await verify(openedLeft, again);
    } catch (failure) {
      notify({ title: "Le test n’a pas pu être lancé", description: errorMessage(failure), tone: "error" });
    } finally {
      await services.load();
      await reloadSetups();
    }
  };
  runTestsRef.current = runTests;

  const nameOf = (id: string) => modules.find((candidate) => candidate.id === id)?.name || id;
  const hiddenOf = (module: ModuleSummary) => (snapshot ? isModuleHidden(snapshot, module.id) : module.hidden);

  // Les crochets des parties de la fiche tournent toujours ; sans fiche ouverte, ils ne rendent rien.
  const contentSections = useModuleContentSections({
    module: editingService ? undefined : openedModule,
    modules,
    snapshot: snapshot ?? null,
    services,
    onEditService: setEditingService,
    hidden: openedModule ? hiddenOf(openedModule) : false,
    nameOf,
  });
  const fiche = editingService ? undefined : openedModule;
  const foldersSection = useFoldersSection(fiche ? { id: fiche.id, name: fiche.name } : undefined);
  const automationsSection = useAutomationsSection(fiche?.id);
  const jobsSection = useJobsSection(fiche?.id);

  if (editingService) {
    return [
      {
        id: "account",
        content: (
          <ServiceEditor
            editing={editingService}
            redirectUri={services.overview?.redirectUri ?? null}
            onDone={() => {
              setEditingService(undefined);
              void services.load();
            }}
          />
        ),
      },
    ];
  }

  const clients = services.overview?.clients ?? [];
  const needs = services.overview?.needs ?? [];
  const clientOf = (need: ClientNeedItem) => clients.find((client) => client.id === need.client);
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

  const marketplaceName = (url: string) =>
    marketplaces?.find((marketplace) => marketplace.url.replace(/(\.git)?\/?$/, "") === url.replace(/(\.git)?\/?$/, ""))
      ?.name ?? url;
  const publishedOf = (module: ModuleSummary) => publications.filter((publication) => publication.module === module.id);

  /** Résumé en mots simples : d’où vient le module, ce qu’il contient. */
  const moduleSummary = (module: ModuleSummary) => {
    const update = updateOf.get(module.id);
    const installed = module.origin !== null && !module.origin.detached;
    const serviceCount = needs.filter((need) => need.module === module.id).length;
    return [
      originLabel(module, update, publishedOf(module), marketplaceName),
      `version ${module.version}`,
      plural(module.pages, "page"),
      module.functions > 0 ? plural(module.functions, "fonction") : null,
      serviceCount > 0 ? plural(serviceCount, "service") : null,
      installed ? "lecture seule" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  /** Étiquettes d’état : ce qui demande l’attention de l’utilisateur. */
  const moduleTags = (module: ModuleSummary): SettingTag[] => {
    const update = updateOf.get(module.id);
    const tags: Array<SettingTag | null> = [
      hiddenOf(module) ? { label: "Désactivé", tone: "neutral" } : null,
      needsAttention(module) ? { label: "À configurer", tone: "pending" } : null,
      update?.available
        ? update.blocked
          ? { label: `v${update.available} bloquée`, tone: "neutral" }
          : { label: `Mise à jour v${update.available}`, tone: "pending" }
        : null,
      publishedOf(module).some((publication) => publication.modified)
        ? { label: "Modifié depuis la publication", tone: "neutral" }
        : null,
      update?.pinned ? { label: "Figé", tone: "neutral" } : null,
      update?.locallyModified ? { label: "Modifié sur place", tone: "warning" } : null,
      update?.sourceMissing ? { label: "Sans marketplace", tone: "danger" } : null,
      update?.withdrawn ? { label: "Retiré de son marketplace", tone: "danger" } : null,
    ];
    return tags.filter((tag): tag is SettingTag => tag !== null);
  };

  const setHidden = (module: ModuleSummary, hidden: boolean) =>
    applyLayoutChange((current) => setModuleHidden(current, module.id, hidden));

  /** Actions d’un module : les mêmes dans la liste et dans sa fiche, sauf l’ouverture. */
  const moduleActions = (module: ModuleSummary, inList: boolean): Action[] => {
    const update = updateOf.get(module.id);
    const installed = module.origin !== null && !module.origin.detached;
    const hidden = hiddenOf(module);
    return [
      ...(inList
        ? [
            {
              id: "open",
              label: `Ouvrir la fiche de ${module.name}`,
              icon: <ChevronRight {...icon16} />,
              onPress: () => setScreen({ kind: "module", id: module.id }),
            },
          ]
        : []),
      ...(update?.available
        ? [
            {
              id: "update",
              label: `Mettre à jour ${module.name}`,
              icon: <Download {...icon16} />,
              onPress: () => setOpened({ kind: "update", module: module.id }),
            },
          ]
        : []),
      ...(inList
        ? [
            {
              id: "toggle",
              label: hidden ? "Activer le module" : "Désactiver le module",
              onPress: () => setHidden(module, !hidden),
            },
          ]
        : []),
      { id: "configure", label: "Configurer…", onPress: () => openOnboarding(module.id, "intro") },
      { id: "export", label: "Exporter les données…", onPress: () => setOpened({ kind: "export", module }) },
      ...(installed
        ? [
            {
              id: "pin",
              label: module.origin?.pinned ? "Libérer" : "Figer sur cette version",
              onPress: () => togglePin(module, !module.origin?.pinned),
            },
            { id: "detach", label: "Détacher…", onPress: () => detach(module) },
          ]
        : [
            { id: "publish", label: "Publier…", onPress: () => setOpened({ kind: "publish", module }) },
            { id: "merge", label: "Fusionner avec…", onPress: () => setOpened({ kind: "merge", module }) },
            { id: "split", label: "Scinder…", onPress: () => setOpened({ kind: "split", module }) },
          ]),
      {
        id: "uninstall",
        label: installed ? "Retirer de l’espace de travail…" : "Supprimer…",
        onPress: () => setOpened({ kind: "uninstall", module }),
      },
    ];
  };

  /** D’où vient le module, en un mot pour la liste. */
  const originShort = (module: ModuleSummary) => {
    if (module.origin && !module.origin.detached)
      return updateOf.get(module.id)?.marketplaceName ?? marketplaceName(module.origin.marketplace);
    if (module.origin?.detached) return "Détaché";
    return publishedOf(module).length > 0 ? "Local, publié" : "Local";
  };

  const dialogs = (
    <>
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
            setScreen({ kind: "list" });
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
      {opened?.kind === "export" ? (
        <ModuleExportDialog modules={modules} initial={opened.module.id} onClose={() => setOpened(null)} />
      ) : null}
    </>
  );

  if (openedModule) {
    const module = openedModule;
    const hidden = hiddenOf(module);
    const update = updateOf.get(module.id);
    const setup = setups.of(module.id);
    const tags = moduleTags(module);
    const settings: Setting[] = [
      { type: "info", id: "summary", label: "Origine et contenu", value: moduleSummary(module) },
      ...(tags.length > 0 ? [{ type: "item" as const, id: "state", label: "État", tags }] : []),
      ...(setup && !setup.ready
        ? [
            {
              type: "info" as const,
              id: "todo",
              label: "Reste à faire",
              value: remainingSummary(setup, accountsOfStep),
            },
          ]
        : []),
      {
        type: "switch",
        id: "enabled",
        label: "Module activé",
        description: hidden
          ? `Module désactivé : ses pages n’apparaissent pas dans le menu.${
              module.requiredBy.length > 0
                ? ` Ses services restent utilisés par ${module.requiredBy.map(nameOf).join(", ")}.`
                : ""
            }`
          : "Ses pages apparaissent dans le menu.",
        value: !hidden,
        onChange: (on) => setHidden(module, !on),
      },
      ...(update?.sourceMissing
        ? [
            {
              type: "info" as const,
              id: "source",
              label: "Marketplace d’origine",
              value: `Son marketplace (${update.source}) n’est plus branché : l’ajouter de nouveau dans Réglages › Marketplace pour recevoir les mises à jour, ou détacher le module.`,
            },
          ]
        : []),
    ];
    const head: SettingsSection = {
      id: "module",
      title: module.name,
      description: module.description || undefined,
      actions: [
        {
          id: "back",
          label: "Tous les modules",
          icon: <ArrowLeft {...icon16} />,
          onPress: () => setScreen({ kind: "list" }),
        },
        ...(setup && !setup.ready
          ? [
              onlyTests
                ? { id: "test", label: "Tester les comptes", primary: true, onPress: () => runTests(true) }
                : {
                    id: "finish",
                    label: "Terminer la configuration",
                    primary: true,
                    onPress: () => openOnboarding(module.id),
                  },
            ]
          : []),
        ...moduleActions(module, false),
      ],
      settings,
      content: dialogs,
    };
    const dependencies: SettingsSection | null =
      module.requires.length > 0 || module.requiredBy.length > 0
        ? {
            id: "dependencies",
            title: "Dépendances",
            description: "Les modules dont celui-ci se sert, et ceux qui se servent de lui.",
            settings: [
              ...module.requires.map((required) => ({
                type: "item" as const,
                id: `requires:${required.module}`,
                label: nameOf(required.module),
                description: `Ce module utilise ses fonctions et ses services${required.minVersion ? ` (v${required.minVersion} ou plus)` : ""}.`,
                actions: [
                  {
                    id: "open",
                    label: `Ouvrir la fiche de ${nameOf(required.module)}`,
                    icon: <ChevronRight {...icon16} />,
                    onPress: () => setScreen({ kind: "module", id: required.module }),
                  },
                ],
              })),
              ...module.requiredBy.map((user) => ({
                type: "item" as const,
                id: `by:${user}`,
                label: nameOf(user),
                description: "Se sert de ce module.",
                actions: [
                  {
                    id: "open",
                    label: `Ouvrir la fiche de ${nameOf(user)}`,
                    icon: <ChevronRight {...icon16} />,
                    onPress: () => setScreen({ kind: "module", id: user }),
                  },
                ],
              })),
            ],
          }
        : null;
    return [
      head,
      ...contentSections,
      ...(foldersSection ? [foldersSection] : []),
      { id: "team", content: <TeamSync module={module} /> },
      ...(automationsSection ? [automationsSection] : []),
      ...(jobsSection ? [jobsSection] : []),
      ...(dependencies ? [dependencies] : []),
    ];
  }

  const filters: Array<{ id: Filter; label: string; count?: number }> = [
    { id: "all", label: "Tous" },
    { id: "attention", label: "À configurer", count: counts.attention },
    { id: "updates", label: "Mises à jour", count: counts.updates },
    { id: "off", label: "Désactivés", count: counts.off },
  ];
  const tools = modules.length > 5 || filter !== "all" || query;
  const listSettings: Setting[] = [
    ...(counts.attention > 0 && filter !== "attention"
      ? [
          {
            type: "action" as const,
            id: "attention",
            label: counts.attention > 1 ? `${counts.attention} modules à configurer` : "1 module à configurer",
            action: { id: "show", label: "Les afficher", onPress: () => setFilter("attention") },
          },
        ]
      : []),
    ...shown.map((module) => ({
      type: "item" as const,
      id: module.id,
      label: module.name,
      code: `v${module.version}`,
      description: [originShort(module), module.description].filter(Boolean).join(" · "),
      tags: moduleTags(module),
      actions: moduleActions(module, true),
    })),
  ];
  return [
    ...(tools
      ? [
          {
            id: "tools",
            content: (
              <Row gap="md" wrap>
                <SearchField label="les modules" onChange={({ text }) => setQuery(text)} />
                <Select
                  label="Afficher"
                  width="sm"
                  value={filter}
                  options={filters
                    .filter((choice) => choice.id === "all" || choice.id === filter || (choice.count ?? 0) > 0)
                    .map((choice) => ({
                      id: choice.id,
                      label: choice.count ? `${choice.label} (${choice.count})` : choice.label,
                    }))}
                  onChange={(id) => setFilter((id as Filter | null) ?? "all")}
                />
              </Row>
            ),
          },
        ]
      : []),
    {
      id: "installed",
      title: "Modules installés",
      description: "Ouvrez un module pour voir tout ce qu’il contient et connecter ses services.",
      actions: [
        {
          id: "check",
          label: "Vérifier les mises à jour",
          icon: <RefreshCw {...icon16} />,
          isDisabled: checking,
          onPress: checkNow,
        },
        ...(pending > 0
          ? [
              {
                id: "update-all",
                label: `Tout mettre à jour (${pending})`,
                icon: <Download {...icon16} />,
                onPress: updateAll,
              },
            ]
          : []),
        { id: "browse", label: "Parcourir le marketplace", primary: true, onPress: openMarketplaces },
      ],
      settings: listSettings,
      emptyMessage:
        modules.length === 0
          ? "Aucun module. Demandez une page à l’agent : il crée un module pour vous. Vous pouvez aussi en importer un depuis le Marketplace."
          : "Aucun module ne correspond. Changez la recherche ou le filtre.",
      content: dialogs,
    },
  ];
}
