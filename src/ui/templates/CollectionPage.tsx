import { type ReactNode, useMemo } from "react";
import { Button } from "../components/Button";
import { ChoiceButton, ChoiceGroup } from "../components/ChoiceButton";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { FeedbackBanner } from "../components/FeedbackBanner";
import { SelectControl } from "../components/FormControls";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { PageToolbar, ToolbarSeparator } from "../components/PageToolbar";
import { Page } from "../components/page";
import { RefreshButton } from "../components/RefreshButton";
import { SearchField } from "../components/SearchField";
import { type Action, ActionBar } from "./actions";
import { columnLayout, FormattedValue, type StatusMap, sortValueOf, type ValueType, valueText } from "./format";
import { usePageState } from "./pageState";
import { useFrameServices, useReloadOnPeerChange } from "./services";
import { useLoad } from "./useLoad";

/** Une colonne, décrite par sa donnée : le type fixe format, alignement, largeur et tri. */
export interface Column<Row> {
  /** Clé lue dans la ligne (`row[key]`), sauf si `value` est donné. */
  key: string;
  /** En-tête, court : « Titre », « État », « Échéance ». */
  header: string;
  type?: ValueType;
  /** Valeur à afficher quand elle ne se lit pas directement dans `row[key]`. */
  value?: (row: Row) => unknown;
  /** Pour `type: "status"` : valeur → libellé et ton. */
  statuses?: StatusMap;
  currency?: string;
}

/** Un filtre de la barre : une liste « Tous les … » suivie des valeurs. */
export interface CollectionFilter<Row> {
  /** Nom du filtre, pour les lecteurs d’écran : « État ». */
  label: string;
  /** Première entrée, sans filtre : « Tous les états ». */
  all: string;
  /** Valeur de la ligne comparée aux options. */
  value: (row: Row) => string | null | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
}

const read = <Row,>(row: Row, column: Column<Row>) =>
  column.value ? column.value(row) : (row as Record<string, unknown>)[column.key];

/**
 * Gabarit d’une collection (un onglet qui liste des objets) : barre d’outils (recherche, filtres, actualisation,
 * actions), tableau dense trié au clic, état vide, chargement, erreur, et lien avec le panneau de détail. La page
 * décrit ses données ; Alfred les dispose.
 */
