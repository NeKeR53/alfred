/**
 * Champ de saisie enrichi, repris du `ReferenceComposer` de OneApp : un élément éditable où chaque référence choisie
 * (`/`, `$`, `@`) devient une pastille non éditable, avec « × », posée exactement à la position du curseur. Le texte
 * et les pastilles sont relus du DOM à chaque frappe ; l’état reçu redessine le champ seulement s’il en diffère.
 */
import {
  type ClipboardEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Provider } from "./harness";
import {
  type ComposerReference,
  type ComposerReferenceMention,
  referenceDisplayName,
  referenceQuery,
  removeReferenceQuery,
  replaceComposerRange,
} from "./lib/composerReferences";
import { SuggestionList, useReferenceCatalog } from "./ReferenceSuggestions";

type EditorState = { text: string; references: ComposerReferenceMention[] };

function readEditor(root: Node, known: ReadonlyMap<string, ComposerReferenceMention>): EditorState {
  let text = "";
  const references: ComposerReferenceMention[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) {
      node.childNodes.forEach(visit);
      return;
    }
    const id = node.dataset.referenceId;
    if (id) {
      const reference = known.get(id);
      if (reference) references.push({ ...reference, offset: text.length });
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    const block = node.tagName === "DIV" || node.tagName === "P";
    if (block && text && !text.endsWith("\n")) text += "\n";
    node.childNodes.forEach(visit);
    if (block && node.nextSibling && !text.endsWith("\n")) text += "\n";
  };
  root.childNodes.forEach(visit);
  return { text: text.replace(/\n$/, ""), references };
}

function stateSignature(text: string, references: readonly ComposerReferenceMention[]) {
  return JSON.stringify([text, references.map(({ id, offset, kind, name, path }) => [id, offset, kind, name, path])]);
}

function appendText(root: HTMLElement, text: string) {
  text.split("\n").forEach((part, index) => {
    if (index) root.append(document.createElement("br"));
    if (part) root.append(document.createTextNode(part));
  });
}

