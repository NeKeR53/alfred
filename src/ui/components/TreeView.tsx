import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Action, type ActionIcon, useRunAction } from "../templates/actions";
import { IconButton } from "./Button";
import { EmptyState } from "./EmptyState";
import "./tree-view.css";

/** Un nœud de l’arbre : un dossier, un fichier, un chemin de secret, un dépôt, une branche… */
export interface TreeNode<Data = unknown> {
  /** Identifiant unique dans tout l’arbre (un chemin complet convient). */
  id: string;
  label: string;
  /** Icône Lucide du nœud (`Folder`, `FileText`, `KeyRound`, `GitBranch`…), posée en 16 px. */
  icon?: ActionIcon;
  /** Icône du nœud ouvert (`FolderOpen`) ; par défaut `icon`. */
  openIcon?: ActionIcon;
  /** Texte discret en bout de ligne : taille, branche courante, nombre d’éléments. */
  meta?: string;
  /** Enfants déjà connus. Absents avec `hasChildren`, ils sont demandés à `loadChildren` à l’ouverture. */
  children?: ReadonlyArray<TreeNode<Data>>;
  /** Le nœud peut s’ouvrir alors que ses enfants ne sont pas encore chargés. */
  hasChildren?: boolean;
  disabled?: boolean;
  /** Donnée de la page, rendue telle quelle à `onActivate`, `actions`, `loadChildren`. */
  data?: Data;
}

/**
 * Action d’un nœud : un bouton icône en bout de ligne, visible au survol et quand la ligne a le focus. Elle s’exécute
 * comme une `Action` : `danger` (ou `confirm`) demande d’abord confirmation, un échec est notifié.
 */
export type TreeAction = Pick<Action, "label" | "onClick" | "danger" | "confirm" | "confirmMessage" | "success"> & {
  icon: ActionIcon;
};

type LoadState = { status: "loading" } | { status: "error"; message: string };

type FlatRow<Data> =
  | {
      kind: "node";
      node: TreeNode<Data>;
      level: number;
      parentId: string | null;
      position: number;
      size: number;
      expandable: boolean;
      expanded: boolean;
    }
  | { kind: "loading"; id: string; level: number }
  | { kind: "error"; id: string; level: number; message: string };

const ROW_HEIGHT = 28;
const OVERSCAN = 12;
const TYPEAHEAD_DELAY = 600;

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Le contenu n’a pas pu être chargé.";
}

/**
 * Arbre hiérarchique (motif « tree » de l’ARIA) : dossiers d’un poste, chemins de secrets, dépôts et branches.
 * Navigation au clavier (flèches, Début, Fin, première lettre, `*`), enfants chargés à l’ouverture avec un état de
 * chargement et d’erreur propre à chaque nœud, sélection simple ou multiple, actions en bout de ligne, et lignes
 * virtualisées au-delà de `virtualizeFrom` nœuds visibles.
 */
