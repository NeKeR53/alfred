import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorProps } from "./MarkdownEditor";

// jsdom ne mesure pas le texte ; CodeMirror en a besoin pour placer le curseur.
beforeAll(() => {
  const empty = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= empty;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

/** La page qui tient le texte : elle enregistre sur demande et le signale par `savedValue`. */
function NotePage(props: Partial<MarkdownEditorProps> & { initial: string; onSaved?: (text: string) => void }) {
  const { initial, onSaved, ...rest } = props;
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  return (
    <MarkdownEditor
      label="Contenu de la note"
      value={text}
      onChange={setText}
      savedValue={saved}
      onSave={() => {
        setSaved(text);
        onSaved?.(text);
      }}
      {...rest}
    />
  );
}

async function editor() {
  const content = await screen.findByRole("textbox", { name: "Contenu de la note" });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("Éditeur introuvable");
  return { content, view };
}

const text = (view: EditorView) => view.state.doc.toString();

describe("MarkdownEditor", () => {
  it("met en forme au clavier et par la barre, annule, compte les modifications et enregistre", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<NotePage initial="Bonjour" onSaved={onSaved} />);
    const { content, view } = await editor();

    act(() => view.dispatch({ selection: { anchor: 0, head: 7 } }));
    fireEvent.keyDown(content, { key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });
    expect(text(view)).toBe("**Bonjour**");
    expect(screen.getByRole("status")).toHaveTextContent("1 modification non enregistrée");
    // L’aperçu reprend le rendu Markdown.
    expect(await screen.findByText("Bonjour", { selector: "strong" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Liste à puces (Ctrl+Maj+8)" }));
    expect(text(view)).toBe("- **Bonjour**");
    expect(screen.getByRole("status")).toHaveTextContent("2 modifications non enregistrées");

    fireEvent.keyDown(content, { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true });
    expect(text(view)).toBe("**Bonjour**");
    fireEvent.keyDown(content, { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true });
    expect(onSaved).toHaveBeenCalledWith("**Bonjour**");
    await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());

    act(() => view.dispatch({ selection: { anchor: text(view).length } }));
    fireEvent.keyDown(content, { key: "k", code: "KeyK", keyCode: 75, ctrlKey: true });
    expect(text(view)).toBe("**Bonjour**[texte](adresse)");
    // « texte » est sélectionné, prêt à être remplacé.
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("texte");
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    fireEvent.keyDown(content, { key: "2", code: "Digit2", keyCode: 50, ctrlKey: true, altKey: true });
    expect(text(view)).toBe("## **Bonjour**[texte](adresse)");
  });

  it("confie une image collée au module et insère son adresse ; un échec est dit", async () => {
    let finish: (src: string) => void = () => undefined;
    const onPasteImage = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    render(<NotePage initial="" onPasteImage={onPasteImage} />);
    const { content, view } = await editor();

    const image = new File(["png"], "capture.png", { type: "image/png" });
    fireEvent.paste(content, { clipboardData: { files: [image], types: ["Files"], getData: () => "" } });
    expect(onPasteImage).toHaveBeenCalledWith(image);
    expect(text(view)).toMatch(/^!\[Envoi de capture\.png…\]/);
    await act(async () => finish("data:image/png;base64,iVBOR"));
    expect(text(view)).toBe("![capture](data:image/png;base64,iVBOR)\n");
    expect(await screen.findByRole("img", { name: "capture" })).toBeInTheDocument();

    onPasteImage.mockImplementationOnce(() => Promise.reject(new Error("Disque plein")));
    await act(async () => {
      fireEvent.paste(content, { clipboardData: { files: [image], types: ["Files"], getData: () => "" } });
    });
    expect(text(view)).toBe("![capture](data:image/png;base64,iVBOR)\n");
    expect(screen.getByRole("status")).toHaveTextContent("Image non ajoutée : capture.png");
  });

  it("en onglets, garde l’historique d’annulation en passant par l’aperçu", async () => {
    const user = userEvent.setup();
    render(<NotePage initial="Texte" layout="tabs" />);
    const { content, view } = await editor();
    act(() => view.dispatch({ changes: { from: 5, insert: " modifié" }, userEvent: "input.type" }));

    await user.click(screen.getByRole("tab", { name: "Aperçu" }));
    expect(screen.getByRole("tabpanel", { name: "Aperçu" })).toHaveTextContent("Texte modifié");
    expect(screen.queryByRole("toolbar", { name: "Mise en forme" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Écrire" }));
    fireEvent.keyDown(content, { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true });
    expect(text(view)).toBe("Texte");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
