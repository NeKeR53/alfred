import { ArrowDown, ArrowDownToLine, Check, ChevronDown, ChevronUp, Clock, Copy, ListX, WrapText } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AnsiSegment, type AnsiStyle, parseAnsi } from "./ansi";
import { Button, IconButton } from "./Button";
import { ChoiceButton, ChoiceGroup } from "./ChoiceButton";
import { copyText } from "./clipboard";
import { EmptyState } from "./EmptyState";
import { findLines, LineStore, type LogChannel, type LogLevel, type LogLine, logLineLevel } from "./logLines";
import { SearchField } from "./SearchField";
import { StatusDot } from "./StatusDot";

export type { LogChannel, LogLine } from "./logLines";

/** Filtre de niveau d’un journal à niveaux (`levels`) : toutes les lignes, alertes et erreurs, erreurs seules. */
export type LogLevelFilter = "all" | "warning" | "error";

/** Ce que voit l’utilisateur, pour les actions de la page (copie, téléchargement, analyse). */
export interface LogViewerView {
  /** Texte des lignes affichées (filtre de niveau appliqué), sans séquences ANSI ; calculé à la demande. */
  text(): string;
  level: LogLevelFilter;
  /** Aucune ligne affichée. */
  empty: boolean;
}

export interface LogViewerProps {
  /** Nom du journal, pour les lecteurs d’écran : « Journal du build #42 ». */
  label: string;
  /** Lignes du journal, séquences ANSI comprises. Un nouveau tableau remplace le précédent. */
  lines?: readonly LogLine[];
  /** Canal ouvert par une fonction du module : le résultat de `useChannel(id, { keep: 5000 })`. Les lignes s’ajoutent. */
  channel?: LogChannel | null;
  /** La source écrit encore (journal donné en tableau) : « En direct » dans la barre d’état. */
  live?: boolean;
  /** Retour à la ligne au départ (`false` : les longues lignes défilent horizontalement). */
  wrap?: boolean;
  /** Horodatage affiché au départ, quand les lignes ont une heure. */
  timestamps?: boolean;
  /** Lignes gardées d’un canal ; les plus anciennes sont oubliées au-delà (500 000). */
  maxLines?: number;
  /** Premier chargement : rien à montrer encore. */
  loading?: boolean;
  /** Titre de l’état vide : « Journal vide » par défaut. */
  emptyTitle?: string;
  /** Occupe la hauteur restante d’une `Page fill`. */
  fill?: boolean;
  /**
   * Journal à niveaux : filtre « Tous / Alertes / Erreurs » avec ses compteurs, liste des erreurs (un clic mène à la
   * ligne) et compteurs d’erreurs et d’alertes dans la barre d’état. Niveau d’une ligne : `ERROR`, `WARN`,
   * `level=error`, `[warn]`, une exception…
   */
  levels?: boolean;
  /** Réglages propres à la source, en tête de barre (nombre de lignes lues…). */
  tools?: ReactNode;
  /** Actions de la page en fin de barre, d’après ce qui est affiché (télécharger, analyser…). */
  actions?: (view: LogViewerView) => ReactNode;
  /** Complète la barre d’état, à droite. */
  status?: ReactNode;
  /** À la place de l’état vide habituel quand le journal n’a aucune ligne : erreur avec « Réessayer », journal effacé. */
  emptyState?: ReactNode;
}

const LEVEL_CHOICES = [
  ["all", "Tous", "Toutes les lignes"],
  ["warning", "Alertes", "Alertes et erreurs"],
  ["error", "Erreurs", "Erreurs"],
] as const;
const ERROR_LIST_LIMIT = 200;

/** Position d’une valeur dans un tableau trié, -1 si absente. */
function positionOf(sorted: readonly number[], value: number) {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] === value) return middle;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

const OVERSCAN = 24;
const DEFAULT_ROW = 18;
/** Hauteur supposée tant que la zone n’est pas mesurée (jsdom, premier rendu). */
const DEFAULT_VIEWPORT = 480;
/** Au-delà, la ligne est coupée à l’affichage ; la recherche et la copie gardent tout. */
const DISPLAY_LIMIT = 10_000;