export function TreeView<Data = unknown>({
  label,
  nodes,
  loadChildren,
  selection = "single",
  selected,
  defaultSelected,
  onSelectedChange,
  expanded,
  defaultExpanded,
  onExpandedChange,
  onActivate,
  actions,
  emptyTitle = "Aucun élément",
  emptyDescription,
  fill = false,
  virtualizeFrom = 1000,
}: {
  /** Nom accessible de l’arbre (« Dossiers », « Secrets de production »). */
  label: string;
  nodes: ReadonlyArray<TreeNode<Data>>;
  /** Charge les enfants d’un nœud `hasChildren` sans `children` ; une promesse rejetée affiche l’erreur et « Réessayer ». */
  loadChildren?: (node: TreeNode<Data>) => Promise<ReadonlyArray<TreeNode<Data>>>;
  /** `"single"` (par défaut), `"multiple"` (Ctrl ou ⌘ et Maj au clic, Espace et Maj+flèches au clavier) ou `"none"`. */
  selection?: "single" | "multiple" | "none";
  /** Identifiants sélectionnés (contrôlé). */
  selected?: ReadonlyArray<string>;
  defaultSelected?: ReadonlyArray<string>;
  onSelectedChange?: (ids: string[]) => void;
  /** Identifiants ouverts (contrôlé). */
  expanded?: ReadonlyArray<string>;
  defaultExpanded?: ReadonlyArray<string>;
  onExpandedChange?: (ids: string[]) => void;
  /** Ouvre l’élément : Entrée ou double clic (un fichier dans l’éditeur, un secret dans le panneau). */
  onActivate?: (node: TreeNode<Data>) => void;
  /** Actions d’un nœud, en boutons icônes en bout de ligne. */
  actions?: (node: TreeNode<Data>) => ReadonlyArray<TreeAction>;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Occupe la hauteur restante de son conteneur et y fait défiler ses lignes. */
  fill?: boolean;
  /** Nombre de lignes visibles à partir duquel seules celles à l’écran sont rendues. */
  virtualizeFrom?: number;
}) {
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded));
  const openIds = useMemo(() => (expanded ? new Set(expanded) : ownExpanded), [expanded, ownExpanded]);
  const [ownSelected, setOwnSelected] = useState<ReadonlySet<string>>(() => new Set(defaultSelected));
  const selectedIds = useMemo(() => (selected ? new Set(selected) : ownSelected), [selected, ownSelected]);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ReadonlyArray<TreeNode<Data>>>>(() => new Map());
  const [loads, setLoads] = useState<ReadonlyMap<string, LoadState>>(() => new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const focusPending = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const { run } = useRunAction();
  const errorPrefix = useRef(`tree-${Math.random().toString(36).slice(2)}`).current;

  const childrenOf = useCallback((node: TreeNode<Data>) => node.children ?? loaded.get(node.id), [loaded]);

  const rows = useMemo(() => {
    const result: FlatRow<Data>[] = [];
    const walk = (list: ReadonlyArray<TreeNode<Data>>, level: number, parentId: string | null) => {
      list.forEach((node, index) => {
        const children = childrenOf(node);
        const expandable = Boolean(children?.length) || (node.hasChildren === true && children === undefined);
        const open = expandable && openIds.has(node.id);
        result.push({
          kind: "node",
          node,
          level,
          parentId,
          position: index + 1,
          size: list.length,
          expandable,
          expanded: open,
        });
        if (!open) return;
        if (children) walk(children, level + 1, node.id);
        else {
          const state = loads.get(node.id);
          if (state?.status === "error")
            result.push({ kind: "error", id: node.id, level: level + 1, message: state.message });
          else result.push({ kind: "loading", id: node.id, level: level + 1 });
        }
      });
    };
    walk(nodes, 1, null);
    return result;
  }, [nodes, childrenOf, openIds, loads]);

  const nodeRows = useMemo(
    () => rows.filter((row): row is Extract<FlatRow<Data>, { kind: "node" }> => row.kind === "node"),
    [rows],
  );
  const rowIndex = useMemo(
    () => new Map(rows.map((row, index) => [row.kind === "node" ? row.node.id : `${row.kind}:${row.id}`, index])),
    [rows],
  );
  const focusable = useMemo(() => nodeRows.filter((row) => !row.node.disabled), [nodeRows]);

  // Le nœud actif reste un nœud visible : à défaut, le premier sélectionné, puis le premier de l’arbre.
  const currentId = useMemo(() => {
    if (activeId && focusable.some((row) => row.node.id === activeId)) return activeId;
    return focusable.find((row) => selectedIds.has(row.node.id))?.node.id ?? focusable[0]?.node.id ?? null;
  }, [activeId, focusable, selectedIds]);

  const load = useCallback(
    (node: TreeNode<Data>) => {
      if (!loadChildren || node.children || loaded.has(node.id)) return;
      if (loads.get(node.id)?.status === "loading") return;
      setLoads((current) => new Map(current).set(node.id, { status: "loading" }));
      loadChildren(node).then(
        (children) => {
          setLoaded((current) => new Map(current).set(node.id, children));
          setLoads((current) => {
            const next = new Map(current);
            next.delete(node.id);
            return next;
          });
        },
        (error: unknown) =>
          setLoads((current) => new Map(current).set(node.id, { status: "error", message: messageOf(error) })),
      );
    },
    [loadChildren, loaded, loads],
  );

  // Un nœud ouvert d’emblée (`defaultExpanded`, `expanded`) dont les enfants manquent les demande aussitôt.
  useEffect(() => {
    for (const row of rows) {
      if (row.kind !== "loading" || loads.has(row.id)) continue;
      const node = nodeRows.find((candidate) => candidate.node.id === row.id)?.node;
      if (node) load(node);
    }
  }, [rows, nodeRows, loads, load]);

  const setOpen = useCallback(
    (ids: Iterable<string>, open: boolean) => {
      const next = new Set(openIds);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      if (!expanded) setOwnExpanded(next);
      onExpandedChange?.([...next]);
    },
    [openIds, expanded, onExpandedChange],
  );

  const expand = (row: Extract<FlatRow<Data>, { kind: "node" }>) => {
    setOpen([row.node.id], true);
    if (row.node.hasChildren && childrenOf(row.node) === undefined) load(row.node);
  };

  const retry = (node: TreeNode<Data>) => load(node);

  const commitSelection = (next: Set<string>) => {
    if (!selected) setOwnSelected(next);
    onSelectedChange?.([...next]);
  };

  const range = (from: string, to: string) => {
    const ids = focusable.map((row) => row.node.id);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  };

  const select = (id: string, mode: "replace" | "toggle" | "range") => {
    if (selection === "none") return;
    if (selection === "single" || mode === "replace") {
      commitSelection(new Set([id]));
      setAnchorId(id);
      return;
    }
    if (mode === "toggle") {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      commitSelection(next);
      setAnchorId(id);
      return;
    }
    commitSelection(new Set(range(anchorId ?? currentId ?? id, id)));
  };

  const moveTo = (id: string | undefined) => {
    if (!id) return;
    focusPending.current = true;
    setActiveId(id);
  };

  // Virtualisation : seules les lignes à l’écran (et une marge) sont rendues, à hauteur fixe.
  const virtual = rows.length >= virtualizeFrom;
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

  const windowHeight = viewport.height || ROW_HEIGHT * 30;
  const first = virtual ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtual
    ? Math.min(rows.length, Math.ceil((viewport.top + windowHeight) / ROW_HEIGHT) + OVERSCAN)
    : rows.length;

  // Une ligne amenée au clavier hors de l’écran y revient avant de recevoir le focus.
  useLayoutEffect(() => {
    if (!focusPending.current || !currentId) return;
    const element = scroller.current;
    const index = rowIndex.get(currentId);
    if (virtual && element && index !== undefined) {
      const top = index * ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      if (element.scrollTop !== viewport.top) setViewport({ top: element.scrollTop, height: element.clientHeight });
    }
  });
  useEffect(() => {
    if (!focusPending.current || !currentId) return;
    const item = scroller.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(currentId)}"]`);
    if (item) {
      focusPending.current = false;
      item.focus({ preventScroll: virtual });
      if (!virtual) item.scrollIntoView?.({ block: "nearest" });
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const index = focusable.findIndex((row) => row.node.id === currentId);
    const row = focusable[index];
    if (!row) return;
    const multi = selection === "multiple";
    const step = (delta: number) => {
      const next = focusable[Math.max(0, Math.min(focusable.length - 1, index + delta))];
      if (!next) return;
      moveTo(next.node.id);
      if (multi && event.shiftKey) select(next.node.id, "range");
    };
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight || windowHeight) / ROW_HEIGHT) - 1);
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "PageDown":
        step(page);
        break;
      case "PageUp":
        step(-page);
        break;
      case "Home":
        moveTo(focusable[0]?.node.id);
        if (multi && event.shiftKey && focusable[0]) select(focusable[0].node.id, "range");
        break;
      case "End": {
        const lastRow = focusable[focusable.length - 1];
        moveTo(lastRow?.node.id);
        if (multi && event.shiftKey && lastRow) select(lastRow.node.id, "range");
        break;
      }
      case "ArrowRight":
        if (row.expandable && !row.expanded) expand(row);
        else if (row.expanded) {
          const state = loads.get(row.node.id);
          if (state?.status === "error") retry(row.node);
          else {
            const child = focusable[index + 1];
            if (child && child.parentId === row.node.id) moveTo(child.node.id);
          }
        }
        break;
      case "ArrowLeft":
        if (row.expanded) setOpen([row.node.id], false);
        else if (row.parentId) moveTo(row.parentId);
        break;
      case "Enter":
        if (selection === "single") select(row.node.id, "replace");
        if (onActivate) onActivate(row.node);
        else if (row.expandable) {
          if (row.expanded) setOpen([row.node.id], false);
          else expand(row);
        }
        break;
      case " ":
        select(row.node.id, multi ? "toggle" : "replace");
        break;
      case "*": {
        const siblings = nodeRows.filter(
          (other) => other.parentId === row.parentId && other.expandable && !other.expanded,
        );
        setOpen(
          siblings.map((other) => other.node.id),
          true,
        );
        for (const other of siblings)
          if (other.node.hasChildren && childrenOf(other.node) === undefined) load(other.node);
        break;
      }
      default:
        if (multi && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
          commitSelection(new Set(focusable.map((other) => other.node.id)));
          break;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.trim()) {
          const now = Date.now();
          const text = now - typeahead.current.at < TYPEAHEAD_DELAY ? typeahead.current.text + event.key : event.key;
          typeahead.current = { text, at: now };
          const wanted = text.toLocaleLowerCase("fr");
          // Une même lettre répétée passe au nœud suivant qui commence par elle.
          const repeated = [...wanted].every((char) => char === wanted[0]);
          const search = repeated && wanted.length > 1 ? wanted[0] : wanted;
          const start = repeated ? index + 1 : index;
          const ordered = [...focusable.slice(start), ...focusable.slice(0, start)];
          const found = ordered.find((other) => other.node.label.toLocaleLowerCase("fr").startsWith(search));
          if (found) moveTo(found.node.id);
          break;
        }
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onRowClick = (event: MouseEvent, row: Extract<FlatRow<Data>, { kind: "node" }>) => {
    if (row.node.disabled) return;
    setActiveId(row.node.id);
    if (selection === "multiple" && event.shiftKey) select(row.node.id, "range");
    else if (selection === "multiple" && (event.ctrlKey || event.metaKey)) select(row.node.id, "toggle");
    else select(row.node.id, "replace");
  };

  if (nodes.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} size="compact" />;
  }

  const visible = rows.slice(first, last);

  return (
    <div
      className={`al-tree${fill ? " al-tree--fill" : ""}${virtual ? " al-tree--virtual" : ""}`}
      ref={scroller}
      onScroll={
        virtual
          ? (event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
          : undefined
      }
    >
      <div
        role="tree"
        aria-label={label}
        aria-multiselectable={selection === "multiple" || undefined}
        className="al-tree__list"
        onKeyDown={onKeyDown}
        style={virtual ? { height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT } : undefined}
      >
        {visible.map((row) => {
          if (row.kind !== "node") {
            const indent = { paddingInlineStart: `calc(${row.level - 1} * var(--tree-indent) + 28px)` };
            if (row.kind === "loading")
              return (
                <div key={`loading:${row.id}`} className="al-tree__status" role="none" style={indent}>
                  <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
                  <span>Chargement…</span>
                </div>
              );
            const node = nodeRows.find((candidate) => candidate.node.id === row.id)?.node;
            return (
              <div
                key={`error:${row.id}`}
                className="al-tree__status al-tree__status--error"
                role="none"
                style={indent}
              >
                <span id={`${errorPrefix}-${row.id}`}>{row.message}</span>
                {node ? (
                  <button type="button" tabIndex={-1} className="al-tree__retry" onClick={() => retry(node)}>
                    Réessayer
                  </button>
                ) : null}
              </div>
            );
          }
          const { node } = row;
          const Icon = row.expanded && node.openIcon ? node.openIcon : node.icon;
          const isSelected = selectedIds.has(node.id);
          const isActive = node.id === currentId;
          const state = loads.get(node.id);
          const nodeActions = actions?.(node) ?? [];
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: le clavier de tous les nœuds est traité par l’arbre (onKeyDown du rôle tree).
            <div
              key={node.id}
              role="treeitem"
              data-tree-id={node.id}
              className="al-tree__item"
              aria-level={row.level}
              aria-setsize={row.size}
              aria-posinset={row.position}
              aria-expanded={row.expandable ? row.expanded : undefined}
              aria-selected={selection === "none" ? undefined : isSelected}
              aria-disabled={node.disabled || undefined}
              aria-busy={state?.status === "loading" || undefined}
              aria-describedby={state?.status === "error" ? `${errorPrefix}-${node.id}` : undefined}
              tabIndex={isActive ? 0 : -1}
              style={{ paddingInlineStart: `calc(${row.level - 1} * var(--tree-indent) + 4px)` }}
              onClick={(event) => onRowClick(event, row)}
              onDoubleClick={() => {
                if (node.disabled) return;
                if (onActivate) onActivate(node);
                else if (row.expandable) {
                  if (row.expanded) setOpen([node.id], false);
                  else expand(row);
                }
              }}
              onFocus={(event) => {
                if (event.target === event.currentTarget && activeId !== node.id) setActiveId(node.id);
              }}
            >
              <span
                className="al-tree__toggle"
                aria-hidden="true"
                onClick={(event) => {
                  if (!row.expandable || node.disabled) return;
                  event.stopPropagation();
                  setActiveId(node.id);
                  if (row.expanded) setOpen([node.id], false);
                  else expand(row);
                }}
              >
                {row.expandable ? <ChevronRight size={14} className={row.expanded ? "is-open" : undefined} /> : null}
              </span>
              {Icon ? (
                <span className="al-tree__icon">
                  <Icon size={16} aria-hidden="true" />
                </span>
              ) : null}
              <span className="al-tree__label">{node.label}</span>
              {node.meta ? <span className="al-tree__meta">{node.meta}</span> : null}
              {nodeActions.length ? (
                <span className="al-tree__actions">
                  {nodeActions.map((action) => {
                    const ActionIconComponent = action.icon;
                    return (
                      <IconButton
                        key={action.label}
                        label={action.label}
                        appearance="table"
                        size="small"
                        tone={action.danger ? "danger" : "default"}
                        tabIndex={isActive ? 0 : -1}
                        onClick={(event) => {
                          event.stopPropagation();
                          void run(action);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <ActionIconComponent size={16} aria-hidden="true" />
                      </IconButton>
                    );
                  })}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
