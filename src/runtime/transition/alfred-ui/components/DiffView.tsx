import { ChevronDown, ChevronUp, UnfoldVertical } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "./Button";
import { ChoiceButton, ChoiceGroup } from "./ChoiceButton";
import {
  type DiffFile,
  type DiffLine,
  diffTexts,
  type Eol,
  eolLabel,
  parsePatch,
  type Range,
  wordChanges,
} from "./diffModel";

export type DiffViewMode = "split" | "unified";

export interface DiffViewProps {
  /** Nom du diff pour les lecteurs d’écran (« Modifications de README.md »). */
  label: string;
  /** Texte d’avant, comparé à `after` (le contenu à une révision : `git.show`). */
  before?: string;
  /** Texte d’après. */
  after?: string;
  /** Diff unifié tel que le rend `git.diff` (`text`), un ou plusieurs fichiers ; à la place de `before`/`after`. */
  patch?: string;
  /** Le diff a été coupé (`truncated` de `git.diff`) : la fin le dit. */
  truncated?: boolean;
  /** Vue choisie par la page ; sans elle, le composant garde la sienne (côte à côte au départ). */
  mode?: DiffViewMode;
  onModeChange?: (mode: DiffViewMode) => void;
  /** Lignes inchangées gardées autour d’un changement (3). */
  context?: number;
  /** Occupe la hauteur restante d’une `Page fill`. */
  fill?: boolean;
}

/** Hauteur de chaque sorte de rangée, en pixels CSS (la police est fixée par diff-view.css). */
const ROW_HEIGHT = { line: 20, pair: 20, gap: 28, file: 32, notice: 28 } as const;
const OVERSCAN = 12;
/** Hauteur supposée quand la zone n’est pas mesurable (rendu hors écran, tests). */
const FALLBACK_VIEWPORT = 800;

type Side = { line: DiffLine; pair?: DiffLine };

type Row =
  | { type: "file"; key: string; file: DiffFile }
  | { type: "notice"; key: string; text: string }
  | { type: "gap"; key: string; count: number; oldStart: number; expandable: boolean; foldKey: string }
  | { type: "line"; key: string; line: DiffLine; pair?: DiffLine; change?: number }
  | { type: "pair"; key: string; left?: Side; right?: Side; change?: number };

interface Change {
  /** Première rangée du changement. */
  row: number;
  oldFrom?: number;
  oldTo?: number;
  newFrom?: number;
  newTo?: number;
}