const timeFormat = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
});

const count = (value: number, singular: string, plural: string) =>
  `${value.toLocaleString("fr-FR")} ${value > 1 ? plural : singular}`;

function styleClass(style: AnsiStyle) {
  let fg = style.fg;
  let bg = style.bg;
  const classes: string[] = [];
  if (style.inverse) {
    classes.push("is-inverse");
    [fg, bg] = [bg, fg];
  }
  if (fg !== undefined) classes.push(`ui-ansi-fg-${style.bold && fg < 8 ? fg + 8 : fg}`);
  if (bg !== undefined) classes.push(`ui-ansi-bg-${bg}`);
  if (style.bold) classes.push("is-bold");
  if (style.dim) classes.push("is-dim");
  if (style.italic) classes.push("is-italic");
  if (style.underline) classes.push("is-underline");
  if (style.strike) classes.push("is-strike");
  return classes.join(" ") || undefined;
}

/** Morceaux stylés d’une ligne, les occurrences de la recherche entourées de `<mark>`. */
function renderSegments(segments: AnsiSegment[], query: string): ReactNode[] {
  const plain = segments.map((segment) => segment.text).join("");
  const ranges: [number, number][] = [];
  if (query) {
    const haystack = plain.toLocaleLowerCase("fr-FR");
    let from = haystack.indexOf(query);
    while (from >= 0) {
      ranges.push([from, from + query.length]);
      from = haystack.indexOf(query, from + query.length);
    }
  }
  const nodes: ReactNode[] = [];
  let offset = 0;
  let range = 0;
  segments.forEach((segment) => {
    const className = styleClass(segment.style);
    const end = offset + segment.text.length;
    if (!ranges.length) {
      nodes.push(
        className ? (
          <span key={offset} className={className}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      );
      offset = end;
      return;
    }
    let cursor = offset;
    const parts: ReactNode[] = [];
    while (cursor < end) {
      while (range < ranges.length && ranges[range][1] <= cursor) range += 1;
      const current = ranges[range];
      if (current && current[0] <= cursor) {
        const stop = Math.min(end, current[1]);
        parts.push(<mark key={cursor}>{segment.text.slice(cursor - offset, stop - offset)}</mark>);
        cursor = stop;
      } else {
        const stop = Math.min(end, current ? current[0] : end);
        parts.push(segment.text.slice(cursor - offset, stop - offset));
        cursor = stop;
      }
    }
    nodes.push(
      <span key={offset} className={className}>
        {parts}
      </span>,
    );
    offset = end;
  });
  return nodes;
}

function LineText({ raw, query }: { raw: string; query: string }) {
  const long = raw.length > DISPLAY_LIMIT;
  const segments = useMemo(() => parseAnsi(long ? raw.slice(0, DISPLAY_LIMIT) : raw), [raw, long]);
  return (
    <>
      {renderSegments(segments, query)}
      {long ? <span className="ui-log-viewer__cut"> … ligne coupée à l’affichage</span> : null}
    </>
  );
}

/**
 * Journal très long (100 000 lignes et plus) en liste virtualisée : seules les lignes visibles sont dans la page.
 * Couleurs ANSI lues sans HTML, suivi de la fin mis en pause dès qu’on remonte, recherche ligne à ligne, retour à la
 * ligne, horodatage et copie. Alimenté par un tableau (`lines`) ou par un canal (`channel`).
 */
export function LogViewer({
  label,
  lines,
  channel,
  live = false,
  wrap: initialWrap = false,
  timestamps: initialTimestamps = false,
  maxLines = 500_000,
  loading = false,
  emptyTitle = "Journal vide",
  fill = false,
  levels = false,
  tools,
  actions,
  status: extraStatus,
  emptyState,
}: LogViewerProps) {
  // --- Lignes : le magasin est alimenté pendant le rendu, une seule fois par tableau ou par lot d’événements.
  const storeRef = useRef<LineStore>(null);
  storeRef.current ??= new LineStore(maxLines);
  const store = storeRef.current;
  const fed = useRef<{ lines?: readonly LogLine[]; events?: LogChannel["events"]; version: number }>({ version: 0 });
  const levelCache = useRef<{ dropped: number; levels: (LogLevel | undefined)[] }>({ dropped: 0, levels: [] });
  if (lines && fed.current.lines !== lines) {
    store.replace(lines);
    levelCache.current = { dropped: 0, levels: [] };
    fed.current = { ...fed.current, lines, version: fed.current.version + 1 };
  }
  if (channel && fed.current.events !== channel.events) {
    const changed = store.append(channel);
    fed.current = { ...fed.current, events: channel.events, version: fed.current.version + (changed ? 1 : 0) };
  }
  const version = fed.current.version;
  const total = store.lines.length;
  const streaming = channel ? !channel.closed : live;

  // --- Niveaux : chaque ligne est classée une fois ; la dernière est relue, un flux brut pouvant la compléter.
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const [errorsOpen, setErrorsOpen] = useState(false);
  const levelInfo = useMemo(() => {
    void version;
    if (!levels) return null;
    const cache = levelCache.current;
    if (store.dropped < cache.dropped) cache.levels = [];
    else if (store.dropped > cache.dropped) cache.levels.splice(0, store.dropped - cache.dropped);
    cache.dropped = store.dropped;
    if (cache.levels.length > store.lines.length) cache.levels = [];
    for (let index = Math.max(0, cache.levels.length - 1); index < store.lines.length; index += 1)
      cache.levels[index] = logLineLevel(store.text(index));
    const errors: number[] = [];
    const alerts: number[] = [];
    let warnings = 0;
    cache.levels.forEach((value, index) => {
      if (!value) return;
      alerts.push(index);
      if (value === "error") errors.push(index);
      else warnings += 1;
    });
    return { errors, alerts, warnings };
  }, [levels, store, version]);
  /** Lignes affichées (indices du magasin) quand un filtre de niveau s’applique ; `null` : toutes. */
  const view = levelInfo && level !== "all" ? (level === "error" ? levelInfo.errors : levelInfo.alerts) : null;
  const shownCount = view ? view.length : total;
  const lineAt = useCallback((position: number) => (view ? view[position] : position), [view]);

  // --- Affichage.
  const [wrap, setWrap] = useState(initialWrap);
  const hasTimes = useMemo(() => {
    void version;
    return store.lines.some((line) => line.time !== undefined);
  }, [store, version]);
  const [showTimes, setShowTimes] = useState(initialTimestamps);
  const timesShown = showTimes && hasTimes;

  // --- Mesures de la zone qui défile.
  const viewport = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ height: 0, width: 0 });
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW);
  const heights = useRef(new Float64Array(0));
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setSize({ height: element.clientHeight, width: element.clientWidth });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Une ligne mesurée donne la hauteur de toutes les lignes sans retour à la ligne (police, échelle d’affichage).
  useLayoutEffect(() => {
    const row = windowRef.current?.querySelector<HTMLElement>(".ui-log-viewer__line");
    if (wrap || !row) return;
    const height = row.getBoundingClientRect().height;
    if (height > 0 && Math.abs(height - rowHeight) > 0.25) setRowHeight(height);
  });

  // Avec retour à la ligne, chaque ligne a sa hauteur : elles sont mesurées une fois affichées.
  // biome-ignore lint/correctness/useExhaustiveDependencies: la largeur, l’horodatage et l’oubli des premières lignes invalident les hauteurs.
  useLayoutEffect(() => {
    heights.current = new Float64Array(0);
    setMeasured((value) => value + 1);
  }, [wrap, size.width, timesShown, store.dropped, view]);
  if (wrap && heights.current.length < shownCount) {
    const grown = new Float64Array(Math.max(shownCount, heights.current.length * 2, 1024));
    grown.set(heights.current);
    heights.current = grown;
  }

  const offsets = useMemo(() => {
    void measured;
    if (!wrap) return null;
    const result = new Float64Array(shownCount + 1);
    for (let index = 0; index < shownCount; index += 1)
      result[index + 1] = result[index] + (heights.current[index] || rowHeight);
    return result;
  }, [wrap, shownCount, rowHeight, measured]);
  const offsetOf = useCallback((index: number) => (offsets ? offsets[index] : index * rowHeight), [offsets, rowHeight]);
  const indexAt = useCallback(
    (y: number) => {
      if (!offsets) return Math.floor(y / rowHeight);
      let low = 0;
      let high = shownCount;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle + 1] <= y) low = middle + 1;
        else high = middle;
      }
      return low;
    },
    [offsets, rowHeight, shownCount],
  );
  const contentHeight = offsetOf(shownCount);
  const viewHeight = size.height || DEFAULT_VIEWPORT;
  const first = Math.max(0, Math.min(shownCount, indexAt(scrollTop)) - OVERSCAN);
  const last = Math.min(shownCount, indexAt(scrollTop + viewHeight) + 1 + OVERSCAN);

  // --- Suivi de la fin : actif au départ, suspendu dès qu’on remonte, repris en bas ou par « Revenir à la fin ».
  const [follow, setFollowState] = useState(true);
  const [pausedAt, setPausedAt] = useState(0);
  const followRef = useRef(true);
  const setFollow = useCallback(
    (next: boolean) => {
      if (followRef.current === next) return;
      followRef.current = next;
      setFollowState(next);
      setPausedAt(store.dropped + store.lines.length);
    },
    [store],
  );
  /** Ligne à centrer (résultat de recherche) ; recentrée tant que les hauteurs mesurées la déplacent. */
  const reveal = useRef<number | undefined>(undefined);
  const remeasured = useRef(false);

  const center = useCallback(
    (index: number) => {
      const element = viewport.current;
      if (!element) return;
      const top = Math.max(0, offsetOf(index) - viewHeight / 2 + rowHeight / 2);
      element.scrollTop = top;
      setScrollTop(element.scrollTop || top);
    },
    [offsetOf, rowHeight, viewHeight],
  );

  useLayoutEffect(() => {
    const element = viewport.current;
    remeasured.current = false;
    if (!element || !wrap) return;
    let changed = false;
    let above = 0;
    const anchor = indexAt(element.scrollTop);
    for (const row of element.querySelectorAll<HTMLElement>(".ui-log-viewer__line")) {
      const index = Number(row.dataset.index);
      const height = row.getBoundingClientRect().height;
      if (!(height > 0) || Math.abs((heights.current[index] || rowHeight) - height) < 0.5) {
        if (height > 0) heights.current[index] = height;
        continue;
      }
      if (index < anchor) above += height - (heights.current[index] || rowHeight);
      heights.current[index] = height;
      changed = true;
    }
    if (!changed) return;
    // Hors suivi, la ligne lue ne bouge pas quand celles du dessus prennent leur vraie hauteur.
    if (!followRef.current && above && reveal.current === undefined) element.scrollTop += above;
    remeasured.current = true;
    setMeasured((value) => value + 1);
  });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (follow) {
      element.scrollTop = element.scrollHeight;
      if (element.scrollTop !== scrollTop) setScrollTop(element.scrollTop);
    } else if (reveal.current !== undefined) {
      center(reveal.current);
      if (!remeasured.current) reveal.current = undefined;
    }
  });

  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
    setFollow(atBottom);
  };

  // --- Recherche : les lignes qui contiennent le texte, sans tenir compte de la casse.
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase("fr-FR"));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` signale de nouvelles lignes dans le même magasin.
  const found = useMemo(() => findLines(store, deferred), [store, deferred, version]);
  /** Résultats en positions affichées : un filtre de niveau écarte ceux qu’il cache. */
  const matches = useMemo(
    () => (view ? found.map((line) => positionOf(view, line)).filter((position) => position >= 0) : found),
    [found, view],
  );
  const [matchPos, setMatchPos] = useState(-1);
  const currentLine = matchPos >= 0 ? matches[matchPos] : undefined;

  const goTo = useCallback(
    (position: number) => {
      const line = matches[position];
      if (line === undefined) return;
      setMatchPos(position);
      setFollow(false);
      reveal.current = line;
      center(line);
    },
    [center, matches, setFollow],
  );
  // Une nouvelle recherche mène au plus récent résultat quand le journal suit la fin, sinon au premier sous la
  // lecture, sinon au dernier au-dessus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seule une nouvelle recherche déplace la lecture.
  useEffect(() => {
    if (!deferred) {
      setMatchPos(-1);
      return;
    }
    if (!matches.length) return;
    const top = indexAt(scrollTop);
    const below = matches.findIndex((line) => line >= top);
    goTo(followRef.current || below < 0 ? matches.length - 1 : below);
  }, [deferred]);
  const move = (direction: 1 | -1) => {
    if (!matches.length) return;
    const from = matchPos < 0 ? (direction > 0 ? -1 : 0) : matchPos;
    goTo((from + direction + matches.length) % matches.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "F3") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  };

  /** Texte des lignes affichées, filtre de niveau compris. */
  const displayedText = () =>
    view
      ? view.map((index) => store.text(index)).join("\n")
      : store.lines.map((_, index) => store.text(index)).join("\n");

  // --- Liste des erreurs : un clic montre la ligne dans tout le journal.
  const [revealed, setRevealed] = useState<number>();
  const revealLine = (index: number) => {
    setLevel("all");
    setMatchPos(-1);
    setFollow(false);
    setRevealed(index);
    reveal.current = index;
  };

  // --- Copie : la sélection faite dans le journal, sinon tout le journal.
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const element = viewport.current;
      setHasSelection(
        Boolean(
          selection &&
            !selection.isCollapsed &&
            element &&
            selection.anchorNode &&
            element.contains(selection.anchorNode),
        ),
      );
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copy = async () => {
    const selection = document.getSelection();
    const text = hasSelection && selection ? selection.toString() : displayedText();
    try {
      await copyText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied("idle"), 1600);
  };
  const copyLabel = hasSelection ? "Copier la sélection" : "Copier le journal";
  const copyTooltip = copied === "copied" ? "Copié" : copied === "failed" ? "Copie impossible" : copyLabel;

  // --- Rendu.
  const searchId = useId();
  const newLines = follow ? 0 : Math.max(0, store.dropped + total - pausedAt);
  const digits = String(store.dropped + total).length;
  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const at = lineAt(index);
    const line = store.lines[at];
    if (!line) continue;
    const classes = ["ui-log-viewer__line"];
    if (line.stderr) classes.push("is-stderr");
    if (levelInfo && levelCache.current.levels[at]) classes.push(`is-${levelCache.current.levels[at]}`);
    if (index === currentLine || (!view && at === revealed && currentLine === undefined)) classes.push("is-current");
    else if (deferred && matches.length && store.text(at).toLocaleLowerCase("fr-FR").includes(deferred))
      classes.push("is-match");
    rows.push(
      <div
        key={store.dropped + at}
        className={classes.join(" ")}
        data-index={index}
        data-number={store.dropped + at + 1}
        data-time={timesShown && line.time !== undefined ? timeFormat.format(line.time) : undefined}
      >
        <span className="ui-log-viewer__text">
          {line.stderr ? <span className="visually-hidden">Erreur : </span> : null}
          <LineText raw={line.raw} query={deferred} />
        </span>
      </div>,
    );
  }

  const status = channel?.error
    ? { tone: "danger" as const, text: `Lecture interrompue : ${channel.error.message}` }
    : streaming
      ? { tone: "success" as const, text: "En direct" }
      : channel?.closed
        ? { tone: "neutral" as const, text: channel.reason ? `Flux terminé : ${channel.reason}` : "Flux terminé" }
        : null;

  const classes = ["ui-log-viewer", fill ? "ui-log-viewer--fill" : "", wrap ? "ui-log-viewer--wrap" : ""]
    .filter(Boolean)
    .join(" ");
  const empty = total === 0;
  const viewEmpty = shownCount === 0;
  const pageView: LogViewerView = { text: displayedText, level, empty: viewEmpty };
  return (
    <section className={classes} aria-label={label} onKeyDown={onKeyDown}>
      <div className="ui-log-viewer__bar" role="toolbar" aria-label="Outils du journal">
        {tools}
        {levelInfo ? (
          <ChoiceGroup label="Niveau" appearance="segmented">
            {LEVEL_CHOICES.map(([value, choice, choiceLabel]) => (
              <ChoiceButton
                key={value}
                label={choiceLabel}
                variant="label"
                size="compact"
                selected={level === value}
                onClick={() => {
                  setLevel(value);
                  setMatchPos(-1);
                  setRevealed(undefined);
                }}
              >
                {choice}{" "}
                <span className="ui-log-viewer__level-count">
                  {(value === "all"
                    ? total
                    : value === "warning"
                      ? levelInfo.alerts.length
                      : levelInfo.errors.length
                  ).toLocaleString("fr-FR")}
                </span>
              </ChoiceButton>
            ))}
          </ChoiceGroup>
        ) : null}
        <SearchField
          label="Rechercher dans le journal"
          placeholder="Rechercher…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={searchId}
          aria-keyshortcuts="Enter Shift+Enter F3 Shift+F3"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
          className="ui-log-viewer__search"
        />
        <span className="ui-log-viewer__matches" id={searchId} aria-live="polite">
          {deferred ? (matches.length ? `${matchPos + 1} sur ${matches.length}` : "Aucune ligne") : ""}
        </span>
        <IconButton
          label="Ligne précédente"
          tooltip="Ligne précédente (Maj+F3)"
          disabled={!matches.length}
          onClick={() => move(-1)}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Ligne suivante"
          tooltip="Ligne suivante (F3)"
          disabled={!matches.length}
          onClick={() => move(1)}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </IconButton>
        <span className="ui-log-viewer__spacer" />
        {streaming ? (
          <ChoiceButton
            label={follow ? "Suspendre le suivi (Fin pour reprendre)" : "Suivre la fin du journal (Fin)"}
            variant="label"
            size="compact"
            selected={follow}
            aria-keyshortcuts="End"
            onClick={() => {
              if (follow) setFollow(false);
              else {
                reveal.current = undefined;
                setFollow(true);
              }
            }}
          >
            <ArrowDownToLine size={16} aria-hidden="true" />
            Suivre
          </ChoiceButton>
        ) : null}
        <IconButton label="Retour à la ligne" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>
          <WrapText size={16} aria-hidden="true" />
        </IconButton>
        {hasTimes ? (
          <IconButton label="Horodatage" aria-pressed={showTimes} onClick={() => setShowTimes((value) => !value)}>
            <Clock size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        {levelInfo ? (
          <IconButton
            label="Liste des erreurs"
            aria-pressed={errorsOpen}
            aria-controls={`${searchId}-erreurs`}
            onClick={() => setErrorsOpen((value) => !value)}
          >
            <ListX size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <IconButton label={copyLabel} tooltip={copyTooltip} disabled={viewEmpty} onClick={() => void copy()}>
          {copied === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </IconButton>
        {actions ? <span className="ui-log-viewer__actions">{actions(pageView)}</span> : null}
      </div>
      {empty ? (
        <div className="ui-log-viewer__empty">
          {emptyState ?? (
            <EmptyState
              size="compact"
              title={loading ? "Chargement du journal…" : streaming ? "En attente des premières lignes…" : emptyTitle}
            />
          )}
        </div>
      ) : null}
      <div className="ui-log-viewer__body" hidden={empty}>
        {viewEmpty && !empty ? (
          <div className="ui-log-viewer__empty">
            <EmptyState size="compact" title="Aucune ligne de ce niveau." />
          </div>
        ) : null}
        <div
          ref={viewport}
          className="ui-log-viewer__viewport"
          hidden={viewEmpty}
          role="log"
          aria-live="off"
          aria-label={`${label}, ${count(total, "ligne", "lignes")}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: la zone qui défile se lit et se parcourt au clavier.
          tabIndex={0}
          onScroll={onScroll}
          onWheel={(event) => {
            reveal.current = undefined;
            if (event.deltaY < 0) setFollow(false);
          }}
          onKeyDown={(event) => {
            reveal.current = undefined;
            if (["ArrowUp", "PageUp", "Home"].includes(event.key)) setFollow(false);
            else if (event.key === "End" && !event.ctrlKey) {
              event.preventDefault();
              setFollow(true);
            }
          }}
          style={{ "--ui-log-gutter": `${digits + 1}ch` } as CSSProperties}
        >
          <div className="ui-log-viewer__content" style={{ height: contentHeight }}>
            <div
              ref={windowRef}
              className="ui-log-viewer__window"
              style={{ transform: `translateY(${offsetOf(first)}px)` }}
            >
              {rows}
            </div>
          </div>
        </div>
        {levelInfo && errorsOpen ? (
          <aside className="ui-log-viewer__errors" id={`${searchId}-erreurs`} aria-label="Erreurs du journal">
            <h2>Erreurs · {levelInfo.errors.length.toLocaleString("fr-FR")}</h2>
            {levelInfo.errors.length ? (
              <ul>
                {levelInfo.errors.slice(0, ERROR_LIST_LIMIT).map((index) => (
                  <li key={store.dropped + index}>
                    <button type="button" onClick={() => revealLine(index)}>
                      <small>Ligne {(store.dropped + index + 1).toLocaleString("fr-FR")}</small>
                      <code>{store.text(index).trim()}</code>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState size="compact" title="Aucune erreur relevée dans ce journal." />
            )}
            {levelInfo.errors.length > ERROR_LIST_LIMIT ? (
              <p>Seules les {ERROR_LIST_LIMIT} premières erreurs sont listées.</p>
            ) : null}
          </aside>
        ) : null}
      </div>
      <div className="ui-log-viewer__status">
        <span className="ui-log-viewer__count">
          {count(total, "ligne", "lignes")}
          {store.dropped ? ` (${count(store.dropped, "plus ancienne oubliée", "plus anciennes oubliées")})` : ""}
        </span>
        {levelInfo?.errors.length ? (
          <span className="ui-log-viewer__count ui-log-viewer__count--error">
            {count(levelInfo.errors.length, "erreur", "erreurs")}
          </span>
        ) : null}
        {levelInfo?.warnings ? (
          <span className="ui-log-viewer__count ui-log-viewer__count--warning">
            {count(levelInfo.warnings, "alerte", "alertes")}
          </span>
        ) : null}
        {status ? (
          <span className={`ui-log-viewer__state ui-log-viewer__state--${status.tone}`}>
            <StatusDot tone={status.tone} />
            {status.text}
          </span>
        ) : null}
        {follow ? null : (
          <span className="ui-log-viewer__paused">
            <span aria-live="polite">
              Suivi en pause{newLines ? ` · ${count(newLines, "nouvelle ligne", "nouvelles lignes")}` : ""}
            </span>
            <Button
              className="ui-log-viewer__resume"
              onClick={() => {
                setFollow(true);
                viewport.current?.focus({ preventScroll: true });
              }}
            >
              <ArrowDown size={16} aria-hidden="true" />
              Revenir à la fin
            </Button>
          </span>
        )}
        {extraStatus ? <span className="ui-log-viewer__extra">{extraStatus}</span> : null}
      </div>
    </section>
  );
}
