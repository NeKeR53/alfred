import { type ReactNode, useCallback, useMemo, useState } from "react";

/** Une clé de tri ; plusieurs se cumulent, la première l’emporte. */
export interface DataTableSort {
  key: string;
  direction: "asc" | "desc";
}

/** Filtre d’une colonne, posé dans une ligne de filtres sous l’en-tête. Les filtres de plusieurs colonnes se cumulent. */
export type DataTableFilter<Row> =
  | {
      /** Texte contenu, sans tenir compte des accents ni de la casse ; chaque mot est exigé. */
      type: "text";
      /** Texte filtré ; par défaut `row[key]`. */
      value?: (row: Row) => string | null | undefined;
      placeholder?: string;
    }
  | {
      /** Une valeur d’une liste fermée ; « Tous » laisse tout passer. */
      type: "choice";
      options: ReadonlyArray<{ value: string; label: string }>;
      /** Valeur, ou valeurs, de la ligne ; par défaut `row[key]`. */
      value?: (row: Row) => string | ReadonlyArray<string> | boolean | null | undefined;
      /** Libellé de l’option qui laisse tout passer ; « Tous » par défaut. */
      allLabel?: string;
    };

/** Valeur saisie dans le filtre de chaque colonne, par clé ; une valeur vide ne filtre pas. */
export type DataTableFilters = Readonly<Record<string, string>>;

export type SortValue = string | number | null | undefined;

/** Ce que les tris et les filtres lisent d’une colonne. */
export interface ViewColumn<Row> {
  key: string;
  header: ReactNode;
  headerLabel?: string;
  sortValue?: (row: Row) => SortValue;
  sortable?: boolean;
  filter?: DataTableFilter<Row>;
}

export function cellValue<Row>(row: Row, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

const isSimple = (value: unknown) =>
  value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");
}

export function columnLabel<Row>(column: ViewColumn<Row>) {
  return typeof column.header === "string" ? column.header : (column.headerLabel ?? column.key);
}

function compare(a: SortValue, b: SortValue) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });
}

function matches<Row>(row: Row, column: ViewColumn<Row>, wanted: string) {
  const filter = column.filter;
  if (!filter || !wanted) return true;
  if (filter.type === "text") {
    const raw = filter.value ? filter.value(row) : cellValue(row, column.key);
    const text = normalize(raw == null ? "" : String(raw));
    return normalize(wanted)
      .split(/\s+/)
      .filter(Boolean)
      .every((word) => text.includes(word));
  }
  const raw = filter.value ? filter.value(row) : cellValue(row, column.key);
  if (Array.isArray(raw)) return raw.map(String).includes(wanted);
  return raw != null && String(raw) === wanted;
}

/**
 * Tris cumulables et filtres par colonne, contrôlés ou non. Un clic trie par la colonne seule
 * (croissant, décroissant, sans tri) ; Maj+clic l’ajoute en clé suivante.
 */
export function useTableView<Row>({
  columns,
  rows,
  sort: controlledSort,
  defaultSort,
  onSortChange,
  filters: controlledFilters,
  onFiltersChange,
}: {
  columns: ReadonlyArray<ViewColumn<Row>>;
  rows: ReadonlyArray<Row>;
  sort?: ReadonlyArray<DataTableSort>;
  defaultSort?: ReadonlyArray<DataTableSort>;
  onSortChange?: (sort: DataTableSort[]) => void;
  filters?: DataTableFilters;
  onFiltersChange?: (filters: Record<string, string>) => void;
}) {
  const [ownSort, setOwnSort] = useState<ReadonlyArray<DataTableSort>>(defaultSort ?? []);
  const [ownFilters, setOwnFilters] = useState<DataTableFilters>({});
  const sort = controlledSort ?? ownSort;
  const filters = controlledFilters ?? ownFilters;

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

  const filtered = useMemo(() => {
    const active = columns.filter((column) => column.filter && filters[column.key]);
    if (active.length === 0) return rows;
    return rows.filter((row) => active.every((column) => matches(row, column, filters[column.key] ?? "")));
  }, [rows, columns, filters]);

  const view = useMemo(() => {
    const keys = sort
      .filter((entry) => sortable.get(entry.key))
      .map((entry) => {
        const column = columns.find((candidate) => candidate.key === entry.key);
        if (!column) return null;
        const read = column.sortValue ?? ((row: Row) => cellValue(row, column.key) as SortValue);
        return { read, factor: entry.direction === "asc" ? 1 : -1 };
      })
      .filter((entry) => entry !== null);
    if (keys.length === 0) return filtered;
    return [...filtered].sort((left, right) => {
      for (const { read, factor } of keys) {
        const result = compare(read(left), read(right));
        if (result !== 0) return result * factor;
      }
      return 0;
    });
  }, [filtered, columns, sort, sortable]);

  const toggleSort = useCallback(
    (key: string, additive: boolean) => {
      const current = sort.find((entry) => entry.key === key);
      const cycled: DataTableSort | null = !current
        ? { key, direction: "asc" }
        : current.direction === "asc"
          ? { key, direction: "desc" }
          : null;
      let next: DataTableSort[];
      if (additive) {
        next = sort.map((entry) => (entry.key === key ? cycled : entry)).filter((entry) => entry !== null);
        if (!current && cycled) next.push(cycled);
      } else next = cycled ? [cycled] : sort.length > 1 && current ? [{ key, direction: "asc" }] : [];
      if (!controlledSort) setOwnSort(next);
      onSortChange?.(next);
    },
    [sort, controlledSort, onSortChange],
  );

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = { ...filters, [key]: value };
      if (!value) delete next[key];
      if (!controlledFilters) setOwnFilters(next);
      onFiltersChange?.(next);
    },
    [filters, controlledFilters, onFiltersChange],
  );

  const clearFilters = useCallback(() => {
    if (!controlledFilters) setOwnFilters({});
    onFiltersChange?.({});
  }, [controlledFilters, onFiltersChange]);

  const filtering = columns.some((column) => column.filter);
  const filteredOut = rows.length > 0 && view.length === 0;

  return { sort, sortable, filters, view, toggleSort, setFilter, clearFilters, filtering, filteredOut };
}

export type TableView<Row> = ReturnType<typeof useTableView<Row>>;
