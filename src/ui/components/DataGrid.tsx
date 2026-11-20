import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { DataTableColumn, DataTableProps } from "./DataTable";
import { ariaSort, FilterControl, fromInnerControl, NoMatch, SortHeader } from "./dataTableParts";
import { cellValue, columnLabel, useTableView } from "./dataTableView";
import { EmptyState } from "./EmptyState";
import "./data-table.css";
import "./data-grid.css";

type Commit<Row, Value> = (row: Row, value: Value) => unknown | Promise<unknown>;

/** Édition d’une cellule de grille. Une promesse rejetée par `onCommit` marque la cellule en erreur, avec sa cause. */
export type DataTableEditor<Row> = (
  | {
      /** Texte : Entrée, F2, double clic ou une lettre tapée ouvrent le champ ; Entrée valide, Échap annule. */
      type: "text";
      /** Valeur éditée ; par défaut `row[key]`. */
      value?: (row: Row) => string;
      /** Message d’erreur si la valeur est refusée ; la saisie reste ouverte. */
      validate?: (value: string, row: Row) => string | null | undefined;
      onCommit: Commit<Row, string>;
      placeholder?: string;
    }
  | {
      /** Choix dans une liste fermée : Entrée ou double clic ouvrent la liste, le choix s’enregistre aussitôt. */
      type: "choice";
      value?: (row: Row) => string;
      options: ReadonlyArray<{ value: string; label: string }>;
      onCommit: Commit<Row, string>;
    }
  | {
      /** Case présent / absent : un clic, Espace ou Entrée la basculent. */
      type: "check";
      value?: (row: Row) => boolean;
      onCommit: Commit<Row, boolean>;
      /** Ce que disent la case cochée et la case vide (« Présent », « Absent ») ; « Oui » et « Non » par défaut. */
      labels?: { on: string; off: string };
      /** `box` : une case à cocher (sélection de lignes) au lieu des marques V et X. */
      appearance?: "mark" | "box";
    }
) & {
  /** La cellule de cette ligne est en lecture seule. */
  disabled?: (row: Row) => boolean;
};

const ROW_HEIGHTS = {
  comfortable: { single: 36, double: 44 },
  compact: { single: 25, double: 41 },
} as const;

/** Ligne vide qui réserve la hauteur des lignes non rendues. */
function Spacer({ height, span }: { height: number; span: number }) {
  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: ligne d’espacement, hors de la grille pour les lecteurs d’écran.
    <tr role="presentation" className="al-datagrid__spacer" style={{ height }}>
      <td colSpan={span} />
    </tr>
  );
}
const OVERSCAN = 10;

interface Editing {
  row: number;
  col: number;
  draft: string;
  error?: string;
}

const cellId = (key: string | number, column: string) => `${key}\u0000${column}`;

function failure(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "La modification n’a pas été enregistrée.";
}

function editorText<Row>(column: DataTableColumn<Row>, row: Row) {
  const editor = column.editor;
  if (editor && editor.type !== "check" && editor.value) return editor.value(row);
  const raw = cellValue(row, column.key);
  return raw == null ? "" : String(raw);
}

function checked<Row>(column: DataTableColumn<Row>, row: Row) {
  const editor = column.editor;
  if (editor?.type === "check" && editor.value) return editor.value(row);
  return Boolean(cellValue(row, column.key));
}

/**
 * Grille de données (`DataTable variant="grid"`) : rôle `grid`, une seule tabulation pour toute la grille et la
 * navigation entre cellules aux flèches, Début, Fin, Ctrl+Début, Ctrl+Fin, Page précédente et suivante ; en-tête et
 * colonnes `frozen` figés pendant le défilement ; édition dans la cellule ; lignes virtualisées au-delà de
 * `virtualizeFrom`. Tris et filtres sont ceux du tableau.
 */
/** Lignes de titre de groupe insérées dans les lignes de la grille par `DataTable` (option `groups`). */
export interface GroupRows<Row> {
  isGroup(row: Row): boolean;
  /** Titre, compteur et état replié du groupe. */
  describe(row: Row): {
    title: ReactNode;
    count: number;
    collapsed: boolean;
    label: string;
    appearance?: "band" | "text";
    countText?: string;
  };
  toggle(row: Row): void;
}