function fileTitle(file: DiffFile): string {
  if (file.status === "renamed" && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.newPath ?? file.oldPath ?? "Fichier";
}

const statusLabel: Record<DiffFile["status"], string> = {
  modified: "Modifié",
  added: "Ajouté",
  deleted: "Supprimé",
  renamed: "Renommé",
};

function eolNotice(from: Eol, to: Eol): string {
  return `Fins de ligne converties : ${eolLabel[from]} → ${eolLabel[to]}`;
}

/** Rangées à afficher, et la liste des changements (suites de lignes retirées ou ajoutées) pour la navigation. */
function buildRows(
  files: DiffFile[],
  mode: DiffViewMode,
  withHeaders: boolean,
  expanded: ReadonlySet<string>,
  showAll: boolean,
  truncated: boolean,
): { rows: Row[]; changes: Change[] } {
  const rows: Row[] = [];
  const changes: Change[] = [];
  files.forEach((file, fileIndex) => {
    if (withHeaders) rows.push({ type: "file", key: `f${fileIndex}`, file });
    if (file.binary) {
      rows.push({ type: "notice", key: `b${fileIndex}`, text: "Fichier binaire : contenu non comparé" });
      return;
    }
    if (file.eolChange) {
      rows.push({ type: "notice", key: `e${fileIndex}`, text: eolNotice(file.eolChange.from, file.eolChange.to) });
    }
    if (!file.added && !file.removed) {
      if (!file.eolChange && file.status === "modified") {
        rows.push({ type: "notice", key: `n${fileIndex}`, text: "Aucune différence" });
      }
      if (!file.segments.some((segment) => segment.type === "lines" && segment.lines.length)) return;
    }
    file.segments.forEach((segment, segmentIndex) => {
      const foldKey = `${fileIndex}:${segmentIndex}`;
      let lines: DiffLine[];
      if (segment.type === "gap") {
        if (!segment.lines || !(showAll || expanded.has(foldKey))) {
          rows.push({
            type: "gap",
            key: `g${foldKey}`,
            count: segment.count,
            oldStart: segment.oldStart,
            expandable: Boolean(segment.lines),
            foldKey,
          });
          return;
        }
        lines = segment.lines;
      } else lines = segment.lines;
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.kind === "context") {
          const key = `l${foldKey}:${index}`;
          if (mode === "unified") rows.push({ type: "line", key, line });
          else rows.push({ type: "pair", key, left: { line }, right: { line } });
          index++;
          continue;
        }
        // Un changement : les lignes retirées puis les ajoutées qui les remplacent, appariées dans l’ordre.
        const removed: DiffLine[] = [];
        const added: DiffLine[] = [];
        while (index < lines.length && lines[index].kind === "removed") removed.push(lines[index++]);
        while (index < lines.length && lines[index].kind === "added") added.push(lines[index++]);
        const change = changes.length;
        changes.push({
          row: rows.length,
          oldFrom: removed[0]?.oldNumber,
          oldTo: removed[removed.length - 1]?.oldNumber,
          newFrom: added[0]?.newNumber,
          newTo: added[added.length - 1]?.newNumber,
        });
        const key = `c${foldKey}:${index}`;
        if (mode === "unified") {
          removed.forEach((item, at) => {
            rows.push({ type: "line", key: `${key}-${at}`, line: item, pair: added[at], change });
          });
          added.forEach((item, at) => {
            rows.push({ type: "line", key: `${key}+${at}`, line: item, pair: removed[at], change });
          });
        } else {
          for (let at = 0; at < Math.max(removed.length, added.length); at++) {
            rows.push({
              type: "pair",
              key: `${key}=${at}`,
              left: removed[at] ? { line: removed[at], pair: added[at] } : undefined,
              right: added[at] ? { line: added[at], pair: removed[at] } : undefined,
              change,
            });
          }
        }
      }
    });
  });
  if (truncated) rows.push({ type: "notice", key: "truncated", text: "Diff coupé : la suite n’est pas affichée" });
  return { rows, changes };
}

/** Parties changées de `line` face à la ligne qui lui répond, calculées à l’affichage et gardées. */
const wordCache = new WeakMap<DiffLine, Range[] | null>();
function changedRanges(line: DiffLine, pair: DiffLine | undefined): Range[] | null {
  if (!pair) return null;
  if (wordCache.has(line)) return wordCache.get(line) ?? null;
  const [before, after] = line.kind === "removed" ? [line, pair] : [pair, line];
  const ranges = wordChanges(before.text, after.text);
  wordCache.set(before, ranges?.before ?? null);
  wordCache.set(after, ranges?.after ?? null);
  return (line.kind === "removed" ? ranges?.before : ranges?.after) ?? null;
}

function LineText({ line, pair }: { line: DiffLine; pair?: DiffLine }) {
  const ranges = line.kind === "context" ? null : changedRanges(line, pair);
  let content: ReactNode = line.text;
  if (ranges?.length) {
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [from, to] of ranges) {
      if (from > at) parts.push(line.text.slice(at, from));
      parts.push(
        line.kind === "removed" ? (
          <del key={from}>{line.text.slice(from, to)}</del>
        ) : (
          <ins key={from}>{line.text.slice(from, to)}</ins>
        ),
      );
      at = to;
    }
    if (at < line.text.length) parts.push(line.text.slice(at));
    content = parts;
  }
  // La fin de ligne n’est dite que lorsqu’elle diffère de celle de la ligne appariée, ou qu’elle manque.
  const eol =
    pair && pair.eol !== line.eol
      ? eolLabel[line.eol]
      : line.eol === "none" && line.kind !== "context"
        ? eolLabel.none
        : "";
  return (
    <span className="ui-diff__text">
      {content}
      {eol ? <span className="ui-diff__eol">{eol}</span> : null}
    </span>
  );
}