function renderEditor(root: HTMLDivElement, text: string, references: readonly ComposerReferenceMention[]) {
  root.replaceChildren();
  const ordered = references
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => left.reference.offset - right.reference.offset || left.index - right.index);
  let cursor = 0;
  for (const { reference } of ordered) {
    const offset = Math.max(cursor, Math.min(text.length, reference.offset));
    appendText(root, text.slice(cursor, offset));
    const pill = document.createElement("span");
    pill.className = "reference-pill reference-pill--editable";
    // Attribut plutôt que propriété : le même rendu partout, y compris hors d’un vrai navigateur.
    pill.setAttribute("contenteditable", "false");
    pill.dataset.referenceId = reference.id;
    pill.append(document.createTextNode(referenceDisplayName(reference)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.referenceRemove = reference.id;
    remove.setAttribute("aria-label", `Retirer ${referenceDisplayName(reference)}`);
    remove.textContent = "×";
    pill.append(remove);
    root.append(pill);
    cursor = offset;
  }
  appendText(root, text.slice(cursor));
}

function textOffset(root: HTMLDivElement, container: Node, offset: number): number {
  try {
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(container, offset);
    return readEditor(range.cloneContents(), new Map()).text.length;
  } catch {
    return root.textContent?.length ?? 0;
  }
}

/** Sélection du champ, en positions dans le texte sans pastilles ; à défaut, la fin du texte. */
export function composerSelectionRange(root: HTMLDivElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (
    !selection?.rangeCount ||
    !selection.anchorNode ||
    !root.contains(selection.anchorNode) ||
    !selection.focusNode ||
    !root.contains(selection.focusNode)
  ) {
    const end = readEditor(root, new Map()).text.length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function pointAtOffset(root: HTMLDivElement, target: number): { node: Node; offset: number } {
  let cursor = 0;
  for (let index = 0; index < root.childNodes.length; index++) {
    const node = root.childNodes[index];
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (target <= cursor + length) return { node, offset: Math.max(0, target - cursor) };
      cursor += length;
    } else if (node instanceof HTMLBRElement) {
      if (target <= cursor) return { node: root, offset: index };
      cursor += 1;
      if (target <= cursor) return { node: root, offset: index + 1 };
    }
  }
  return { node: root, offset: root.childNodes.length };
}

/** Place le curseur (ou la sélection) à une position du texte sans pastilles. */
export function setComposerSelection(root: HTMLDivElement, start: number, end = start) {
  const selection = window.getSelection();
  if (!selection) return;
  const from = pointAtOffset(root, start);
  const to = pointAtOffset(root, end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

type Props = Omit<HTMLAttributes<HTMLDivElement>, "contentEditable" | "onChange" | "onInput" | "onPaste"> & {
  ref?: Ref<HTMLDivElement>;
  value: string;
  onValueChange: (value: string) => void;
  references: readonly ComposerReferenceMention[];
  onReferencesChange: (references: ComposerReferenceMention[]) => void;
  /** Sans dossier de travail, aucune suggestion n’est proposée. */
  cwd: string;
  provider: Provider;
  placeholder?: string;
  disabled?: boolean;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
};

/** Éditeur multiligne enrichi : les références restent à la position exacte du curseur. */
export function ComposerEditor({
  ref,
  value,
  onValueChange,
  references,
  onReferencesChange,
  cwd,
  provider,
  placeholder,
  disabled,
  className,
  onBlur,
  onFocus,
  onKeyDown,
  onKeyUp,
  onPointerUp,
  onPaste,
  ...props
}: Props) {
  const input = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => {
    if (!input.current) throw new Error("Éditeur indisponible");
    return input.current;
  }, []);
  const known = useRef(new Map<string, ComposerReferenceMention>());
  const pendingReference = useRef<string | undefined>(undefined);
  const pendingOffset = useRef<number | undefined>(undefined);
  const id = useId();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const [active, setActive] = useState(0);
  const query = cwd && !disabled && !dismissed ? referenceQuery(value, cursor) : undefined;
  const kind = query?.kind;
  const search = query?.query;
  const visible = Boolean(query);
  const { items, loading, failed } = useReferenceCatalog(kind, search, cwd, provider);

  useLayoutEffect(() => {
    const root = input.current;
    if (!root) return;
    const current = readEditor(root, known.current);
    known.current = new Map(references.map((reference) => [reference.id, reference]));
    if (stateSignature(current.text, current.references) === stateSignature(value, references)) return;
    const selection = document.activeElement === root ? composerSelectionRange(root) : undefined;
    renderEditor(root, value, references);
    if (pendingReference.current) {
      const pill = Array.from(root.querySelectorAll<HTMLElement>("[data-reference-id]")).find(
        (element) => element.dataset.referenceId === pendingReference.current,
      );
      if (pill) {
        const range = document.createRange();
        const selected = window.getSelection();
        range.setStartAfter(pill);
        range.collapse(true);
        selected?.removeAllRanges();
        selected?.addRange(range);
      }
      pendingReference.current = undefined;
    } else if (pendingOffset.current !== undefined || selection) {
      setComposerSelection(root, pendingOffset.current ?? selection?.end ?? 0);
      pendingOffset.current = undefined;
    }
  }, [value, references]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: la liste revient en tête à chaque nouvelle recherche.
  useEffect(() => {
    setActive(0);
  }, [search, items]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: un autre dossier ou harnais ferme la liste ouverte.
  useEffect(() => {
    setDismissed(true);
  }, [cwd, provider]);

  const updateFromDom = () => {
    const root = input.current;
    if (!root) return;
    const next = readEditor(root, known.current);
    onValueChange(next.text);
    onReferencesChange(next.references);
    setCursor(composerSelectionRange(root).end);
    setDismissed(false);
  };

  const choose = (item: ComposerReference) => {
    if (!query) return;
    const next = removeReferenceQuery(value, query);
    const mention: ComposerReferenceMention = { ...item, id: crypto.randomUUID(), offset: query.start };
    pendingReference.current = mention.id;
    onValueChange(next.text);
    onReferencesChange([...replaceComposerRange(references, query.start, query.end), mention]);
    setCursor(query.start);
    setDismissed(true);
    requestAnimationFrame(() => input.current?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (visible) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        return;
      }
      // Tab complète avec l’élément actif, comme Entrée ; sans suggestion, il quitte le champ.
      if (event.key === "Tab" && !event.shiftKey && !loading && items[active]) {
        event.preventDefault();
        choose(items[active]);
        return;
      }
      if (event.key === "Tab") {
        setDismissed(true);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
        event.preventDefault();
        setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!loading && items[active]) choose(items[active]);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: les pastilles de référence interactives ne tiennent pas dans un textarea. */}
      <div
        {...props}
        ref={input}
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-placeholder={placeholder}
        aria-autocomplete="list"
        aria-controls={visible ? id : undefined}
        aria-activedescendant={visible && !loading && items[active] ? `${id}-${active}` : undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className={["reference-composer__input", className ?? ""].filter(Boolean).join(" ")}
        tabIndex={disabled ? -1 : (props.tabIndex ?? 0)}
        onInput={updateFromDom}
        onClick={(event) => {
          const remove = (event.target as Element).closest<HTMLElement>("[data-reference-remove]");
          if (remove?.dataset.referenceRemove) {
            event.preventDefault();
            const reference = references.find((item) => item.id === remove.dataset.referenceRemove);
            pendingOffset.current = reference?.offset ?? value.length;
            onReferencesChange(references.filter((item) => item.id !== remove.dataset.referenceRemove));
            requestAnimationFrame(() => input.current?.focus());
            return;
          }
          setCursor(composerSelectionRange(event.currentTarget).end);
          setDismissed(false);
        }}
        onFocus={(event) => {
          setCursor(composerSelectionRange(event.currentTarget).end);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setDismissed(true);
          onBlur?.(event);
        }}
        onPointerUp={(event) => {
          setCursor(composerSelectionRange(event.currentTarget).end);
          onPointerUp?.(event);
        }}
        onKeyUp={(event) => {
          setCursor(composerSelectionRange(event.currentTarget).end);
          onKeyUp?.(event);
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          // Collage forcé en texte brut : aucune mise en forme venue d’ailleurs.
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (document.execCommand?.("insertText", false, text)) return;
          const selection = window.getSelection();
          if (!selection?.rangeCount) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          event.currentTarget.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }),
          );
        }}
        onKeyDown={handleKeyDown}
      />
      {visible && query ? (
        <SuggestionList
          id={id}
          anchor={input}
          kind={query.kind}
          items={items}
          active={active}
          loading={loading}
          failed={failed}
          onHover={setActive}
          onChoose={choose}
        />
      ) : null}
    </>
  );
}
