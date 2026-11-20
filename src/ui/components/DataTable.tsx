import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { DataGrid, type DataTableEditor } from "./DataGrid";
import { ariaSort, FilterControl, fromInnerControl, HeaderContent, NoMatch, SortHeader } from "./dataTableParts";
import {
  cellValue,
  type DataTableFilter,
  type DataTableFilters,
  type DataTableSort,
  type SortValue,
  useTableView,
} from "./dataTableView";
import { EmptyState } from "./EmptyState";
import "./data-table.css";

export interface DataTableColumn<Row> {
  /** Identifiant stable de la colonne ; sert aussi de clé de lecture par défaut dans la ligne. */
  key: string;
  /** En-tête visible : un texte, ou un nœud (icône…) accompagné de `headerLabel`. */
  header: ReactNode;
  /** Nom de la colonne pour les lecteurs d’écran quand `header` n’est pas un texte. */
  headerLabel?: string;
  /** Contenu de la cellule ; par défaut la valeur `row[key]`. */
  render?: (row: Row) => ReactNode;
  /** Valeur utilisée pour trier ; à fournir dès que `render` affiche autre chose que `row[key]`. */
  sortValue?: (row: Row) => SortValue;
  /**
   * Colonne triable. Par défaut : oui si `sortValue` est fourni ou si `row[key]` est une valeur simple (texte,
   * nombre, booléen) ; non sinon. Une colonne non triable a un en-tête texte, sans bouton.
   */
  sortable?: boolean;
  align?: "start" | "end";
  /** Largeur CSS (`120px`, `20%`) ; sans elle la colonne partage la place restante (160 px dans une grille). */
  width?: string;
  /** Filtre de la colonne, dans une ligne sous l’en-tête ; les filtres des colonnes se cumulent. */
  filter?: DataTableFilter<Row>;
  /** Grille seulement : colonne figée à gauche pendant le défilement horizontal (les premières colonnes). */
  frozen?: boolean;
  /** Grille seulement : la cellule nomme sa ligne (`rowheader`), comme le nom de l’élément d’une matrice. */
  rowHeader?: boolean;
  /** Grille seulement : édition dans la cellule (texte, choix, case). */
  editor?: DataTableEditor<Row>;
}

export type { DataTableEditor, DataTableFilter, DataTableFilters, DataTableSort };

/** Largeurs relevées dans le tableau des lignes, recopiées sur l’en-tête fixe pour que les colonnes s’alignent. */
interface Measure {
  columns: number[];
  table: number;
  /** Place prise à droite par la barre de défilement verticale des lignes. */
  gutter: number;
}

function sameMeasure(left: Measure | null, right: Measure) {
  return (
    left !== null &&
    left.table === right.table &&
    left.gutter === right.gutter &&
    left.columns.length === right.columns.length &&
    left.columns.every((width, index) => width === right.columns[index])
  );
}

export interface DataTableProps<Row> {
  columns: ReadonlyArray<DataTableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string | number;
  /** Nom accessible du tableau. */
  label: string;
  onRowClick?: (row: Row) => void;
  selectedKey?: string | number | null;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Action proposée dans l’état vide (un `Button`), par exemple « Effacer la recherche ». */
  emptyAction?: ReactNode;
  loading?: boolean;
  /** Occupe la hauteur restante (sous `Page fill`) : seules les lignes défilent, sous l’en-tête. */
  fill?: boolean;
  /**
   * `"list"` (par défaut) : une ligne activable par élément. `"grid"` : une grille de cellules (rôle `grid`),
   * parcourue au clavier cellule par cellule, avec colonnes figées (`frozen`), édition dans la cellule (`editor`)
   * et lignes virtualisées au-delà de `virtualizeFrom`.
   */
  variant?: "list" | "grid";
  /**
   * Grille seulement : `double` donne des lignes de 44 px, pour une cellule sur deux lignes (un nom et sa précision
   * dessous : courriel, conteneur, date), comme les tableaux de OneApp.
   */
  rowHeight?: "single" | "double";
  /** Tris en cours (contrôlé) ; sans lui, le tableau garde les siens. */
  sort?: ReadonlyArray<DataTableSort>;
  defaultSort?: ReadonlyArray<DataTableSort>;
  onSortChange?: (sort: DataTableSort[]) => void;
  /** Valeur du filtre de chaque colonne (contrôlé) ; sans lui, le tableau garde les siennes. */
  filters?: DataTableFilters;
  onFiltersChange?: (filters: Record<string, string>) => void;
  /** Grille seulement : nombre de lignes à partir duquel seules celles à l’écran sont rendues (200). */
  virtualizeFrom?: number;
}

