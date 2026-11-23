import {
  Bold,
  Code as CodeIcon,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  type LucideIcon,
  TextQuote,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "./Button";
import { Markdown } from "./Markdown";
import type { EditorCallbacks, MarkdownCommand, PastedImage } from "./markdownEditorView";
import { Tabs } from "./Tabs";

type EditorModule = typeof import("./markdownEditorView");
type EditorView = import("@codemirror/view").EditorView;

/** Une seule demande pour toutes les instances : la partie CodeMirror arrive à la première ouverture. */
let editorModule: Promise<EditorModule> | undefined;
const loadEditor = () => {
  editorModule ??= import("./markdownEditorView");
  return editorModule;
};

export type MarkdownEditorLayout = "split" | "tabs" | "preview";

export interface MarkdownEditorProps {
  /** Nom du champ d’édition pour les lecteurs d’écran (« Contenu de la note »). */
  label: string;
  /** Texte édité. Un autre texte venu de la page (un autre fichier ouvert) repart d’un historique vide. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Dernier texte enregistré ; à donner après chaque enregistrement. Sans lui, le texte reçu à l’ouverture. Les
   * modifications faites depuis sont comptées et affichées.
   */
  savedValue?: string;
  /** Nombre de modifications non enregistrées, à chaque changement (pour activer « Enregistrer »). */
  onUnsavedChange?: (count: number) => void;
  /** Ctrl+S (Cmd+S sur Mac) dans l’éditeur. */
  onSave?: () => void;
  /**
   * Image collée ou déposée : le module la range (`files.write`…) et rend son adresse (`data:`, `blob:` ou un chemin
   * que `renderImage` sait afficher). Sans ce callback, coller une image ne fait rien.
   */
  onPasteImage?: (file: File) => Promise<string | PastedImage>;
  /** Échec de `onPasteImage` ; sans lui, l’éditeur affiche « Image non ajoutée ». */
  onPasteImageError?: (error: unknown, file: File) => void;
  /** `split` : éditeur et aperçu côte à côte (défaut) ; `tabs` : onglets Écrire / Aperçu ; `preview` : aperçu seul. */
  layout?: MarkdownEditorLayout;
  placeholder?: string;
  readOnly?: boolean;
  /** Liens de l’aperçu, comme pour `Markdown`. */
  onLink?: (href: string) => void;
  /** Images de l’aperçu, comme pour `Markdown`. */
  renderImage?: (src: string, alt: string) => ReactNode;
  /** Occupe la hauteur restante d’une `Page fill`. */
  fill?: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function shortcut(key: string): string {
  const parts = key.split("-");
  const names = parts.map((part) =>
    part === "Mod"
      ? isMac
        ? "⌘"
        : "Ctrl"
      : part === "Alt"
        ? isMac
          ? "⌥"
          : "Alt"
        : part === "Shift"
          ? isMac
            ? "⇧"
            : "Maj"
          : part.toUpperCase(),
  );
  return isMac ? names.join("") : names.join("+");
}

const tools: { command: MarkdownCommand; label: string; icon: LucideIcon; key: string }[] = [
  { command: "heading1", label: "Titre 1", icon: Heading1, key: "Mod-Alt-1" },
  { command: "heading2", label: "Titre 2", icon: Heading2, key: "Mod-Alt-2" },
  { command: "heading3", label: "Titre 3", icon: Heading3, key: "Mod-Alt-3" },
  { command: "bold", label: "Gras", icon: Bold, key: "Mod-b" },
  { command: "italic", label: "Italique", icon: Italic, key: "Mod-i" },
  { command: "code", label: "Code", icon: CodeIcon, key: "Mod-e" },
  { command: "link", label: "Lien", icon: LinkIcon, key: "Mod-k" },
  { command: "bulletList", label: "Liste à puces", icon: List, key: "Mod-Shift-8" },
  { command: "orderedList", label: "Liste numérotée", icon: ListOrdered, key: "Mod-Shift-7" },
  { command: "quote", label: "Citation", icon: TextQuote, key: "Mod-Shift-9" },
];
/** Séparateurs de la barre : après les titres et après les styles de texte. */
const groupEnds = new Set<MarkdownCommand>(["heading3", "link"]);

function unsavedText(count: number): string {
  return count === 1 ? "1 modification non enregistrée" : `${count} modifications non enregistrées`;
}

/**
 * Éditeur Markdown (CodeMirror 6, chargé à la première ouverture) avec l’aperçu de `Markdown` : côte à côte, en
 * onglets ou seul. Barre de mise en forme et raccourcis (gras, italique, code, lien, titres, listes, citation),
 * Entrée qui continue une liste, annulation (Ctrl+Z, Ctrl+Maj+Z ou Ctrl+Y), images collées ou déposées confiées au
 * module, et compte des modifications non enregistrées.
 */
export function MarkdownEditor({
  label,
  value,
  onChange,
  savedValue,
  onUnsavedChange,
  onSave,
  onPasteImage,
  onPasteImageError,
  layout = "split",
  placeholder,
  readOnly = false,
  onLink,
  renderImage,
  fill = false,
}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const module = useRef<EditorModule | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [doc, setDoc] = useState(value);
  const [depth, setDepth] = useState(0);
  const [imageError, setImageError] = useState("");
  // Profondeur d’annulation et texte au dernier enregistrement : l’écart compte les modifications.
  const [saved, setSaved] = useState({ text: savedValue ?? value, depth: 0 });
  const panelId = useId();
  const tabsId = useId();

  // Les callbacks changent à chaque rendu : l’éditeur lit toujours les derniers.
  const latest = useRef<EditorCallbacks>({ onChange: () => undefined });
  latest.current = {
    onChange: (text, nextDepth) => {
      setDoc(text);
      setImageError("");
      setDepth(nextDepth);
      onChange(text);
    },
    onSave,
    onPasteImage,
    onImageError: (error, file) => {
      if (onPasteImageError) onPasteImageError(error, file);
      else setImageError(`Image non ajoutée : ${file.name || "image"}`);
    },
  };

  const options = useRef({ label, placeholder, readOnly });
  options.current = { label, placeholder, readOnly };
  const initial = useRef(value);
  initial.current = value;

  useEffect(() => {
    let cancelled = false;
    void loadEditor().then((loaded) => {
      if (cancelled || !host.current) return;
      module.current = loaded;
      view.current = loaded.createEditor(
        host.current,
        loaded.createState(initial.current, options.current, () => latest.current),
      );
      setReady(true);
    });
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = undefined;
    };
    // L’éditeur se crée une fois ; les changements de `value` passent par l’effet suivant.
  }, []);

  // Un texte venu de la page qui n’est pas celui de l’éditeur (autre fichier, rechargement) : nouvel historique.
  useLayoutEffect(() => {
    const current = view.current;
    const loaded = module.current;
    if (!current || !loaded || current.state.doc.toString() === value) return;
    current.setState(loaded.createState(value, options.current, () => latest.current));
    setDoc(value);
    setDepth(0);
    setSaved({ text: savedValue ?? value, depth: 0 });
  }, [value, savedValue]);

  // Le libellé, le texte d’attente ou la lecture seule changent : même texte, même historique, réglages à jour.
  useEffect(() => {
    if (view.current && module.current) module.current.updateSettings(view.current, { label, placeholder, readOnly });
  }, [label, placeholder, readOnly]);

  // Enregistrement signalé par la page : le texte qu’elle a enregistré devient la référence.
  useEffect(() => {
    if (savedValue === undefined) return;
    setSaved({
      text: savedValue,
      depth: view.current && module.current ? module.current.undoDepth(view.current.state) : 0,
    });
  }, [savedValue]);

  const unsaved = doc === saved.text ? 0 : Math.max(1, Math.abs(depth - saved.depth));
  const reported = useRef(0);
  useEffect(() => {
    if (reported.current === unsaved) return;
    reported.current = unsaved;
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);

  const preview = useDeferredValue(doc);
  const run = (command: MarkdownCommand) => {
    const current = view.current;
    if (!current || !module.current) return;
    module.current.runCommand(current, command);
    current.focus();
  };

  const showEditor = layout === "split" || (layout === "tabs" && tab === "write");
  const showPreview = layout === "preview" || layout === "split" || (layout === "tabs" && tab === "preview");
  const classes = ["ui-markdown-editor", `ui-markdown-editor--${layout}`, fill ? "ui-markdown-editor--fill" : ""]
    .filter(Boolean)
    .join(" ");

  // Même place dans l’arbre quelle que soit la disposition : l’éditeur n’est jamais recréé.
  const content = (
    <>
      {/* L’éditeur reste monté quand il est masqué : son historique d’annulation est gardé. */}
      <div className="ui-markdown-editor__editor" ref={host} hidden={!showEditor} />
      {showPreview ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: l’aperçu défile au clavier.
        <section className="ui-markdown-editor__preview" aria-label="Aperçu" tabIndex={0}>
          {preview.trim() ? (
            <Markdown onLink={onLink} renderImage={renderImage}>
              {preview}
            </Markdown>
          ) : (
            <p className="ui-markdown-editor__empty">Rien à afficher</p>
          )}
        </section>
      ) : null}
    </>
  );

  return (
    <div className={classes}>
      <div className="ui-markdown-editor__bar">
        {layout === "tabs" ? (
          <Tabs
            label="Affichage"
            items={[
              { id: "write", label: "Écrire" },
              { id: "preview", label: "Aperçu" },
            ]}
            activeId={tab}
            onChange={setTab}
            idPrefix={tabsId}
            panelId={panelId}
          />
        ) : null}
        {showEditor && !readOnly ? (
          <div className="ui-markdown-editor__tools" role="toolbar" aria-label="Mise en forme">
            {tools.map((tool) => (
              <span key={tool.command} className="ui-markdown-editor__tool">
                <IconButton
                  label={`${tool.label} (${shortcut(tool.key)})`}
                  size="compact"
                  disabled={!ready}
                  // Le clic ne prend pas le focus de l’éditeur : la sélection reste celle sur laquelle agir.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(tool.command)}
                >
                  <tool.icon size={16} aria-hidden="true" />
                </IconButton>
                {groupEnds.has(tool.command) ? (
                  <span className="ui-markdown-editor__separator" aria-hidden="true" />
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        <span className="ui-markdown-editor__status" role="status">
          {imageError || (unsaved ? unsavedText(unsaved) : "")}
        </span>
      </div>
      {layout === "tabs" ? (
        <div className="ui-markdown-editor__body" id={panelId} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {content}
        </div>
      ) : (
        <div className="ui-markdown-editor__body">{content}</div>
      )}
    </div>
  );
}
