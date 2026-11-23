import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "./Button";
import { columnLabel, type TableView, type ViewColumn } from "./dataTableView";

export function HeaderContent<Row>({ column }: { column: ViewColumn<Row> }) {
  // Un libellé texte se termine par « … » quand la colonne est trop étroite, au lieu d’être coupé net.
  if (typeof column.header === "string") return <span className="al-table__label">{column.header}</span>;
  if (!column.headerLabel) return <>{column.header}</>;
  return (
    <>
      <span aria-hidden="true">{column.header}</span>
      <span className="sr-only">{column.headerLabel}</span>
    </>
  );
}

/** `aria-sort` de l’en-tête : seule la première clé de tri le porte, les suivantes sont dites par leur rang. */
export function ariaSort<Row>(view: TableView<Row>, key: string) {
  if (!view.sortable.get(key)) return undefined;
  const first = view.sort.find((entry) => view.sortable.get(entry.key));
  if (first?.key !== key) return "none";
  return first.direction === "asc" ? "ascending" : "descending";
}

/** Contenu d’un en-tête : bouton de tri (Maj+clic pour ajouter la colonne aux tris) ou simple libellé. */
export function SortHeader<Row>({
  column,
  view,
  focusable = true,
}: {
  column: ViewColumn<Row>;
  view: TableView<Row>;
  /** Dans une grille, le bouton est atteint par la navigation entre cellules : sa tabulation suit la cellule active. */
  focusable?: boolean;
}) {
  if (!view.sortable.get(column.key))
    return (
      <span className="al-table__header">
        <HeaderContent column={column} />
      </span>
    );
  const sorted = view.sort.filter((entry) => view.sortable.get(entry.key));
  const rank = sorted.findIndex((entry) => entry.key === column.key);
  const entry = rank >= 0 ? sorted[rank] : undefined;
  const label = columnLabel(column).toLocaleLowerCase("fr");
  return (
    <button
      type="button"
      tabIndex={focusable ? undefined : -1}
      data-cell-focus=""
      title={`Trier par ${label} (Maj : ajouter au tri)`}
      onClick={(event) => view.toggleSort(column.key, event.shiftKey)}
    >
      <HeaderContent column={column} />
      <span aria-hidden="true" className="al-table__sort">
        {entry ? (entry.direction === "asc" ? "↑" : "↓") : ""}
        {entry && sorted.length > 1 ? <span className="al-table__sort-rank">{rank + 1}</span> : null}
      </span>
      {entry && rank > 0 ? (
        <span className="sr-only">
          , tri {rank + 1} {entry.direction === "asc" ? "croissant" : "décroissant"}
        </span>
      ) : null}
    </button>
  );
}

/** Champ de filtre d’une colonne, dans la ligne de filtres. */
export function FilterControl<Row>({
  column,
  view,
  focusable = true,
}: {
  column: ViewColumn<Row>;
  view: TableView<Row>;
  focusable?: boolean;
}): ReactNode {
  const filter = column.filter;
  if (!filter) return null;
  const label = `Filtrer ${columnLabel(column).toLocaleLowerCase("fr")}`;
  const value = view.filters[column.key] ?? "";
  if (filter.type === "text")
    return (
      <input
        className="al-table__filter"
        type="search"
        aria-label={label}
        placeholder={filter.placeholder ?? "Filtrer…"}
        value={value}
        tabIndex={focusable ? undefined : -1}
        onChange={(event) => view.setFilter(column.key, event.target.value)}
      />
    );
  return (
    <select
      className="al-table__filter"
      aria-label={label}
      value={value}
      tabIndex={focusable ? undefined : -1}
      onChange={(event) => view.setFilter(column.key, event.target.value)}
    >
      <option value="">{filter.allLabel ?? "Tous"}</option>
      {filter.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Ligne du corps quand les filtres ne laissent rien passer : l’en-tête et ses filtres restent en place. */
export function NoMatch({ onClear, focusable = true }: { onClear: () => void; focusable?: boolean }) {
  return (
    <div className="al-table__no-match" role="status">
      <span>Aucun résultat</span>
      <Button tabIndex={focusable ? undefined : -1} onClick={onClear}>
        Effacer les filtres
      </Button>
    </div>
  );
}

/** Clic ou touche venus d’un contrôle placé dans une cellule : ils appartiennent à ce contrôle, pas à la ligne. */
export function fromInnerControl(event: MouseEvent | KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element) || target === event.currentTarget) return false;
  return Boolean(
    target.closest(
      "button, a, input, select, textarea, summary, label, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='menuitem'], [role='combobox']",
    ),
  );
}