export function DataGrid<Row>({
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
  virtualizeFrom = 200,
  rowHeight = "single",
  appearance = "boxed",
  density = "comfortable",
  groupRows,
}: DataTableProps<Row> & {
  /** Lignes de titre d’un groupe (posées par `DataTable groups`) : une cellule sur toute la largeur, qui se replie. */
  groupRows?: GroupRows<Row>;
}) {
  const ROW_HEIGHT = ROW_HEIGHTS[density][rowHeight];
  const view = useTableView({ columns, rows, sort, defaultSort, onSortChange, filters, onFiltersChange });
  const shown = view.view;
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [frozen, setFrozen] = useState<{ offsets: ReadonlyArray<number>; width: number }>({ offsets: [], width: 0 });
  const offsets = frozen.offsets;
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const headRef = useRef<HTMLTableSectionElement>(null);
  const headerRow = useRef<HTMLTableRowElement>(null);
  const focusPending = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const lastRow = shown.length - 1;
  const lastCol = columns.length - 1;
  // La ligne -1 est celle des en-têtes : ses boutons de tri sont des cellules comme les autres.
  const cell = {
    row: Math.max(-1, Math.min(lastRow, active.row)),
    col: Math.max(0, Math.min(lastCol, active.col)),
  };
  const headerRows = view.filtering ? 2 : 1;
  const virtual = shown.length >= virtualizeFrom;
  const headHeight = headRef.current?.offsetHeight ?? 32 * headerRows;
  const windowHeight = viewport.height || ROW_HEIGHT * 20;
  const first = virtual ? Math.max(0, Math.floor(Math.max(0, viewport.top - headHeight) / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtual
    ? Math.min(shown.length, Math.ceil((viewport.top + windowHeight) / ROW_HEIGHT) + OVERSCAN)
    : shown.length;

  // Décalage gauche de chaque colonne figée : la somme des largeurs des colonnes figées qui la précèdent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: d’autres colonnes, d’autres largeurs.
  useLayoutEffect(() => {
    const row = headerRow.current;
    if (!row || !columns.some((column) => column.frozen)) return;
    const update = () => {
      let left = 0;
      const next = Array.from(row.cells, (th, index) => {
        const at = left;
        if (columns[index]?.frozen) left += th.getBoundingClientRect().width;
        return at;
      });
      setFrozen((current) =>
        current.width === left &&
        current.offsets.length === next.length &&
        current.offsets.every((value, index) => value === next[index])
          ? current
          : { offsets: next, width: left },
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    for (const th of Array.from(row.cells)) observer.observe(th);
    return () => observer.disconnect();
  }, [columns, rows.length === 0]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!virtual || !element) return;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtual]);

  // La cellule amenée au clavier : rendue d’abord (virtualisation), puis focalisée et ramenée dans la vue, sous
  // l’en-tête et à droite des colonnes figées (`scroll-padding`).
  useLayoutEffect(() => {
    if (!focusPending.current || !virtual) return;
    const element = scroller.current;
    if (!element || (cell.row >= first && cell.row < last)) return;
    element.scrollTop = Math.max(0, headHeight + cell.row * ROW_HEIGHT - element.clientHeight / 2);
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  });
  useEffect(() => {
    if (!focusPending.current || editing) return;
    const td = scroller.current?.querySelector<HTMLElement>(`[data-row="${cell.row}"][data-col="${cell.col}"]`);
    if (!td) return;
    focusPending.current = false;
    const target = td.querySelector<HTMLElement>("[data-cell-focus]") ?? td;
    target.focus({ preventScroll: true });
    td.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  const isGroupAt = (index: number) => {
    const row = shown[index];
    return Boolean(row && groupRows?.isGroup(row));
  };
  const moveTo = (row: number, col: number) => {
    focusPending.current = true;
    const target = Math.max(-1, Math.min(lastRow, row));
    // Une ligne de groupe n’a qu’une cellule, sur toute la largeur.
    setActive({ row: target, col: isGroupAt(target) ? 0 : Math.max(0, Math.min(lastCol, col)) });
  };

  const commit = useCallback(
    <Value,>(row: Row, column: DataTableColumn<Row>, value: Value) => {
      const editor = column.editor;
      if (!editor) return;
      const id = cellId(rowKey(row), column.key);
      setErrors((current) => {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      let result: unknown;
      try {
        result = (editor.onCommit as Commit<Row, Value>)(row, value);
      } catch (error) {
        setErrors((current) => new Map(current).set(id, failure(error)));
        return;
      }
      if (result instanceof Promise) {
        setPending((current) => new Set(current).add(id));
        const done = () =>
          mounted.current &&
          setPending((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        result.then(done, (error: unknown) => {
          done();
          if (mounted.current) setErrors((current) => new Map(current).set(id, failure(error)));
        });
      }
    },
    [rowKey],
  );

  const editable = (column: DataTableColumn<Row>, row: Row) =>
    Boolean(column.editor) && !column.editor?.disabled?.(row) && !pending.has(cellId(rowKey(row), column.key));

  const startEdit = (rowIndex: number, colIndex: number, draft?: string) => {
    const row = shown[rowIndex];
    const column = columns[colIndex];
    if (!row || !column || !editable(column, row)) return false;
    if (column.editor?.type === "check") {
      commit(row, column, !checked(column, row));
      return true;
    }
    setEditing({ row: rowIndex, col: colIndex, draft: draft ?? editorText(column, row) });
    return true;
  };

  const finishEdit = (save: boolean, then?: { row: number; col: number }) => {
    if (!editing) return;
    const row = shown[editing.row];
    const column = columns[editing.col];
    if (save && row && column?.editor && column.editor.type !== "check") {
      const error = column.editor.type === "text" ? column.editor.validate?.(editing.draft, row) : undefined;
      if (error) {
        setEditing({ ...editing, error });
        return;
      }
      if (editing.draft !== editorText(column, row)) commit(row, column, editing.draft);
    }
    setEditing(null);
    focusPending.current = true;
    setActive(then ?? { row: editing.row, col: editing.col });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const target = event.target as HTMLElement;
    const td = target.closest<HTMLElement>("[data-row]");
    if (!td || !event.currentTarget.contains(td)) return;
    // Un champ placé dans une cellule par `render` garde ses touches.
    if (target.matches("input, select, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    const header = cell.row < 0;
    // Ligne de groupe : Entrée ou Espace la replient ou la déplient ; les flèches haut et bas la traversent.
    if (!header && isGroupAt(cell.row) && groupRows) {
      const groupRow = shown[cell.row] as Row;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        groupRows.toggle(groupRow);
        return;
      }
    }
    const row = shown[cell.row];
    const column = columns[cell.col];
    if ((!row && !header) || !column) return;
    const page = Math.max(
      1,
      Math.floor(((scroller.current?.clientHeight || windowHeight) - headHeight) / ROW_HEIGHT) - 1,
    );
    const ctrl = event.ctrlKey || event.metaKey;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        moveTo(cell.row + 1, cell.col);
        break;
      case "ArrowUp":
        moveTo(cell.row - 1, cell.col);
        break;
      case "ArrowRight":
        moveTo(cell.row, cell.col + 1);
        break;
      case "ArrowLeft":
        moveTo(cell.row, cell.col - 1);
        break;
      case "Home":
        moveTo(ctrl ? 0 : cell.row, 0);
        break;
      case "F2":
      case "Enter":
      case " ":
        // Dans l’en-tête, Entrée et Espace appartiennent au bouton de tri.
        if (header || !row) handled = false;
        else if (event.key === "F2") handled = startEdit(cell.row, cell.col);
        else if (event.key === " ") {
          if (column.editor?.type === "check") startEdit(cell.row, cell.col);
          else handled = false;
        } else if (column.editor) startEdit(cell.row, cell.col);
        else if (onRowClick && !fromInnerControl(event)) onRowClick(row);
        else handled = false;
        break;
      case "End":
        moveTo(ctrl ? lastRow : cell.row, lastCol);
        break;
      case "PageDown":
        moveTo(cell.row + page, cell.col);
        break;
      case "PageUp":
        moveTo(cell.row - page, cell.col);
        break;
      default:
        // Une lettre tapée sur une cellule de texte ouvre la saisie avec elle, comme dans un tableur.
        if (
          row &&
          column.editor?.type === "text" &&
          event.key.length === 1 &&
          !ctrl &&
          !event.altKey &&
          startEdit(cell.row, cell.col, event.key)
        )
          break;
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const frozenWidth = frozen.width;
  const lastFrozen = columns.reduce((found, column, index) => (column.frozen ? index : found), -1);

  if (!loading && rows.length === 0) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} size="compact">
        {emptyAction}
      </EmptyState>
    );
  }

  const stick = (index: number) => (columns[index]?.frozen ? { left: offsets[index] ?? 0 } : undefined);
  const frozenClass = (index: number) =>
    columns[index]?.frozen ? ` al-datagrid__frozen${index === lastFrozen ? " al-datagrid__frozen--edge" : ""}` : "";

  const renderCell = (row: Row, rowIndex: number, column: DataTableColumn<Row>, colIndex: number): ReactNode => {
    const key = rowKey(row);
    const id = cellId(key, column.key);
    const isActive = cell.row === rowIndex && cell.col === colIndex;
    const editor = column.editor;
    const error = errors.get(id);
    const busy = pending.has(id);
    const isEditing = editing?.row === rowIndex && editing.col === colIndex;
    const readOnly = editor ? !editable(column, row) && !busy : undefined;
    const name = columnLabel(column);
    let content: ReactNode;
    let focusInside = false;
    if (isEditing && editor?.type === "text") {
      content = (
        <input
          // biome-ignore lint/a11y/noAutofocus: la saisie s’ouvre à la demande de l’utilisateur, sur la cellule.
          autoFocus
          className="al-datagrid__input"
          aria-label={name}
          aria-invalid={editing.error ? true : undefined}
          aria-describedby={editing.error ? errorId : undefined}
          placeholder={editor.placeholder}
          value={editing.draft}
          onChange={(event) => setEditing({ ...editing, draft: event.target.value, error: undefined })}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              finishEdit(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              finishEdit(false);
            } else if (event.key === "Tab") {
              event.preventDefault();
              finishEdit(true, { row: rowIndex, col: colIndex + (event.shiftKey ? -1 : 1) });
            }
          }}
          onBlur={() => {
            // Quitter la cellule enregistre une valeur valable et abandonne une valeur refusée.
            if (editing.error || editor.validate?.(editing.draft, row)) finishEdit(false);
            else finishEdit(true);
          }}
        />
      );
    } else if (isEditing && editor?.type === "choice") {
      content = (
        <select
          // biome-ignore lint/a11y/noAutofocus: la liste s’ouvre à la demande de l’utilisateur, sur la cellule.
          autoFocus
          className="al-datagrid__input"
          aria-label={name}
          value={editing.draft}
          onChange={(event) => {
            commit(row, column, event.target.value);
            setEditing(null);
            focusPending.current = true;
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              finishEdit(false);
            } else if (event.key === "Enter") {
              event.preventDefault();
              finishEdit(true);
            }
          }}
          onBlur={() => finishEdit(false)}
        >
          {editor.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    } else if (editor?.type === "check") {
      const on = checked(column, row);
      const labels = editor.labels ?? { on: "Oui", off: "Non" };
      focusInside = true;
      content = (
        // biome-ignore lint/a11y/useSemanticElements: case de grille au focus itinérant, dessinée en V/X, basculée par la grille.
        <span
          role="checkbox"
          data-cell-focus=""
          className="al-datagrid__check"
          aria-checked={on}
          aria-label={`${name} : ${on ? labels.on : labels.off}`}
          aria-disabled={readOnly || busy || undefined}
          tabIndex={isActive ? 0 : -1}
          title={on ? labels.on : labels.off}
        >
          {editor.appearance === "box" ? (
            <span className={`al-datagrid__box${on ? " al-datagrid__box--on" : ""}`} aria-hidden="true">
              {on ? <Check size={12} strokeWidth={3} /> : null}
            </span>
          ) : on ? (
            <Check size={16} aria-hidden="true" className="al-datagrid__check-on" />
          ) : (
            <X size={16} aria-hidden="true" className="al-datagrid__check-off" />
          )}
        </span>
      );
    } else if (column.render) content = column.render(row);
    else if (editor?.type === "choice") {
      const value = editorText(column, row);
      content = editor.options.find((option) => option.value === value)?.label ?? value;
    } else content = (cellValue(row, column.key) as ReactNode) ?? "";

    const toneOf = column.tone;
    const tone = toneOf && !groupRows?.isGroup(row) ? toneOf(row) : undefined;
    const classes = [
      "al-datagrid__cell",
      column.align === "end" ? "al-table__end" : "",
      editor ? "al-datagrid__cell--editable" : "",
      editor?.type === "check" ? "al-datagrid__cell--check" : "",
      isEditing ? "al-datagrid__cell--editing" : "",
      error ? "al-datagrid__cell--error" : "",
      busy ? "al-datagrid__cell--pending" : "",
      toneOf ? `al-datagrid__cell--${column.toneStyle ?? "fill"}` : "",
      tone ? `al-datagrid__cell--tone-${tone}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: le clavier de chaque cellule est traité par la grille (onKeyDown du conteneur).
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: la cellule a le rôle gridcell, qui accepte aria-readonly.
      <td
        key={column.key}
        role={column.rowHeader ? "rowheader" : "gridcell"}
        aria-colindex={colIndex + 1}
        aria-readonly={readOnly || undefined}
        aria-busy={busy || undefined}
        aria-invalid={error ? true : undefined}
        data-row={rowIndex}
        data-col={colIndex}
        tabIndex={isEditing || focusInside ? undefined : isActive ? 0 : -1}
        className={classes + frozenClass(colIndex)}
        style={stick(colIndex)}
        title={error}
        onFocus={(event) => {
          if (event.target === event.currentTarget || event.target.hasAttribute("data-cell-focus"))
            if (!isActive) setActive({ row: rowIndex, col: colIndex });
        }}
        onMouseDown={() => {
          if (!isActive) setActive({ row: rowIndex, col: colIndex });
        }}
        onClick={(event) => {
          if (isEditing) return;
          if (editor?.type === "check") {
            startEdit(rowIndex, colIndex);
            return;
          }
          if (!editor && onRowClick && !fromInnerControl(event)) onRowClick(row);
        }}
        onDoubleClick={() => {
          if (editor && editor.type !== "check" && !isEditing) startEdit(rowIndex, colIndex);
        }}
      >
        {toneOf && column.toneStyle === "frame" ? <span className="al-datagrid__frame">{content}</span> : content}
        {error ? <span className="sr-only">. Échec : {error}</span> : null}
      </td>
    );
  };

  const total = shown.length + headerRows;
  const editingColumn = editing ? columns[editing.col] : undefined;
  return (
    <div
      className={`al-datagrid-frame${fill ? " al-table-frame--fill" : ""}${rowHeight === "double" ? " al-datagrid-frame--double" : ""}${appearance === "plain" ? " al-datagrid-frame--plain" : ""}${density === "compact" ? " al-datagrid-frame--compact" : ""}`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: délégation des touches de toutes les cellules de la grille. */}
      <div
        className={`al-datagrid-scroll${virtual ? " al-datagrid-scroll--virtual" : ""}`}
        ref={scroller}
        style={{ scrollPaddingTop: headHeight, scrollPaddingLeft: frozenWidth }}
        onKeyDown={onKeyDown}
        onScroll={
          virtual
            ? (event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
            : undefined
        }
      >
        <table
          className="al-table al-datagrid"
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: motif « grid » de l’ARIA sur un tableau HTML.
          role="grid"
          aria-label={label}
          aria-rowcount={total}
          aria-colcount={columns.length}
          aria-busy={loading || undefined}
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width ?? "160px" }} />
            ))}
          </colgroup>
          <thead ref={headRef}>
            <tr aria-rowindex={1} ref={headerRow}>
              {columns.map((column, index) => {
                const isActive = cell.row === -1 && cell.col === index;
                const button = view.sortable.get(column.key);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-colindex={index + 1}
                    aria-sort={ariaSort(view, column.key)}
                    data-row={-1}
                    data-col={index}
                    tabIndex={button ? undefined : isActive ? 0 : -1}
                    className={`al-datagrid__head${column.align === "end" ? " al-table__end" : ""}${frozenClass(index)}`}
                    style={stick(index)}
                    onFocus={() => {
                      if (!isActive) setActive({ row: -1, col: index });
                    }}
                  >
                    <SortHeader column={column} view={view} focusable={isActive} />
                  </th>
                );
              })}
            </tr>
            {view.filtering ? (
              <tr aria-rowindex={2} className="al-table__filters">
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: cellule de la grille qui porte un filtre.
                    role="gridcell"
                    tabIndex={-1}
                    aria-colindex={index + 1}
                    className={frozenClass(index).trim() || undefined}
                    style={stick(index)}
                  >
                    <FilterControl column={column} view={view} />
                  </td>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {view.filteredOut ? (
              <tr>
                <td
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: cellule de la grille.
                  role="gridcell"
                  tabIndex={-1}
                  colSpan={columns.length}
                  className="al-datagrid__no-match"
                >
                  <NoMatch onClear={view.clearFilters} />
                </td>
              </tr>
            ) : null}
            {virtual && first > 0 ? <Spacer height={first * ROW_HEIGHT} span={columns.length} /> : null}
            {shown.slice(first, last).map((row, offset) => {
              const index = first + offset;
              const key = rowKey(row);
              if (groupRows?.isGroup(row)) {
                const group = groupRows.describe(row);
                const isActive = cell.row === index;
                const Chevron = group.collapsed ? ChevronRight : ChevronDown;
                return (
                  <tr
                    key={key}
                    aria-rowindex={headerRows + index + 1}
                    className={`al-datagrid__group${group.appearance === "text" ? " al-datagrid__group--text" : ""}`}
                  >
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: Entrée et Espace replient le groupe dans le clavier de la grille. */}
                    <td
                      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: titre d’un groupe de la grille, qui se replie.
                      role="gridcell"
                      colSpan={columns.length}
                      data-row={index}
                      data-col={0}
                      tabIndex={isActive ? 0 : -1}
                      aria-expanded={!group.collapsed}
                      aria-label={`${group.label}, ${group.count} ligne${group.count > 1 ? "s" : ""}, ${group.collapsed ? "replié" : "déplié"}`}
                      onFocus={() => {
                        if (!isActive) setActive({ row: index, col: 0 });
                      }}
                      onClick={() => {
                        setActive({ row: index, col: 0 });
                        groupRows.toggle(row);
                      }}
                    >
                      {group.appearance === "text" ? (
                        <span className="al-datagrid__group-title">
                          <span className="al-datagrid__group-name">{group.title}</span>
                          <span className="al-datagrid__group-count">· {group.countText}</span>
                        </span>
                      ) : (
                        <span className="al-datagrid__group-title">
                          <Chevron size={14} aria-hidden="true" />
                          <span className="al-datagrid__group-name">{group.title}</span>
                          <span className="al-datagrid__group-count">{group.count}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              }
              return (
                <tr
                  key={key}
                  aria-rowindex={headerRows + index + 1}
                  aria-selected={selectedKey === undefined ? undefined : selectedKey === key}
                  className={onRowClick ? "al-table__row--clickable" : undefined}
                >
                  {columns.map((column, colIndex) => renderCell(row, index, column, colIndex))}
                </tr>
              );
            })}
            {virtual && last < shown.length ? (
              <Spacer height={(shown.length - last) * ROW_HEIGHT} span={columns.length} />
            ) : null}
          </tbody>
        </table>
      </div>
      {editing?.error ? (
        <div className="al-datagrid__error" id={errorId} role="alert">
          {editingColumn ? `${columnLabel(editingColumn)} : ` : ""}
          {editing.error}
        </div>
      ) : null}
    </div>
  );
}
