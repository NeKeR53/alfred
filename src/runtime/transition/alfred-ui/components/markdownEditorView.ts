/**
 * Partie CodeMirror 6 de `MarkdownEditor`, chargée à la première demande (comme pdf.js pour `DocumentViewer`) : une
 * page qui n’édite pas de Markdown ne la télécharge pas. Commandes de mise en forme, raccourcis, collage d’images.
 */
import { defaultKeymap, history, historyKeymap, undoDepth } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export type MarkdownCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "quote";

export interface PastedImage {
  src: string;
  alt?: string;
}

export interface EditorCallbacks {
  onChange: (value: string, depth: number) => void;
  onSave?: () => void;
  onPasteImage?: (file: File) => Promise<string | PastedImage>;
  onImageError?: (error: unknown, file: File) => void;
}

/** Entoure la sélection de `marker` (gras, italique, code), ou l’en retire si elle l’est déjà. */
function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const size = marker.length;
  view.dispatch(
    state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - size, range.from);
      const after = state.sliceDoc(range.to, range.to + size);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= 2 * size && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(size, -size) },
          range: EditorSelection.range(range.from, range.to - 2 * size),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

/** `[texte](adresse)` : l’adresse est sélectionnée pour être tapée ; une adresse sélectionnée devient la cible. */
function insertLink(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (/^(https?:\/\/|mailto:)\S+$/.test(text)) {
        return {
          changes: { from: range.from, to: range.to, insert: `[](${text})` },
          range: EditorSelection.cursor(range.from + 1),
        };
      }
      const label = text || "texte";
      const insert = `[${label}](adresse)`;
      const urlStart = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text
          ? EditorSelection.range(urlStart, urlStart + 7)
          : EditorSelection.range(range.from + 1, range.from + 6),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

const headingPrefix = /^#{1,6}\s+/;
const listPrefix = /^(\s*)([-*+]|\d+[.)])\s+/;

/** Pose ou retire un préfixe sur chaque ligne de la sélection : titre, liste à puces ou numérotée, citation. */
function toggleLines(view: EditorView, kind: "heading" | "bullet" | "ordered" | "quote", level = 1): boolean {
  const { state } = view;
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    for (let at = state.doc.lineAt(range.from).number; at <= state.doc.lineAt(range.to).number; at++) {
      const line = state.doc.line(at);
      lines.set(at, { from: line.from, text: line.text });
    }
  }
  const all = [...lines.values()];
  const wanted = "#".repeat(level);
  const has = (text: string) =>
    kind === "heading"
      ? new RegExp(`^${wanted}\\s`).test(text)
      : kind === "quote"
        ? /^>\s?/.test(text)
        : kind === "bullet"
          ? /^\s*[-*+]\s/.test(text)
          : /^\s*\d+[.)]\s/.test(text);
  const remove = all.every((line) => has(line.text));
  const changes = all.map((line, index) => {
    const current =
      kind === "heading"
        ? headingPrefix.exec(line.text)
        : kind === "quote"
          ? /^>\s?/.exec(line.text)
          : listPrefix.exec(line.text);
    const end = current ? current[0].length : 0;
    // Une liste garde l’indentation de la ligne ; un titre remplace un titre d’un autre niveau.
    const indent = kind === "bullet" || kind === "ordered" ? (current?.[1] ?? /^\s*/.exec(line.text)?.[0] ?? "") : "";
    if (remove) return { from: line.from, to: line.from + end, insert: indent };
    const prefix =
      kind === "heading" ? `${wanted} ` : kind === "quote" ? "> " : kind === "bullet" ? "- " : `${index + 1}. `;
    // Une citation s’ajoute devant la ligne ; un titre ou une liste remplace le préfixe déjà là.
    const replaced = kind === "quote" ? 0 : kind === "heading" ? end : end || indent.length;
    return { from: line.from, to: line.from + replaced, insert: `${indent}${prefix}` };
  });
  view.dispatch(state.update({ changes, userEvent: "input.format", scrollIntoView: true }));
  return true;
}

export function runCommand(view: EditorView, command: MarkdownCommand): boolean {
  switch (command) {
    case "bold":
      return toggleWrap(view, "**");
    case "italic":
      return toggleWrap(view, "_");
    case "code":
      return toggleWrap(view, "`");
    case "link":
      return insertLink(view);
    case "heading1":
      return toggleLines(view, "heading", 1);
    case "heading2":
      return toggleLines(view, "heading", 2);
    case "heading3":
      return toggleLines(view, "heading", 3);
    case "bulletList":
      return toggleLines(view, "bullet");
    case "orderedList":
      return toggleLines(view, "ordered");
    case "quote":
      return toggleLines(view, "quote");
  }
}

