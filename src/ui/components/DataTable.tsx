import { type KeyboardEvent, type MouseEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./EmptyState";
import "./data-table.css";

type SortValue = string | number | null | undefined;

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
  /** Largeur CSS (`120px`, `20%`) ; sans elle la colonne partage la place restante. */
  width?: string;
}

type SortState = { key: string; direction: "asc" | "desc" } | null;

function cellValue<Row>(row: Row, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

const isSimple = (value: unknown) =>
  value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Clic ou touche venus d’un contrôle placé dans une cellule : ils appartiennent à ce contrôle, pas à la ligne. */
function fromInnerControl(event: MouseEvent | KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element) || target === event.currentTarget) return false;
  return Boolean(
    target.closest(
      "button, a, input, select, textarea, summary, label, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='menuitem'], [role='combobox']",
    ),
  );
}

function columnLabel<Row>(column: DataTableColumn<Row>) {
  return typeof column.header === "string" ? column.header : (column.headerLabel ?? column.key);
}

function HeaderContent<Row>({ column }: { column: DataTableColumn<Row> }) {
  if (typeof column.header === "string" || !column.headerLabel) return <>{column.header}</>;
  return (
    <>
      <span aria-hidden="true">{column.header}</span>
      <span className="sr-only">{column.headerLabel}</span>
    </>
  );
}

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

/**
 * Tableau de données dense : en-tête fixe, hors de la zone qui défile (sa barre de défilement ne longe que les
 * lignes), tri par clic sur l’en-tête des colonnes triables, ligne activable au clavier comme à la souris (sans voler
 * les clics des boutons, liens et champs placés dans ses cellules), état vide intégré. Avec `fill`, il occupe la
 * hauteur restante de la page et fait défiler ses lignes seules.
 */
export function DataTable<Row>({
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
}: {
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
}) {
  const [sort, setSort] = useState<SortState>(null);
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLTableRowElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  const sortable = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const column of columns) {
      const automatic =
        column.sortValue !== undefined ||
        (rows.some((row) => cellValue(row, column.key) != null) &&
          rows.every((row) => isSimple(cellValue(row, column.key))));
      result.set(column.key, column.sortable ?? automatic);
    }
    return result;
  }, [columns, rows]);

  const sorted = useMemo(() => {
    if (!sort || !sortable.get(sort.key)) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column) return rows;
    const read = column.sortValue ?? ((row: Row) => cellValue(row, column.key) as SortValue);
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = read(left);
      const b = read(right);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" }) * factor;
    });
  }, [rows, columns, sort, sortable]);

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
  }, [empty, columns]);

  const toggleSort = (key: string) =>
    setSort((current) => {
      if (current?.key !== key) return { key, direction: "asc" };
      return current.direction === "asc" ? { key, direction: "desc" } : null;
    });

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
              {columns.map((column) => {
                const canSort = sortable.get(column.key);
                const active = canSort && sort?.key === column.key ? sort.direction : undefined;
                return (
                  <th
                    key={column.key}
                    role="columnheader"
                    scope="col"
                    className={column.align === "end" ? "al-table__end" : undefined}
                    aria-sort={
                      active === "asc" ? "ascending" : active === "desc" ? "descending" : canSort ? "none" : undefined
                    }
                  >
                    {canSort ? (
                      <button
                        type="button"
                        title={`Trier par ${columnLabel(column).toLocaleLowerCase("fr")}`}
                        onClick={() => toggleSort(column.key)}
                      >
                        <HeaderContent column={column} />
                        <span aria-hidden="true" className="al-table__sort">
                          {active === "asc" ? "↑" : active === "desc" ? "↓" : ""}
                        </span>
                      </button>
                    ) : (
                      <span className="al-table__header">
                        <HeaderContent column={column} />
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
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
                    {sortable.get(column.key) ? <span className="al-table__sort" /> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {sorted.map((row) => {
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
