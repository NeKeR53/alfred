import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FrameServices, FrameServicesContext } from "../templates/services";
import { DocumentViewer } from "./DocumentViewer";
import { detectFormat, parseDataUrl } from "./documentSource";
import { openPdf, renderPdfPage } from "./pdfDocument";

// pdf.js ne dessine pas dans jsdom : le chargement et le dessin sont simulés.
vi.mock("./pdfDocument", () => ({
  openPdf: vi.fn(),
  renderPdfPage: vi.fn(() => ({ promise: new Promise(() => undefined), cancel: () => undefined })),
}));

const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function services(overrides: Partial<FrameServices> = {}): FrameServices {
  return {
    notify: vi.fn(),
    publish: vi.fn(),
    setPanelVisible: vi.fn(),
    openExternal: vi.fn(),
    send: vi.fn(),
    onPeer: () => () => undefined,
    onSelection: () => () => undefined,
    ...overrides,
  };
}

function withServices(value: FrameServices, children: ReactNode) {
  return <FrameServicesContext.Provider value={value}>{children}</FrameServicesContext.Provider>;
}

beforeEach(() => {
  vi.mocked(renderPdfPage).mockImplementation(() => ({
    promise: new Promise(() => undefined),
    cancel: () => undefined,
  }));
});

describe("DocumentViewer", () => {
  it("affiche un PDF du module : page x / y, zoom, et l’ouvre avec l’application du système", async () => {
    const user = userEvent.setup();
    vi.mocked(openPdf).mockResolvedValue({
      document: {} as never,
      sizes: [
        { width: 595, height: 842 },
        { width: 595, height: 842 },
      ],
      destroy: vi.fn(),
    });
    const readFile = vi.fn().mockResolvedValue({ name: "Facture.pdf", mime: "application/pdf", data: base64("%PDF") });
    const openFile = vi.fn().mockResolvedValue(undefined);
    render(withServices(services({ readFile, openFile }), <DocumentViewer label="Facture F-114" file="f1" />));

    expect(await screen.findByText("Page 1 / 2")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith("f1");
    expect(Array.from(vi.mocked(openPdf).mock.calls[0][0])).toEqual([37, 80, 68, 70]);
    expect(screen.getByRole("document", { name: "Facture F-114, 2 pages" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Page \d$/ })).toHaveLength(2);

    expect(screen.getByText("100 %")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Zoom avant" }));
    expect(screen.getByText("125 %")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ajuster à la largeur" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Ajuster à la largeur" }));
    expect(screen.getByText("100 %")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ouvrir avec l’application du système" }));
    expect(openFile).toHaveBeenCalledWith("f1");
  });

  it("affiche du Markdown reçu en adresse data:", async () => {
    render(
      <DocumentViewer
        label="Notes"
        name="notes.md"
        src={`data:text/markdown;base64,${base64("# Réunion\n\n- point **un**")}`}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Réunion" })).toBeTruthy();
    expect(screen.getByText("un").tagName).toBe("STRONG");
    expect(screen.getByRole("toolbar").textContent).toContain("notes.md");
    // Ni zoom ni ouverture : ce n’est ni un PDF, ni une image, ni un fichier du module.
    expect(screen.queryByRole("button", { name: "Zoom avant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ouvrir avec l’application du système" })).toBeNull();
  });

  it("affiche un texte brut reçu en Blob, sans l’interpréter", async () => {
    const file = new File(["ligne 1\n<b>pas du HTML</b>"], "journal.log", { type: "" });
    render(<DocumentViewer label="Journal" blob={file} />);
    const text = await screen.findByText(/ligne 1/);
    expect(text.tagName).toBe("PRE");
    expect(text.textContent).toBe("ligne 1\n<b>pas du HTML</b>");
    expect(screen.getByRole("toolbar").textContent).toContain("journal.log");
  });

  it("affiche une image et la zoome", async () => {
    const user = userEvent.setup();
    render(<DocumentViewer label="Plan du site" src="data:image/png;base64,iVBORw0KGgo=" />);
    const image = await screen.findByRole("img", { name: "Plan du site" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    Object.defineProperty(image, "naturalWidth", { value: 400 });
    Object.defineProperty(image, "naturalHeight", { value: 200 });
    image.dispatchEvent(new Event("load"));
    await user.click(await screen.findByRole("button", { name: "Zoom avant" }));
    expect((image as HTMLImageElement).style.width).toBe("500px");
  });

  it("dit qu’un format n’est pas pris en charge et propose l’application du système", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue({
      name: "Contrat.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: base64("PK"),
    });
    render(withServices(services({ readFile, openFile }), <DocumentViewer label="Contrat" file="f2" />));
    expect(await screen.findByText("Format non pris en charge")).toBeTruthy();
    expect(screen.getByText("Ce type de fichier (.docx) ne s’affiche pas dans une page.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ouvrir avec l’application du système" }));
    expect(openFile).toHaveBeenCalledWith("f2");
  });

  it("montre le chargement, puis l’erreur d’un PDF illisible", async () => {
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(openPdf).mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    render(<DocumentViewer label="Rapport" src={`data:application/pdf;base64,${base64("pas un PDF")}`} />);
    expect(await screen.findByRole("status", { name: "Lecture du document…" })).toBeTruthy();
    fail(new Error("Invalid PDF structure."));
    expect(await screen.findByText("Document illisible")).toBeTruthy();
    expect(screen.getByText("Invalid PDF structure.")).toBeTruthy();
  });

  it("refuse un fichier du module hors d’une page, et une adresse web", async () => {
    const { unmount } = render(<DocumentViewer label="Pièce" file="f3" />);
    expect(await screen.findByText(/ne s’affichent que dans une page/)).toBeTruthy();
    unmount();
    render(<DocumentViewer label="Distant" src="https://exemple.fr/a.pdf" />);
    expect(await screen.findByText("Document illisible")).toBeTruthy();
  });

  it("relit le document quand la source change", async () => {
    const { rerender } = render(<DocumentViewer label="Note" src={`data:text/plain,${encodeURIComponent("avant")}`} />);
    expect(await screen.findByText("avant")).toBeTruthy();
    rerender(<DocumentViewer label="Note" src={`data:text/plain,${encodeURIComponent("après")}`} />);
    await waitFor(() => expect(screen.getByText("après")).toBeTruthy());
  });
});

describe("format d’un document", () => {
  it("se lit du type MIME, puis de l’extension", () => {
    expect(detectFormat("application/pdf", "x")).toBe("pdf");
    expect(detectFormat("image/svg+xml", undefined)).toBe("image");
    expect(detectFormat("text/plain", "lisez-moi.md")).toBe("markdown");
    expect(detectFormat("application/octet-stream", "export.csv")).toBe("text");
    expect(detectFormat("application/json; charset=utf-8", "")).toBe("text");
    expect(detectFormat("application/zip", "archive.zip")).toBeNull();
    expect(detectFormat(undefined, undefined)).toBeNull();
  });

  it("décode une adresse data: en base64 ou en clair", () => {
    const plain = parseDataUrl("data:text/plain;charset=utf-8,%C3%A9t%C3%A9");
    expect(plain.mime).toBe("text/plain");
    expect(new TextDecoder().decode(plain.bytes)).toBe("été");
    const encoded = parseDataUrl(`data:;base64,${base64("ok")}`);
    expect(encoded.mime).toBe("text/plain");
    expect(Array.from(encoded.bytes)).toEqual([111, 107]);
    expect(() => parseDataUrl("data:sans-virgule")).toThrow();
  });
});
