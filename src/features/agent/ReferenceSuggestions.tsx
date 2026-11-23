/**
 * Suggestions de la saisie, reprises du `ReferenceComposer` de OneApp : la liste s’ouvre au-dessus du champ dès qu’un
 * mot commence par `/` (commandes et skills du harnais), `$` (skills) ou `@` (fichiers du dossier de travail).
 * Flèches pour choisir, Entrée ou Tab pour insérer, Échap pour fermer. Le focus reste dans le champ.
 */

import { BookMarked, File, Folder, Terminal } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { notify } from "../../shell/notifications";
import type { Provider } from "./harness";
import {
  type ComposerReference,
  loadComposerReferences,
  type ReferenceKind,
  referenceDisplayName,
} from "./lib/composerReferences";

function iconOf(item: ComposerReference) {
  if (item.kind === "skill") return <BookMarked size={14} aria-hidden="true" />;
  if (item.kind === "command") return <Terminal size={14} aria-hidden="true" />;
  return item.name.endsWith("/") ? <Folder size={14} aria-hidden="true" /> : <File size={14} aria-hidden="true" />;
}

/** Détail à droite de la suggestion, comme dans OneApp : le dossier du fichier, sinon « Skill » ou « Commande ». */
function detailOf(item: ComposerReference) {
  if (item.kind === "file") return item.name.replace(/\/$/, "").split(/[\\/]/).slice(0, -1).join("/") || ".";
  return item.kind === "skill" ? "Skill" : "Commande";
}

/**
 * Catalogue de la recherche en cours : les fichiers se cherchent sur le disque après une courte pause de frappe,
 * les commandes et les skills se filtrent dans un catalogue gardé 30 s.
 */
export function useReferenceCatalog(
  kind: ReferenceKind | undefined,
  search: string | undefined,
  cwd: string,
  provider: Provider,
) {
  const [items, setItems] = useState<ComposerReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!kind || search === undefined || !cwd) return;
    let stopped = false;
    setLoading(true);
    setFailed(null);
    const timer = window.setTimeout(
      () => {
        loadComposerReferences(cwd, provider, kind, search)
          .then((found) => {
            if (!stopped) setItems(found);
          })
          .catch((error: unknown) => {
            if (stopped) return;
            const message = error instanceof Error ? error.message : String(error);
            setFailed(message);
            // Comme dans OneApp, la cause de l’échec part en notification ; la liste dit seulement de réessayer.
            notify({ title: "Recherche de ressources", description: message, tone: "error" });
          })
          .finally(() => {
            if (!stopped) setLoading(false);
          });
      },
      kind === "file" ? 150 : 0,
    );
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [kind, search, cwd, provider]);

  return { items, loading, failed };
}

const LIST_LABEL: Record<ReferenceKind, string> = {
  file: "Fichiers du dossier de travail",
  command: "Commandes et skills",
  skill: "Skills",
};

export function SuggestionList({
  id,
  anchor,
  kind,
  items,
  active,
  loading,
  failed,
  onHover,
  onChoose,
}: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  kind: ReferenceKind;
  items: ComposerReference[];
  active: number;
  loading: boolean;
  failed: string | null;
  onHover: (index: number) => void;
  onChoose: (item: ComposerReference) => void;
}) {
  const [position, setPosition] = useState<CSSProperties>();
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const place = () => {
      // Comme dans OneApp, la liste s’aligne sur le champ lui-même, au-dessus de lui.
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), 560, window.innerWidth - 16);
      setPosition({
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - rect.top + 6,
        width,
        maxHeight: Math.min(224, Math.max(64, rect.top - 14)),
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (anchor.current) observer?.observe(anchor.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);

  return createPortal(
    <div className="reference-composer" style={position} ref={list}>
      <div id={id} role="listbox" aria-label={LIST_LABEL[kind]} aria-busy={loading}>
        {loading || failed || !items.length ? (
          <ReferenceOption selected={false} disabled className="reference-composer__status">
            {loading ? "Recherche…" : failed ? "Recherche indisponible. Fermez puis réessayez." : "Aucun résultat."}
          </ReferenceOption>
        ) : (
          items.map((item, index) => (
            <ReferenceOption
              key={`${item.kind}:${item.path}`}
              id={`${id}-${index}`}
              selected={active === index}
              className="reference-composer__option"
              onMouseDown={(event) => {
                // Le champ garde le focus : le clic choisit sans fermer la saisie.
                event.preventDefault();
                onChoose(item);
              }}
              onMouseEnter={() => onHover(index)}
            >
              {iconOf(item)}
              <span className="reference-composer__name">{referenceDisplayName(item)}</span>
              <small>{detailOf(item)}</small>
            </ReferenceOption>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Option de la liste des suggestions : le champ garde le focus, l’option active est portée par `aria-selected`. */
function ReferenceOption({
  selected,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <button {...props} type="button" role="option" tabIndex={-1} aria-selected={selected} className={className}>
      {children}
    </button>
  );
}
