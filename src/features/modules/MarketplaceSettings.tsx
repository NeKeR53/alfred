import { ArrowLeft, Download, Eye, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Code, SearchInput, Select, type SettingsSection, type SettingTag } from "socle-ui";
import { Row, Stack } from "../../kit";
import { useLastKnown } from "../../shell/lastKnown";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { openOnboarding } from "../setup/Onboarding";
import { type CatalogModule, errorMessage, type Marketplace, marketplaceApi } from "./api";
import { InstallDialog } from "./dialogs";
import { useMarketplaceSourcesSection } from "./MarketplaceSources";
import { useModuleUpdatesStore } from "./useModuleUpdates";

/** Un module proposé, avec le marketplace qui le propose. */
interface Offer {
  marketplace: Marketplace;
  module: CatalogModule;
}

type Screen = { kind: "catalog" } | { kind: "module"; key: string } | { kind: "sources" };

const keyOf = (offer: Offer) => `${offer.marketplace.id}/${offer.module.id}`;

/** Minuscules sans accents, pour une recherche tolérante. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

const icon16 = { size: 16, "aria-hidden": true } as const;

/** Où en est un module proposé vis-à-vis de l’espace de travail, en une étiquette. */
function offerTag(module: CatalogModule): SettingTag | null {
  if (module.error) return { label: "Illisible", tone: "danger" };
  if (module.installed)
    return {
      label: `Installé${module.installed !== module.version ? ` (v${module.installed})` : ""}`,
      tone: "success",
    };
  if (module.own) return { label: "Votre module", tone: "success" };
  if (module.conflict) return { label: "Conflit", tone: "warning" };
  if (module.blocked) return { label: "Bloqué", tone: "warning" };
  return null;
}

const importable = (module: CatalogModule) =>
  !module.error && !module.installed && !module.own && !module.conflict && !module.blocked;

/**
 * Rubrique « Marketplace » des Réglages, décrite par sections : tous les modules proposés par les marketplaces
 * branchés, en un seul catalogue ; la fiche d’un module (ce qu’il fait, ses pages, ses fonctions, les services qu’il
 * demande) et son import dans l’espace de travail ; et les marketplaces eux-mêmes (écran « Sources »).
 */
