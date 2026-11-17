import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  Page,
  RefreshButton,
  SearchField,
  Section,
  SelectControl,
  Spinner,
  StatusBadge,
  Text,
} from "@alfred/ui";
import { ArrowLeft, Boxes } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { openOnboarding } from "../setup/Onboarding";
import { type CatalogModule, errorMessage, type Marketplace, marketplaceApi } from "./api";
import { InstallDialog } from "./dialogs";
import { MarketplaceSources } from "./MarketplaceSources";
import { ModulePart } from "./ModulePart";
import { useModuleUpdatesStore } from "./useModuleUpdates";
import "./modules.css";

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

/** Où en est un module proposé vis-à-vis de l’espace de travail, en une pastille. */
function OfferStatus({ module }: { module: CatalogModule }) {
  if (module.error)
    return (
      <StatusBadge tone="danger" size="compact" title={module.error}>
        Illisible
      </StatusBadge>
    );
  if (module.installed)
    return (
      <StatusBadge tone="success" size="compact">
        Installé{module.installed !== module.version ? ` (v${module.installed})` : ""}
      </StatusBadge>
    );
  if (module.own)
    return (
      <StatusBadge tone="success" size="compact">
        Votre module
      </StatusBadge>
    );
  if (module.conflict)
    return (
      <StatusBadge tone="warning" size="compact" title="Un autre module de même identifiant est déjà installé.">
        Conflit
      </StatusBadge>
    );
  if (module.blocked)
    return (
      <StatusBadge tone="warning" size="compact" title={module.blocked}>
        Bloqué
      </StatusBadge>
    );
  return null;
}

const importable = (module: CatalogModule) =>
  !module.error && !module.installed && !module.own && !module.conflict && !module.blocked;