/**
 * Tableau de données dense : en-tête fixe, hors de la zone qui défile (sa barre de défilement ne longe que les
 * lignes), tris cumulables par clic sur l’en-tête des colonnes triables (Maj+clic ajoute une clé), filtres par
 * colonne, ligne activable au clavier comme à la souris (sans voler les clics des boutons, liens et champs placés
 * dans ses cellules), état vide intégré. Avec `fill`, il occupe la hauteur restante de la page et fait défiler ses
 * lignes seules. Avec `variant="grid"`, c’est une grille de cellules (voir `DataGrid`).
 */
export function DataTable<Row>(props: DataTableProps<Row>) {
  return props.variant === "grid" ? <DataGrid {...props} /> : <ListTable {...props} />;
}

function ListTable<Row>({
  columns,
  rows,
  rowKey,
  label,
  onRowClick,
  selectedKey,
  emptyTitle = "Aucune donnée",
  emptyDescription,
  emptyAction,
  loading = false,
  fill = false,
  sort,
  defaultSort,
  onSortChange,
  filters,
  onFiltersChange,
}: DataTableProps<Row>) {
  const view = useTableView({ columns, rows, sort, defaultSort, onSortChange, filters, onFiltersChange });
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLTableRowElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  const empty = !loading && rows.length === 0;

  // Les colonnes prennent la largeur de leur contenu (en-têtes compris, par une ligne d’en-tête invisible dans le
  // tableau des lignes) ; l’en-tête fixe reprend ces largeurs à chaque changement de taille.
  // biome-ignore lint/correctness/useExhaustiveDependencies: d’autres colonnes, d’autres cellules à observer.
  useLayoutEffect(() => {
    if (empty) return;
    const scroller = body.current;
    const row = sizer.current;
    if (!scroller || !row) return;
    const update = () => {
      const next: Measure = {
        columns: Array.from(row.cells, (cell) => cell.getBoundingClientRect().width),
        table: row.closest("table")?.getBoundingClientRect().width ?? 0,
        gutter: Math.max(0, scroller.offsetWidth - scroller.clientWidth),
      };
      if (next.table > 0) setMeasure((current) => (sameMeasure(current, next) ? current : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    for (const cell of Array.from(row.cells)) observer.observe(cell);
    return () => observer.disconnect();
  }, [empty, columns, view.filteredOut]);

  if (empty) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} size="compact">
        {emptyAction}
      </EmptyState>
    );
  }

  const measured = measure?.columns.length === columns.length ? measure : null;

  // L’en-tête et les lignes sont deux `<table>` (l’en-tête reste hors de la zone qui défile) : le cadre porte le rôle
  // de tableau et chaque partie le sien, explicitement, sous des `<table role="presentation">`.
  return (
    <div
      className={`al-table-frame${fill ? " al-table-frame--fill" : ""}`}
      role="table"
      aria-label={label}
      aria-busy={loading || undefined}
    >
      <div className="al-table-head" ref={head} style={measured ? { paddingRight: measured.gutter } : undefined}>
        <table
          className="al-table al-table--head"
          role="presentation"
          style={measured ? { width: measured.table } : undefined}
        >
          <colgroup>
            {columns.map((column, index) => (
              <col
                key={column.key}
                style={
                  measured ? { width: measured.columns[index] } : column.width ? { width: column.width } : undefined
                }
              />
            ))}
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              {columns.map((column) => (
                <th
                  key={column.key}
                  role="columnheader"
                  scope="col"
                  className={column.align === "end" ? "al-table__end" : undefined}
                  aria-sort={ariaSort(view, column.key)}
                >
                  <SortHeader column={column} view={view} />
                </th>
              ))}
            </tr>
            {view.filtering ? (
              <tr className="al-table__filters">
                {columns.map((column) => (
                  <td key={column.key}>
                    <FilterControl column={column} view={view} />
                  </td>
                ))}
              </tr>
            ) : null}
          </thead>
        </table>
      </div>
      <div
        className="al-table-scroll"
        ref={body}
        onScroll={(event) => {
          if (head.current) head.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      >
        <table className="al-table" role="presentation">
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <thead className="al-table__sizer" aria-hidden="true">
            <tr ref={sizer}>
              {columns.map((column) => (
                <th key={column.key}>
                  <span className="al-table__header">
                    <HeaderContent column={column} />
                    {view.sortable.get(column.key) ? <span className="al-table__sort" /> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.filteredOut ? (
              <tr role="row">
                <td role="cell" colSpan={columns.length}>
                  <NoMatch onClear={view.clearFilters} />
                </td>
              </tr>
            ) : null}
            {view.view.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  role="row"
                  className={onRowClick ? "al-table__row--clickable" : undefined}
                  aria-selected={selectedKey === undefined ? undefined : selectedKey === key}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={
                    onRowClick
                      ? (event) => {
                          if (!fromInnerControl(event)) onRowClick(row);
                        }
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          // Seule la ligne elle-même réagit : Entrée ou Espace dans un contrôle de cellule lui reste.
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td key={column.key} role="cell" className={column.align === "end" ? "al-table__end" : undefined}>
                      {column.render ? column.render(row) : ((cellValue(row, column.key) as ReactNode) ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