export function useMarketplaceSections(): SettingsSection[] {
  const modules = useShell((state) => state.snapshot?.modules);
  const refreshSpace = useShell((state) => state.refresh);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);
  const [marketplaces, setMarketplaces] = useLastKnown<Marketplace[] | null>("marketplace/sources", null);
  const [offers, setOffers] = useLastKnown<Offer[] | null>("marketplace/modules", null);
  const [failures, setFailures] = useLastKnown<Array<{ marketplace: Marketplace; message: string; detail?: string }>>(
    "marketplace/echecs",
    [],
  );
  const [refreshing, setRefreshing] = useState(false);
  const [screen, setScreen] = useState<Screen>({ kind: "catalog" });
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [installing, setInstalling] = useState<Offer | null>(null);

  /** Relit les marketplaces branchés et le catalogue de chacun (sans réseau). */
  const load = useCallback(async () => {
    let list: Marketplace[];
    try {
      list = await marketplaceApi.list();
    } catch (failure) {
      setMarketplaces([]);
      setOffers([]);
      notify({ title: "Marketplaces illisibles", description: errorMessage(failure), tone: "error" });
      return;
    }
    setMarketplaces(list);
    const results = await Promise.all(
      list.map(async (marketplace) => {
        try {
          const entries = await marketplaceApi.modules(marketplace.id);
          return { marketplace, entries, message: null };
        } catch (failure) {
          return { marketplace, entries: [] as CatalogModule[], message: errorMessage(failure) };
        }
      }),
    );
    setOffers(results.flatMap(({ marketplace, entries }) => entries.map((module) => ({ marketplace, module }))));
    setFailures(results.flatMap(({ marketplace, message }) => (message ? [{ marketplace, message }] : [])));
  }, [setOffers, setMarketplaces, setFailures]);

  /** Interroge les marketplaces distants, puis relit le catalogue. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await marketplaceApi.refresh();
    } catch {
      // L’échec s’inscrit sur chaque marketplace : le catalogue le montre.
    } finally {
      await load();
      setRefreshing(false);
    }
  }, [load]);

  // L’état connu s’affiche tout de suite, la vérification réseau suit.
  useEffect(() => {
    void load().then(refresh);
  }, [load, refresh]);

  // Un import, une suppression ou une mise à jour change ce qui est « installé » : le catalogue se relit.
  const installedKey = (modules ?? []).map((module) => `${module.id}@${module.origin?.version ?? ""}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `installedKey` résume ce qui périme le catalogue.
  useEffect(() => {
    if (offers !== null) void load();
  }, [installedKey]);

  const folded = fold(query.trim());
  const shown = useMemo(
    () =>
      (offers ?? []).filter(
        (offer) =>
          (source === "all" || offer.marketplace.id === source) &&
          (!folded ||
            fold(`${offer.module.name} ${offer.module.description ?? ""} ${offer.module.id}`).includes(folded)),
      ),
    [offers, source, folded],
  );

  const back = {
    id: "back",
    label: "Modules disponibles",
    icon: <ArrowLeft {...icon16} />,
    onPress: () => setScreen({ kind: "catalog" }),
  };
  const sources = useMarketplaceSourcesSection({
    active: screen.kind === "sources",
    onChanged: () => void load(),
    back,
  });

  const dialog = installing ? (
    <InstallDialog
      module={installing.module}
      marketplace={installing.marketplace}
      onClose={() => setInstalling(null)}
      onConfirm={async () => {
        await marketplaceApi.install(installing.marketplace.id, installing.module.id);
        const imported = installing.module;
        setInstalling(null);
        await Promise.all([refreshSpace().catch(() => undefined), loadUpdates(false).catch(() => undefined)]);
        notify({ title: `${imported.name} importé`, tone: "success" });
        // Juste après l’import : l’onboarding présente le module, fait nommer ses pages et connecter ses comptes.
        useShell.getState().setActiveTab(SETTINGS_SECTION, "modules");
        openOnboarding(imported.id, "intro");
      }}
    />
  ) : undefined;

  if (screen.kind === "sources" && sources) return [sources];

  const offer = screen.kind === "module" ? offers?.find((candidate) => keyOf(candidate) === screen.key) : undefined;
  if (offer) return offerSections(offer, back, () => setInstalling(offer), dialog);

  const several = (marketplaces?.length ?? 0) > 1;
  const sourcesAction = {
    id: "sources",
    label: `Marketplaces branchés${marketplaces ? ` (${marketplaces.length})` : ""}`,
    icon: <Server {...icon16} />,
    onPress: () => setScreen({ kind: "sources" }),
  };
  const head = {
    id: "catalog",
    title: "Modules disponibles",
    description:
      "Tous les modules des marketplaces branchés. Ouvrez-en un pour voir ce qu’il fait avant de l’importer.",
    actions: [
      {
        id: "refresh",
        label: "Vérifier les marketplaces",
        icon: <RefreshCw {...icon16} />,
        isDisabled: refreshing,
        onPress: refresh,
      },
      sourcesAction,
    ],
  };
  if (marketplaces === null || offers === null)
    return [{ ...head, emptyMessage: "Chargement des modules disponibles…", content: dialog }];
  if (marketplaces.length === 0)
    return [
      {
        ...head,
        actions: [{ ...sourcesAction, label: "Ajouter un marketplace", primary: true }],
        emptyMessage:
          "Aucun marketplace branché. Un marketplace est le catalogue de modules partagé de votre équipe, rangé dans un dépôt git. Ajoutez son adresse pour voir ses modules.",
      },
    ];
  const problems = [
    ...failures,
    ...marketplaces
      .filter((m) => m.error)
      .map((marketplace) => ({ marketplace, message: marketplace.error ?? "", detail: marketplace.errorDetail })),
  ].filter((item, index, all) => all.findIndex((other) => other.marketplace.id === item.marketplace.id) === index);

  return [
    {
      id: "tools",
      content: (
        <Stack gap="sm">
          {problems.map((item) => (
            <Alert key={item.marketplace.id} tone="danger" title={item.marketplace.name}>
              {item.message}
              {item.detail ? <Code block>{item.detail}</Code> : null}
            </Alert>
          ))}
          <Row gap="md" wrap>
            <SearchInput label="les modules" onChange={({ text }) => setQuery(text)} />
            {several ? (
              <Select
                label="Marketplace affiché"
                width="sm"
                value={source}
                options={[
                  { id: "all", label: "Tous les marketplaces" },
                  ...marketplaces.map((marketplace) => ({ id: marketplace.id, label: marketplace.name })),
                ]}
                onChange={(id) => setSource(id ?? "all")}
              />
            ) : null}
          </Row>
        </Stack>
      ),
    },
    {
      ...head,
      settings: shown.map((item) => {
        const tag = offerTag(item.module);
        return {
          type: "item" as const,
          id: keyOf(item),
          label: item.module.name,
          code: item.module.version ? `v${item.module.version}` : undefined,
          description: [
            several ? item.marketplace.name : null,
            item.module.error ?? (item.module.description || "Sans description"),
          ]
            .filter(Boolean)
            .join(" · "),
          tags: tag ? [tag] : undefined,
          actions: [
            ...(importable(item.module)
              ? [
                  {
                    id: "import",
                    label: `Importer ${item.module.name}`,
                    icon: <Download {...icon16} />,
                    onPress: () => setInstalling(item),
                  },
                ]
              : []),
            {
              id: "open",
              label: `Voir ${item.module.name}`,
              icon: <Eye {...icon16} />,
              onPress: () => setScreen({ kind: "module", key: keyOf(item) }),
            },
          ],
        };
      }),
      emptyMessage:
        offers.length === 0
          ? "Aucun module proposé : les marketplaces branchés ne proposent encore aucun module. Publiez l’un des vôtres depuis Réglages → Modules."
          : "Aucun module ne correspond. Changez la recherche.",
      content: dialog,
    },
  ];
}

type Item = { key: string; title: string; detail?: string; badge?: string };

const itemRows = (items: Item[]) =>
  items.map((item) => ({
    type: "item" as const,
    id: item.key,
    label: item.title,
    description: item.detail,
    tags: item.badge ? [{ label: item.badge, tone: "neutral" as const }] : undefined,
  }));

/** Fiche d’un module proposé : ce qu’il fait et tout ce qu’il apporte, avant de l’importer. */
function offerSections(
  offer: Offer,
  back: { id: string; label: string; icon: React.ReactNode; onPress: () => void },
  onImport: () => void,
  dialog: React.ReactNode,
): SettingsSection[] {
  const { module, marketplace } = offer;
  const functions = module.functions ?? [];
  const clients = module.clients ?? [];
  const tag = offerTag(module);
  const automations: Item[] = [
    ...(module.webhooks ?? []).map((webhook) => ({
      key: `webhook:${webhook.id}`,
      title: webhook.description || webhook.id,
      badge: "Webhook",
      detail: `déclenche ${webhook.function}`,
    })),
    ...(module.schedules ?? []).map((schedule) => ({
      key: `schedule:${schedule.id}`,
      title: schedule.description || schedule.id,
      badge: "Planification",
      detail: schedule.everyMinutes
        ? `toutes les ${schedule.everyMinutes} min`
        : schedule.everySeconds
          ? `toutes les ${schedule.everySeconds} s`
          : schedule.at
            ? `chaque jour à ${schedule.at}`
            : undefined,
    })),
  ];
  const sections: SettingsSection[] = [
    {
      id: "offer",
      title: module.name,
      description: module.description || undefined,
      actions: [
        back,
        ...(importable(module) ? [{ id: "import", label: "Importer", primary: true, onPress: onImport }] : []),
      ],
      settings: [
        {
          type: "info",
          id: "summary",
          label: "Contenu",
          value: [
            module.version ? `Version ${module.version}` : null,
            `Marketplace ${marketplace.name}`,
            plural(module.pages?.length ?? 0, "page"),
            functions.length ? plural(functions.length, "fonction") : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
        ...(tag ? [{ type: "item" as const, id: "state", label: "État", tags: [tag] }] : []),
      ],
      content:
        module.error || module.blocked || module.conflict || dialog ? (
          <Stack gap="sm">
            {module.error ? (
              <Alert announce tone="danger">
                {module.error}
              </Alert>
            ) : null}
            {module.blocked ? <Alert tone="warning">{module.blocked}</Alert> : null}
            {module.conflict ? (
              <Alert tone="warning">
                {`Un autre module « ${module.id} » est déjà installé dans cet espace de travail : supprimez-le pour importer celui-ci.`}
              </Alert>
            ) : null}
            {dialog}
          </Stack>
        ) : undefined,
    },
  ];
  if (clients.length > 0)
    sections.push({
      id: "services",
      title: "Services nécessaires",
      description: "Les comptes à connecter après l’import, guidés pas à pas.",
      settings: itemRows(
        clients.map((client) => ({
          key: client.id,
          title: client.label || client.id,
          badge: client.optional ? "Facultatif" : undefined,
          detail: client.help || undefined,
        })),
      ),
    });
  if ((module.pages ?? []).length > 0)
    sections.push({
      id: "pages",
      title: "Pages",
      description: "Ce qui apparaît dans le menu de gauche.",
      settings: itemRows(
        (module.pages ?? []).map((page) => ({
          key: page.id,
          title: page.title,
          detail: page.description || undefined,
        })),
      ),
    });
  if (functions.length > 0)
    sections.push({
      id: "functions",
      title: "Fonctions",
      description:
        clients.length > 0
          ? `Ce que le module sait faire avec ${clients.map((client) => client.label || client.id).join(", ")}. Vos autres modules et l’agent peuvent s’en servir.`
          : "Ce que le module sait faire. Vos autres modules et l’agent peuvent s’en servir.",
      settings: itemRows(
        functions.map((fn) => ({
          key: fn.id,
          title: fn.id,
          badge: fn.effect === "write" ? "Écriture" : fn.effect === "read" ? "Lecture" : undefined,
          detail: [fn.description, fn.tool ? "proposée à l’agent" : null].filter(Boolean).join(" · ") || undefined,
        })),
      ),
    });
  if (automations.length > 0)
    sections.push({
      id: "automations",
      title: "Automatismes",
      description: "Ce que le module lance de lui-même.",
      settings: itemRows(automations),
    });
  if ((module.dependencies ?? []).length > 0 || (module.requires ?? []).length > 0)
    sections.push({
      id: "dependencies",
      title: "Modules importés avec lui",
      settings: itemRows(
        (module.dependencies ?? []).length > 0
          ? (module.dependencies ?? []).map((step) => ({
              key: step.module,
              title: step.name,
              detail: `v${step.version}, ${step.action === "install" ? "importé avec lui" : "mis à jour avec lui"}`,
            }))
          : (module.requires ?? []).map((requirement) => ({
              key: requirement.module,
              title: requirement.module,
              detail: requirement.minVersion ? `v${requirement.minVersion} ou plus` : undefined,
            })),
      ),
    });
  if (module.notes)
    sections.push({ id: "notes", title: "Notes de version", content: <Code block>{module.notes}</Code> });
  return sections;
}