/** Liste simple de la fiche d’un module proposé : un élément par ligne. */
function Items({ items }: { items: Array<{ key: string; title: string; detail?: string; badge?: string }> }) {
  return (
    <ul className="modules-facts modules-offer__items">
      {items.map((item) => (
        <li key={item.key} className="modules-offer__item">
          <span className="modules-offer__item-title">{item.title}</span>
          {item.badge ? (
            <StatusBadge size="compact" tone="neutral">
              {item.badge}
            </StatusBadge>
          ) : null}
          {item.detail ? <span className="modules-offer__item-detail"> — {item.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Rubrique « Marketplace » des Réglages : tous les modules proposés par les marketplaces branchés, en un seul
 * catalogue ; la fiche d’un module (ce qu’il fait, ses pages, ses fonctions, les services qu’il demande) et son
 * import dans l’espace de travail ; et les marketplaces eux-mêmes (écran « Sources »).
 */
export function MarketplaceSettings() {
  const modules = useShell((state) => state.snapshot?.modules);
  const refreshSpace = useShell((state) => state.refresh);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);
  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [failures, setFailures] = useState<Array<{ marketplace: Marketplace; message: string }>>([]);
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
  }, []);

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

  const several = (marketplaces?.length ?? 0) > 1;
  const columns: DataTableColumn<Offer>[] = [
    {
      key: "name",
      header: "Module",
      sortValue: (offer) => offer.module.name,
      render: (offer) => (
        <span className="modules-table__module">
          <span className="module-row__icon product-color--steel" aria-hidden="true">
            <Boxes size={15} />
          </span>
          <span className="modules-table__text">
            <span className="modules-table__name">{offer.module.name}</span>
            <span className="modules-table__description" title={offer.module.description || undefined}>
              {offer.module.error ?? (offer.module.description || "Sans description")}
            </span>
          </span>
        </span>
      ),
    },
    ...(several
      ? [
          {
            key: "marketplace",
            header: "Marketplace",
            width: "150px",
            sortValue: (offer: Offer) => offer.marketplace.name,
            render: (offer: Offer) => offer.marketplace.name,
          },
        ]
      : []),
    {
      key: "version",
      header: "Version",
      width: "90px",
      sortValue: (offer) => offer.module.version ?? "",
      render: (offer) => (offer.module.version ? `v${offer.module.version}` : "—"),
    },
    {
      key: "status",
      header: "État",
      width: "130px",
      sortable: false,
      render: (offer) => <OfferStatus module={offer.module} />,
    },
    {
      key: "action",
      header: "Action",
      headerLabel: "Action",
      width: "110px",
      align: "end",
      sortable: false,
      render: (offer) =>
        importable(offer.module) ? (
          <Button aria-label={`Importer ${offer.module.name}`} onClick={() => setInstalling(offer)}>
            Importer
          </Button>
        ) : null,
    },
  ];

  const sourcesButton = (
    <Button onClick={() => setScreen({ kind: "sources" })}>
      Marketplaces branchés{marketplaces ? ` (${marketplaces.length})` : ""}
    </Button>
  );

  const catalogScreen = (
    <Section
      title="Modules disponibles"
      description="Tous les modules des marketplaces branchés. Ouvrez-en un pour voir ce qu’il fait avant de l’importer."
      actions={
        <>
          <RefreshButton
            label="Vérifier les marketplaces"
            loading={refreshing}
            disabled={refreshing}
            onClick={() => void refresh()}
          />
          {sourcesButton}
        </>
      }
    >
      {marketplaces === null || offers === null ? (
        <Spinner label="Chargement des modules disponibles" />
      ) : marketplaces.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucun marketplace branché"
          description="Un marketplace est le catalogue de modules partagé de votre équipe, rangé dans un dépôt git. Ajoutez son adresse pour voir ses modules."
        >
          <Button variant="primary" onClick={() => setScreen({ kind: "sources" })}>
            Ajouter un marketplace
          </Button>
        </EmptyState>
      ) : (
        <div className="module-list-view">
          {[
            ...failures,
            ...marketplaces
              .filter((m) => m.error)
              .map((marketplace) => ({ marketplace, message: marketplace.error ?? "" })),
          ]
            .filter(
              (item, index, all) => all.findIndex((other) => other.marketplace.id === item.marketplace.id) === index,
            )
            .map((item) => (
              <FeedbackBanner key={item.marketplace.id} tone="error" appearance="contained">
                {item.marketplace.name} : {item.message}
              </FeedbackBanner>
            ))}
          <div className="module-list-view__tools">
            <SearchField
              label="Rechercher un module"
              placeholder="Rechercher un module…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {several ? (
              <SelectControl
                aria-label="Marketplace affiché"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="all">Tous les marketplaces</option>
                {marketplaces.map((marketplace) => (
                  <option key={marketplace.id} value={marketplace.id}>
                    {marketplace.name}
                  </option>
                ))}
              </SelectControl>
            ) : null}
          </div>
          <DataTable
            label="Modules disponibles"
            columns={columns}
            rows={shown}
            rowKey={keyOf}
            onRowClick={(offer) => setScreen({ kind: "module", key: keyOf(offer) })}
            emptyTitle={offers.length === 0 ? "Aucun module proposé" : "Aucun module ne correspond"}
            emptyDescription={
              offers.length === 0
                ? "Les marketplaces branchés ne proposent encore aucun module. Publiez l’un des vôtres depuis Réglages → Modules."
                : "Changez la recherche."
            }
          />
        </div>
      )}
    </Section>
  );

  const offer = screen.kind === "module" ? offers?.find((candidate) => keyOf(candidate) === screen.key) : undefined;
  const back = (
    <Button onClick={() => setScreen({ kind: "catalog" })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Modules disponibles
    </Button>
  );

  const offerScreen = offer ? <OfferDetail offer={offer} back={back} onImport={() => setInstalling(offer)} /> : null;

  const sourcesScreen = <MarketplaceSources onChanged={() => void load()} actions={back} />;

  return (
    <Page>
      {screen.kind === "sources" ? sourcesScreen : (offerScreen ?? catalogScreen)}
      {installing ? (
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
      ) : null}
    </Page>
  );
}

/** Fiche d’un module proposé : ce qu’il fait et tout ce qu’il apporte, avant de l’importer. */
function OfferDetail({ offer, back, onImport }: { offer: Offer; back: ReactNode; onImport: () => void }) {
  const { module, marketplace } = offer;
  const functions = module.functions ?? [];
  const clients = module.clients ?? [];
  const automations = [
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
        : schedule.at
          ? `chaque jour à ${schedule.at}`
          : undefined,
    })),
  ];
  return (
    <Section
      title={module.name}
      description={module.description || undefined}
      actions={
        <>
          {back}
          {importable(module) ? (
            <Button variant="primary" onClick={onImport}>
              Importer
            </Button>
          ) : null}
        </>
      }
    >
      <div className="module-page">
        <p className="module-row__summary">
          <span>
            {[
              module.version ? `Version ${module.version}` : null,
              `Marketplace ${marketplace.name}`,
              plural(module.pages?.length ?? 0, "page"),
              functions.length ? plural(functions.length, "fonction") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <OfferStatus module={module} />
        </p>
        {module.error ? (
          <FeedbackBanner tone="error" appearance="contained">
            {module.error}
          </FeedbackBanner>
        ) : null}
        {module.blocked ? (
          <FeedbackBanner tone="warning" appearance="contained">
            {module.blocked}
          </FeedbackBanner>
        ) : null}
        {module.conflict ? (
          <FeedbackBanner tone="warning" appearance="contained">
            Un autre module « {module.id} » est déjà installé dans cet espace de travail : supprimez-le pour importer
            celui-ci.
          </FeedbackBanner>
        ) : null}
        <div className="module-page__body">
          {clients.length > 0 ? (
            <ModulePart
              part="services"
              title="Services nécessaires"
              description="Les comptes à connecter après l’import, guidés pas à pas."
            >
              <Items
                items={clients.map((client) => ({
                  key: client.id,
                  title: client.label || client.id,
                  badge: client.optional ? "Facultatif" : undefined,
                  detail: client.help || undefined,
                }))}
              />
            </ModulePart>
          ) : null}
          {(module.pages ?? []).length > 0 ? (
            <ModulePart part="pages" title="Pages" description="Ce qui apparaît dans le menu de gauche.">
              <Items
                items={(module.pages ?? []).map((page) => ({
                  key: page.id,
                  title: page.title,
                  detail: page.description || undefined,
                }))}
              />
            </ModulePart>
          ) : null}
          {functions.length > 0 ? (
            <ModulePart
              part="functions"
              title="Fonctions"
              description={
                clients.length > 0
                  ? `Ce que le module sait faire avec ${clients.map((client) => client.label || client.id).join(", ")}. Vos autres modules et l’agent peuvent s’en servir.`
                  : "Ce que le module sait faire. Vos autres modules et l’agent peuvent s’en servir."
              }
            >
              <Items
                items={functions.map((fn) => ({
                  key: fn.id,
                  title: fn.id,
                  badge: fn.effect === "write" ? "Écriture" : fn.effect === "read" ? "Lecture" : undefined,
                  detail:
                    [fn.description, fn.tool ? "proposée à l’agent" : null].filter(Boolean).join(" · ") || undefined,
                }))}
              />
            </ModulePart>
          ) : null}
          {automations.length > 0 ? (
            <ModulePart part="automations" title="Automatismes" description="Ce que le module lance de lui-même.">
              <Items items={automations} />
            </ModulePart>
          ) : null}
          {(module.dependencies ?? []).length > 0 || (module.requires ?? []).length > 0 ? (
            <ModulePart part="dependencies" title="Modules importés avec lui">
              <Items
                items={
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
                      }))
                }
              />
            </ModulePart>
          ) : null}
          {module.notes ? (
            <ModulePart part="notes" title="Notes de version">
              <Text>{module.notes}</Text>
            </ModulePart>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