/** Raccourcis de mise en forme ; `Mod` vaut Ctrl sous Windows et Cmd sur Mac. */
export const formatKeys: { key: string; command: MarkdownCommand }[] = [
  { key: "Mod-b", command: "bold" },
  { key: "Mod-i", command: "italic" },
  { key: "Mod-e", command: "code" },
  { key: "Mod-k", command: "link" },
  { key: "Mod-Alt-1", command: "heading1" },
  { key: "Mod-Alt-2", command: "heading2" },
  { key: "Mod-Alt-3", command: "heading3" },
  { key: "Mod-Shift-8", command: "bulletList" },
  { key: "Mod-Shift-7", command: "orderedList" },
  { key: "Mod-Shift-9", command: "quote" },
];

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.15em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.08em" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--color-primary-strong)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote, tags.meta], color: "var(--color-muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--color-ink)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--color-primary) 22%, var(--color-bg))",
  },
  ".cm-placeholder": { color: "var(--color-muted)" },
});

let uploads = 0;

/** Colle ou dépose des images : un texte d’attente, remplacé par `![alt](src)` quand le module a rangé l’image. */
function imageHandler(callbacks: () => EditorCallbacks): Extension {
  const insertImages = (view: EditorView, files: File[], at: number) => {
    const { onPasteImage, onImageError } = callbacks();
    if (!onPasteImage) return false;
    let position = at;
    for (const file of files) {
      const token = `![Envoi de ${file.name || "l’image"}…](alfred-image-${++uploads})`;
      const text = `${token}\n`;
      view.dispatch({
        changes: { from: position, insert: text },
        selection: EditorSelection.cursor(position + text.length),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      position += text.length;
      const replace = (insert: string) => {
        const from = view.state.doc.toString().indexOf(token);
        if (from === -1) return;
        view.dispatch({
          changes: { from, to: from + token.length + (insert ? 0 : 1), insert },
          userEvent: "input.paste",
        });
      };
      onPasteImage(file).then(
        (result) => {
          const image = typeof result === "string" ? { src: result } : result;
          const alt = (image.alt ?? file.name.replace(/\.[^.]+$/, "")).replace(/[[\]]/g, "");
          replace(`![${alt}](${image.src.replace(/[()\s]/g, encodeURIComponent)})`);
        },
        (error: unknown) => {
          replace("");
          onImageError?.(error, file);
        },
      );
    }
    return true;
  };
  const images = (list: FileList | undefined | null) =>
    Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = images(event.clipboardData?.files);
      if (!files.length || !callbacks().onPasteImage) return false;
      event.preventDefault();
      const range = view.state.selection.main;
      if (!range.empty) view.dispatch({ changes: { from: range.from, to: range.to }, userEvent: "delete" });
      return insertImages(view, files, view.state.selection.main.from);
    },
    drop(event, view) {
      const files = images(event.dataTransfer?.files);
      if (!files.length || !callbacks().onPasteImage) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      return insertImages(view, files, at);
    },
  });
}

export interface EditorSettings {
  label: string;
  placeholder?: string;
  readOnly: boolean;
}

/** Réglages qui changent sans toucher au texte ni à l’historique. */
const settings = new Compartment();
function settingsExtension(options: EditorSettings): Extension {
  return [
    EditorState.readOnly.of(options.readOnly),
    EditorView.editable.of(!options.readOnly),
    EditorView.contentAttributes.of({ "aria-label": options.label }),
    options.placeholder ? placeholderText(options.placeholder) : [],
  ];
}

export function updateSettings(view: EditorView, options: EditorSettings) {
  view.dispatch({ effects: settings.reconfigure(settingsExtension(options)) });
}

export function createState(doc: string, options: EditorSettings, callbacks: () => EditorCallbacks): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      markdown(),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      theme,
      settings.of(settingsExtension(options)),
      imageHandler(callbacks),
      Prec.high(
        keymap.of([
          ...formatKeys.map(({ key, command }) => ({ key, run: (view: EditorView) => runCommand(view, command) })),
          {
            key: "Mod-s",
            run: () => {
              const { onSave } = callbacks();
              if (!onSave) return false;
              onSave();
              return true;
            },
          },
        ]),
      ),
      keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callbacks().onChange(update.state.doc.toString(), undoDepth(update.state));
      }),
    ],
  });
}

export function createEditor(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ state, parent });
}

export { undoDepth };