const signs = { context: " ", removed: "−", added: "+" } as const;
const spoken = { context: "", removed: "Retirée : ", added: "Ajoutée : " } as const;

function Sign({ line }: { line: DiffLine }) {
  return (
    <span className="ui-diff__sign">
      <span aria-hidden="true">{signs[line.kind]}</span>
      {spoken[line.kind] ? <span className="sr-only">{spoken[line.kind]}</span> : null}
    </span>
  );
}

function RowView({ row, current, onExpand }: { row: Row; current: boolean; onExpand: (foldKey: string) => void }) {
  switch (row.type) {
    case "file":
      return (
        <h3 className="ui-diff__row ui-diff__file">
          <span className="ui-diff__file-name">{fileTitle(row.file)}</span>
          {row.file.status !== "modified" ? (
            <span className="ui-diff__file-status">{statusLabel[row.file.status]}</span>
          ) : null}
          {!row.file.binary ? (
            <span className="ui-diff__counts">
              <span className="ui-diff__count-added">+{row.file.added}</span>{" "}
              <span className="ui-diff__count-removed">−{row.file.removed}</span>
            </span>
          ) : null}
        </h3>
      );
    case "notice":
      return <div className="ui-diff__row ui-diff__notice">{row.text}</div>;
    case "gap": {
      const text = `${row.count} ligne${row.count > 1 ? "s" : ""} inchangée${row.count > 1 ? "s" : ""}`;
      return (
        <div className="ui-diff__row ui-diff__gap">
          {row.expandable ? (
            <button type="button" className="ui-diff__expand" onClick={() => onExpand(row.foldKey)}>
              <UnfoldVertical size={14} aria-hidden="true" />
              Afficher {text}
            </button>
          ) : (
            <span>
              {text} (à partir de la ligne {row.oldStart})
            </span>
          )}
        </div>
      );
    }
    case "line": {
      const { line } = row;
      return (
        <div className={`ui-diff__row ui-diff__line is-${line.kind}${current ? " is-current" : ""}`}>
          <span className="ui-diff__number">{line.oldNumber ?? ""}</span>
          <span className="ui-diff__number">{line.newNumber ?? ""}</span>
          <Sign line={line} />
          <LineText line={line} pair={row.pair} />
        </div>
      );
    }
    case "pair": {
      const half = (side: Side | undefined, which: "old" | "new") =>
        side ? (
          <>
            <span className={`ui-diff__number is-${side.line.kind}`}>
              {which === "old" ? side.line.oldNumber : side.line.newNumber}
            </span>
            <span className={`ui-diff__half is-${side.line.kind}`}>
              <Sign line={side.line} />
              <LineText line={side.line} pair={side.pair} />
            </span>
          </>
        ) : (
          <>
            <span className="ui-diff__number is-empty" />
            <span className="ui-diff__half is-empty" />
          </>
        );
      return (
        <div className={`ui-diff__row ui-diff__pair${current ? " is-current" : ""}`}>
          {half(row.left, "old")}
          {half(row.right, "new")}
        </div>
      );
    }
  }
}

function lineSpan(from?: number, to?: number): string {
  if (from === undefined) return "";
  return to !== undefined && to !== from ? `${from} à ${to}` : `${from}`;
}

function describeChange(change: Change, index: number, total: number): string {
  const parts: string[] = [];
  if (change.oldFrom !== undefined)
    parts.push(`avant, ligne${change.oldTo !== change.oldFrom ? "s" : ""} ${lineSpan(change.oldFrom, change.oldTo)}`);
  if (change.newFrom !== undefined)
    parts.push(`après, ligne${change.newTo !== change.newFrom ? "s" : ""} ${lineSpan(change.newFrom, change.newTo)}`);
  return `Changement ${index + 1} sur ${total}${parts.length ? ` : ${parts.join(" ; ")}` : ""}`;
}