export function CollectionPage<Row>({
  load,
  deps = [],
  rowKey,
  columns,
  label,
  emptyTitle,
  emptyDescription,
  search,
  filters = [],
  views,
  actions = [],
  rowActions,
  onOpen,
  panel = false,
  banner,
}: {
  /** Charge toutes les lignes (`db.query`, une fonction, un client). Relancé par Actualiser et après une écriture. */
  load: () => Promise<Row[]>;
  /** Relance `load` quand une de ces valeurs change (comme `useEffect`). */
  deps?: ReadonlyArray<unknown>;
  rowKey: (row: Row) => string | number;
  /** Colonnes, l’identité de l’objet en premier ; cinq au plus. */
  columns: ReadonlyArray<Column<Row>>;
  /** Nom de la collection : « Tâches ». */
  label: string;
  /** « Aucune tâche ». */
  emptyTitle: string;
  /** À quoi sert la page, une phrase. */
  emptyDescription?: string;
  /** Recherche : son nom (« Rechercher une tâche ») et le texte de la ligne dans lequel chercher. */
  search?: { label: string; text?: (row: Row) => string };
  /** Filtres en liste, dans la barre ; deux au plus. */
  filters?: ReadonlyArray<CollectionFilter<Row>>;
  /** Vues prédéfinies, en boutons segmentés à gauche (« Ouvertes », « Toutes ») ; quatre au plus. */
  views?: { label: string; items: ReadonlyArray<{ id: string; label: string; test: (row: Row) => boolean }> };
  /** Actions sur toute la collection ; l’action `primary` (« Nouvelle tâche ») revient dans l’état vide. */
  actions?: ReadonlyArray<Action>;
  /** Actions d’une ligne : deux icônes au plus, le reste dans « ⋯ ». */
  rowActions?: (row: Row) => ReadonlyArray<Action>;
  /** Ouvre une ligne (autre page, fenêtre). Sans lui et avec `panel`, la ligne s’affiche dans le panneau. */
  onOpen?: (row: Row) => void;
  /** La page a un panneau de détail (`DetailPanel`) : un clic publie `{ id }` et ouvre le panneau. */
  panel?: boolean;
  /** Message persistant au-dessus de la liste (`FeedbackBanner` d’un prérequis manquant). */
  banner?: ReactNode;
}) {
  const services = useFrameServices();
  const state = useLoad(load, deps);
  useReloadOnPeerChange(state.reload);
  // Retenus par Alfred : en revenant sur la page, la recherche, les filtres, la vue et la ligne ouverte sont là.
  const [query, setQuery] = usePageState("alfred:collection:query", "");
  const [keptFilters, setFilterValues] = usePageState<string[]>("alfred:collection:filters", () =>
    filters.map(() => ""),
  );
  // Des filtres ajoutés ou retirés depuis : chacun retrouve sa place, les nouveaux partent vides.
  const filterValues = filters.map((_, index) => keptFilters[index] ?? "");
  const [keptView, setView] = usePageState("alfred:collection:view", views?.items[0]?.id ?? "");
  const view = views?.items.some((item) => item.id === keptView) ? keptView : (views?.items[0]?.id ?? "");
  const [selected, setSelected] = usePageState<string | number | null>("alfred:collection:selected", null);

  const rows = state.data ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("fr");
    const viewTest = views?.items.find((item) => item.id === view)?.test;
    return rows.filter((row) => {
      if (viewTest && !viewTest(row)) return false;
      if (filters.some((filter, index) => filterValues[index] && filter.value(row) !== filterValues[index]))
        return false;
      if (!needle) return true;
      const text = search?.text
        ? search.text(row)
        : columns.map((column) => valueText(read(row, column), column)).join(" ");
      return text.toLocaleLowerCase("fr").includes(needle);
    });
  }, [rows, query, filterValues, view, views, filters, search, columns]);

  const tableColumns = useMemo<DataTableColumn<Row>[]>(() => {
    const result: DataTableColumn<Row>[] = columns.map((column, index) => {
      const layout = columnLayout(column.type);
      return {
        key: column.key,
        header: column.header,
        align: layout.align,
        width: index === 0 ? undefined : layout.width,
        render: (row: Row) => <FormattedValue value={read(row, column)} options={column} />,
        sortValue: (row: Row) => sortValueOf(read(row, column), column),
      };
    });
    if (rowActions) {
      result.push({
        key: "__actions",
        header: "",
        headerLabel: "Actions",
        width: "76px",
        align: "end",
        sortable: false,
        render: (row: Row) => (
          <ActionBar
            actions={rowActions(row)}
            place="row"
            subject={valueText(read(row, columns[0]), columns[0])}
            onDone={state.reload}
          />
        ),
      });
    }
    return result;
  }, [columns, rowActions, state.reload]);

  const open = (row: Row) => {
    const key = rowKey(row);
    setSelected(key);
    if (onOpen) {
      onOpen(row);
      return;
    }
    services.publish({ id: key });
    services.setPanelVisible(true);
  };

  const filtered = query !== "" || filterValues.some(Boolean);
  const reset = () => {
    setQuery("");
    setFilterValues(filters.map(() => ""));
  };
  const hasData = rows.length > 0;

  const toolbar = hasData ? (
    <PageToolbar
      start={
        <>
          {search ? (
            <SearchField
              label={search.label}
              placeholder="Rechercher…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {filters.map((filter, index) => (
            <SelectControl
              key={filter.label}
              aria-label={filter.label}
              value={filterValues[index]}
              onChange={(event) => {
                const next = [...filterValues];
                next[index] = event.target.value;
                setFilterValues(next);
              }}
            >
              <option value="">{filter.all}</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectControl>
          ))}
          {views ? (
            <ChoiceGroup label={views.label} appearance="segmented">
              {views.items.map((item) => (
                <ChoiceButton
                  key={item.id}
                  variant="label"
                  size="compact"
                  label={item.label}
                  selected={view === item.id}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                </ChoiceButton>
              ))}
            </ChoiceGroup>
          ) : null}
        </>
      }
    >
      <RefreshButton loading={state.loading} onClick={state.reload} />
      {actions.length > 0 ? <ToolbarSeparator /> : null}
      <ActionBar actions={actions} place="toolbar" onDone={state.reload} />
    </PageToolbar>
  ) : undefined;

  return (
    <Page toolbar={toolbar} fill={hasData && !state.error}>
      {banner}
      {state.error ? (
        <FeedbackBanner tone="danger" action={<Button onClick={state.reload}>Réessayer</Button>}>
          {`${label} : le chargement a échoué. ${state.error.message}`}
        </FeedbackBanner>
      ) : state.data === undefined ? (
        <LoadingSkeleton variant="page" rows={6} label={`Chargement : ${label.toLocaleLowerCase("fr")}…`} />
      ) : !hasData ? (
        <EmptyState title={emptyTitle} description={emptyDescription}>
          <ActionBar actions={actions} place="empty" onDone={state.reload} />
        </EmptyState>
      ) : (
        <DataTable
          label={label}
          columns={tableColumns}
          rows={visible}
          rowKey={rowKey}
          selectedKey={selected}
          onRowClick={onOpen || panel ? open : undefined}
          loading={state.loading}
          fill
          emptyTitle="Aucun résultat"
          emptyDescription="Aucun élément ne correspond à la recherche ou aux filtres."
          emptyAction={filtered ? <Button onClick={reset}>Effacer les filtres</Button> : undefined}
        />
      )}
    </Page>
  );
}
