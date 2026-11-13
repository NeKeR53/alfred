/**
 * Suggestions de la saisie, reprises du `ReferenceComposer` de OneApp : la liste s’ouvre au-dessus du champ dès qu’un
 * mot commence par `/` (commandes et skills du harnais) ou `@` (fichiers du dossier de travail). Flèches pour
 * choisir, Entrée ou Tab pour insérer, Échap pour fermer. Le focus reste dans le champ.
 */

import { BookMarked, File, Folder, Terminal } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ListboxOption } from "../../ui/components/ChoiceButton";
import type { Provider } from "./harness";
import {
  type ComposerReference,
  insertReference,
  keptReferences,
  loadComposerReferences,
  referenceQuery,
} from "./lib/composerReferences";

function iconOf(item: ComposerReference) {
  if (item.kind === "skill") return <BookMarked size={14} aria-hidden="true" />;
  if (item.kind === "command") return <Terminal size={14} aria-hidden="true" />;
  return item.name.endsWith("/") ? <Folder size={14} aria-hidden="true" /> : <File size={14} aria-hidden="true" />;
}

function detailOf(item: ComposerReference) {
  if (item.kind === "file") return item.name.replace(/\/$/, "").split("/").slice(0, -1).join("/") || ".";
  const kind = item.kind === "skill" ? "Skill" : "Commande";
  return item.description ? `${kind} · ${item.description}` : kind;
}

function displayName(item: ComposerReference) {
  return item.kind === "file" ? item.name.replace(/\/$/, "").split("/").at(-1) || item.name : item.name;
}

/**
 * État des références d’une saisie : le mot en cours, les suggestions, celles déjà choisies. `track` suit le
 * curseur, `onKeyDown` répond avant la saisie (renvoie vrai quand il a traité la touche), `take` rend les
 * références encore mentionnées au moment d’envoyer.
 */
export function useComposerReferences({
  field,
  text,
  setText,
  cwd,
  provider,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  cwd: string;
  provider: Provider;
}) {
  const id = useId();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [items, setItems] = useState<ComposerReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const query = dismissed || !cwd ? undefined : referenceQuery(text, cursor);
  const kind = query?.kind;
  const search = query?.query;

  useEffect(() => {
    if (!kind || search === undefined) return;
    let stopped = false;
    setLoading(true);
    setFailed(null);
    // Les fichiers se cherchent sur le disque : on attend une courte pause de frappe.
    const timer = window.setTimeout(
      () => {
        loadComposerReferences(cwd, provider, kind, search)
          .then((found) => {
            if (stopped) return;
            setItems(found);
            setActive(0);
          })
          .catch((error: unknown) => {
            if (!stopped) setFailed(error instanceof Error ? error.message : String(error));
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

  const visible = query !== undefined;

  const track = () => {
    const input = field.current;
    if (!input) return;
    setCursor(input.selectionStart ?? input.value.length);
    setDismissed(false);
  };

  const choose = (item: ComposerReference) => {
    if (!query) return;
    const next = insertReference(text, query, item);
    setText(next.text);
    setReferences((current) => [...current, item]);
    setDismissed(true);
    requestAnimationFrame(() => {
      const input = field.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!visible || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return true;
    }
    const current = items[active];
    if ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey)) {
      if (loading || !current) {
        // Sans suggestion, Tab quitte le champ et Entrée envoie le message, comme d’habitude.
        if (event.key === "Tab") setDismissed(true);
        return false;
      }
      event.preventDefault();
      choose(current);
      return true;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    return false;
  };

  return {
    track,
    onKeyDown,
    dismiss: () => setDismissed(true),
    /** Références à joindre au message : celles dont la mention est encore dans `text`. Vide la liste. */
    take(sent: string) {
      const kept = keptReferences(sent, references);
      setReferences([]);
      setDismissed(true);
      return kept;
    },
    reset() {
      setReferences([]);
      setDismissed(true);
    },
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": visible ? id : undefined,
      "aria-expanded": visible,
      "aria-activedescendant": visible && !loading && items[active] ? `${id}-${active}` : undefined,
    },
    popover: visible ? (
      <SuggestionList
        id={id}
        anchor={field}
        kind={query.kind}
        items={items}
        active={active}
        loading={loading}
        failed={failed}
        onHover={setActive}
        onChoose={choose}
      />
    ) : null,
  };
}

function SuggestionList({
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
  anchor: RefObject<HTMLTextAreaElement | null>;
  kind: "file" | "command";
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
      const rect = anchor.current?.closest(".agent-composer__box")?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), 560, window.innerWidth - 16);
      setPosition({
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - rect.top + 6,
        width,
        maxHeight: Math.min(260, Math.max(64, rect.top - 14)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);

  const empty = kind === "file" ? "Aucun fichier trouvé." : "Aucune commande ni aucun skill pour ce harnais.";
  return createPortal(
    <div className="reference-composer" style={position} ref={list}>
      <div
        id={id}
        role="listbox"
        aria-label={kind === "file" ? "Fichiers du dossier de travail" : "Commandes et skills"}
        aria-busy={loading}
      >
        {loading || failed || !items.length ? (
          <ListboxOption selected={false} disabled className="reference-composer__status">
            {loading ? "Recherche…" : failed ? `Recherche indisponible : ${failed}` : empty}
          </ListboxOption>
        ) : (
          items.map((item, index) => (
            <ListboxOption
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
              <span className="reference-composer__name">{displayName(item)}</span>
              <small>{detailOf(item)}</small>
            </ListboxOption>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