/**
 * Différences entre deux textes, ou d’un diff unifié (`git.diff`). Vue côte à côte ou en ligne, numéros de ligne, mots
 * changés surlignés, parties inchangées repliées, fichiers binaires et fins de ligne signalés. Seules les rangées
 * visibles sont dessinées : un fichier de dizaines de milliers de lignes reste fluide. Au clavier, dans le diff :
 * F7 / Maj+F7 ou Alt+↓ / Alt+↑ vont au changement suivant ou précédent.
 */
export function DiffView({
  label,
  before,
  after,
  patch,
  truncated = false,
  mode: controlledMode,
  onModeChange,
  context = 3,
  fill = false,
}: DiffViewProps) {
  const [ownMode, setOwnMode] = useState<DiffViewMode>("split");
  const mode = controlledMode ?? ownMode;
  const setMode = (next: DiffViewMode) => {
    setOwnMode(next);
    onModeChange?.(next);
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [current, setCurrent] = useState<number | undefined>(undefined);
  const [announce, setAnnounce] = useState("");
  const hintId = useId();

  const files = useMemo(
    () => (patch !== undefined ? parsePatch(patch) : [diffTexts(before ?? "", after ?? "", context)]),
    [patch, before, after, context],
  );
  // Un nouveau contenu repart replié, sans changement courant.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `files` change exactement quand le contenu change.
  useEffect(() => {
    setExpanded(new Set());
    setCurrent(undefined);
  }, [files]);

  const { rows, changes } = useMemo(
    () => buildRows(files, mode, patch !== undefined, expanded, showAll, truncated),
    [files, mode, patch, expanded, showAll, truncated],
  );
  const foldable = files.some((file) => file.segments.some((segment) => segment.type === "gap" && segment.lines));
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  const offsets = useMemo(() => {
    const result = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) result[i + 1] = result[i] + ROW_HEIGHT[rows[i].type];
    return result;
  }, [rows]);
  // Largeur des colonnes de texte : la plus longue ligne, pour un défilement horizontal commun à toutes les rangées.
  const widths = useMemo(() => {
    let left = 0;
    let right = 0;
    let digits = 1;
    for (const row of rows) {
      if (row.type === "line") {
        left = Math.max(left, row.line.text.length);
        digits = Math.max(digits, String(row.line.oldNumber ?? row.line.newNumber ?? 0).length);
      } else if (row.type === "pair") {
        left = Math.max(left, row.left?.line.text.length ?? 0);
        right = Math.max(right, row.right?.line.text.length ?? 0);
        digits = Math.max(digits, String(row.left?.line.oldNumber ?? row.right?.line.newNumber ?? 0).length);
      }
    }
    return { left: Math.min(left, 4000), right: Math.min(right, 4000), digits };
  }, [rows]);

  const scroller = useRef<HTMLElement>(null);
  const [view, setView] = useState({ top: 0, height: FALLBACK_VIEWPORT, width: 0 });
  const frame = useRef(0);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setView({ top: element.scrollTop, height: element.clientHeight || FALLBACK_VIEWPORT, width: element.clientWidth });
  }, []);
  useLayoutEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const total = offsets[rows.length];
  let first = 0;
  {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle + 1] <= view.top) low = middle + 1;
      else high = middle;
    }
    first = Math.max(0, low - OVERSCAN);
  }
  let last = first;
  while (last < rows.length && offsets[last] < view.top + view.height) last++;
  last = Math.min(rows.length, last + OVERSCAN);

  const goTo = (index: number) => {
    if (!changes.length) return;
    const next = (index + changes.length) % changes.length;
    setCurrent(next);
    setAnnounce(describeChange(changes[next], next, changes.length));
    const element = scroller.current;
    if (element) {
      const height = element.clientHeight || FALLBACK_VIEWPORT;
      element.scrollTop = Math.max(0, offsets[changes[next].row] - height / 3);
      measure();
    }
  };
  const next = () => goTo(current === undefined ? 0 : current + 1);
  const previous = () => goTo(current === undefined ? changes.length - 1 : current - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const forward = (event.key === "F7" && !event.shiftKey) || (event.altKey && event.key === "ArrowDown");
    const backward = (event.key === "F7" && event.shiftKey) || (event.altKey && event.key === "ArrowUp");
    if (!forward && !backward) return;
    event.preventDefault();
    if (forward) next();
    else previous();
  };

  const summary = files.every((file) => file.binary)
    ? "Fichier binaire"
    : changes.length
      ? `${changes.length} changement${changes.length > 1 ? "s" : ""}`
      : "Aucune différence";

  const classes = ["ui-diff", `ui-diff--${mode}`, fill ? "ui-diff--fill" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <div className="ui-diff__bar" role="toolbar" aria-label="Affichage des différences">
        <span className="ui-diff__summary">
          {summary}
          {added || removed ? (
            <span className="ui-diff__counts">
              <span className="ui-diff__count-added">
                <span aria-hidden="true">+{added}</span>
                <span className="sr-only">{`${added} ajoutée${added > 1 ? "s" : ""}`}</span>
              </span>{" "}
              <span className="ui-diff__count-removed">
                <span aria-hidden="true">−{removed}</span>
                <span className="sr-only">{`, ${removed} retirée${removed > 1 ? "s" : ""}`}</span>
              </span>
            </span>
          ) : null}
        </span>
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
        <span className="sr-only" id={hintId}>
          F7 ou Alt+Flèche bas : changement suivant ; Maj+F7 ou Alt+Flèche haut : changement précédent
        </span>
        <ChoiceGroup label="Vue" appearance="segmented">
          <ChoiceButton
            label="Côte à côte"
            variant="label"
            size="compact"
            selected={mode === "split"}
            onClick={() => setMode("split")}
          >
            Côte à côte
          </ChoiceButton>
          <ChoiceButton
            label="En ligne"
            variant="label"
            size="compact"
            selected={mode === "unified"}
            onClick={() => setMode("unified")}
          >
            En ligne
          </ChoiceButton>
        </ChoiceGroup>
        {foldable ? (
          <IconButton
            label={showAll ? "Replier les lignes inchangées" : "Afficher les lignes inchangées"}
            size="compact"
            aria-pressed={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            <UnfoldVertical size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <IconButton label="Changement précédent (Maj+F7)" size="compact" disabled={!changes.length} onClick={previous}>
          <ChevronUp size={16} aria-hidden="true" />
        </IconButton>
        <IconButton label="Changement suivant (F7)" size="compact" disabled={!changes.length} onClick={next}>
          <ChevronDown size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <section
        ref={scroller}
        className="ui-diff__scroller"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: le diff défile et se parcourt de changement en changement au clavier.
        tabIndex={0}
        aria-label={label}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onScroll={() => {
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(measure);
        }}
        style={
          {
            "--ui-diff-left": `${widths.left}ch`,
            "--ui-diff-right": `${widths.right}ch`,
            "--ui-diff-digits": `${Math.max(2, widths.digits)}ch`,
            ...(view.width ? { "--ui-diff-viewport": `${view.width}px` } : {}),
          } as CSSProperties
        }
      >
        <div className="ui-diff__content" style={{ height: total }}>
          <div className="ui-diff__window" style={{ transform: `translateY(${offsets[first]}px)` }}>
            {rows.slice(first, last).map((row) => (
              <RowView
                key={row.key}
                row={row}
                current={current !== undefined && "change" in row && row.change === current}
                onExpand={(foldKey) => setExpanded((keys) => new Set(keys).add(foldKey))}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
