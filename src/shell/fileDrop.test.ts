import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), notify: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
}));
vi.mock("./notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications")>()),
  notify: native.notify,
}));

import { handleNativeDrag, pageTakesDrop, refusedNotice, registerDropFrame } from "./fileDrop";
import { type FrameIdentity, type FramePush, handleFrameRequest } from "./frameBridge";

const page: FrameIdentity = { kind: "page", module: "docs", reference: "docs/documents" };
const subject = { kind: "page", module: "docs", reference: "docs/documents" };
const notice = { id: "a".repeat(32), name: "notice.pdf" };

/** Le cadre de la page, et ce qui est au premier plan sous le pointeur. */
let iframe: HTMLIFrameElement;
let onTop: Element | null;
let push: Mock<FramePush>;
let handle: ReturnType<typeof registerDropFrame>;

const at = (x: number, y: number) => ({ x, y });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue({ files: [notice], refused: [] });
  native.notify.mockReset();
  iframe = document.createElement("iframe");
  document.body.append(iframe);
  onTop = iframe;
  document.elementFromPoint = vi.fn(() => onTop);
  push = vi.fn<FramePush>();
  handle = registerDropFrame(
    () => iframe,
    () => page,
  );
});

afterEach(() => {
  handleNativeDrag({ type: "leave" });
  handle.dispose();
  iframe.remove();
  vi.unstubAllGlobals();
});

describe("dépôt de fichiers du système sur une page", () => {
  it("ne prend rien tant que la page ne l’a pas demandé", () => {
    expect(pageTakesDrop(at(10, 10))).toBe(false);
    handleNativeDrag({ type: "drop", paths: ["/Users/a/notice.pdf"], position: at(10, 10) });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("montre le survol au cadre sous le pointeur, copie les fichiers déposés pour son module et les lui remet", async () => {
    await handleFrameRequest(page, "files.acceptDrops", { accept: [".PDF", "png"] }, push);
    expect(pageTakesDrop(at(10, 10))).toBe(true);

    handleNativeDrag({ type: "enter", paths: ["/Users/a/notice.pdf"], position: at(10, 10) });
    handleNativeDrag({ type: "over", position: at(12, 12) });
    expect(push.mock.calls).toEqual([["fileDrag", { dragging: true }]]);

    // Le pointeur passe au-dessus d’autre chose (une modale, la conversation) : le cadre se retire.
    onTop = document.body;
    handleNativeDrag({ type: "over", position: at(900, 10) });
    expect(push).toHaveBeenLastCalledWith("fileDrag", { dragging: false });
    expect(pageTakesDrop(at(900, 10))).toBe(false);

    onTop = iframe;
    handleNativeDrag({ type: "over", position: at(12, 12) });
    handleNativeDrag({ type: "drop", paths: ["/Users/a/notice.pdf"], position: at(12, 12) });
    await settle();
    expect(native.invoke).toHaveBeenCalledWith("frame.files.importDropped", {
      paths: ["/Users/a/notice.pdf"],
      accept: ["pdf", "png"],
      subject,
    });
    expect(push.mock.calls.slice(-4)).toEqual([
      ["fileDrag", { dragging: false }],
      ["fileDrag", { dragging: false, importing: true }],
      ["filesDropped", { files: [notice] }],
      ["fileDrag", { dragging: false, importing: false }],
    ]);
    expect(native.notify).not.toHaveBeenCalled();
  });

  it("dit à l’utilisateur ce qui n’a pas été ajouté, et pourquoi", async () => {
    native.invoke.mockResolvedValue({
      files: [],
      refused: [
        { name: "contrat.docx", reason: "cette page n’accepte que les fichiers PDF" },
        { name: "Archives", reason: "c’est un dossier : déposez les fichiers qu’il contient" },
      ],
    });
    await handleFrameRequest(page, "files.acceptDrops", { accept: ["pdf"] }, push);
    handleNativeDrag({ type: "drop", paths: ["/a/contrat.docx", "/a/Archives"], position: at(5, 5) });
    await settle();
    expect(push).not.toHaveBeenCalledWith("filesDropped", expect.anything());
    expect(native.notify).toHaveBeenCalledWith({
      title: "2 fichiers non ajoutés",
      description:
        "« contrat.docx » : cette page n’accepte que les fichiers PDF. « Archives » : c’est un dossier : déposez les fichiers qu’il contient.",
      tone: "warning",
      source: "docs/documents",
    });
  });

  it("compte les pixels physiques de Tauri en pixels CSS", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    await handleFrameRequest(page, "files.acceptDrops", {}, push);
    pageTakesDrop(at(800, 400));
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(400, 200);
  });

  it("rend le dépôt à la conversation quand la page n’en veut plus, ou quand son cadre change de document", async () => {
    await handleFrameRequest(page, "files.acceptDrops", { accept: null }, push);
    expect(pageTakesDrop(at(10, 10))).toBe(true);
    await handleFrameRequest(page, "files.refuseDrops", {}, push);
    expect(pageTakesDrop(at(10, 10))).toBe(false);

    await handleFrameRequest(page, "files.acceptDrops", {}, push);
    handleNativeDrag({ type: "enter", paths: ["/a/b.pdf"], position: at(10, 10) });
    handle.reset();
    expect(push).toHaveBeenLastCalledWith("fileDrag", { dragging: false });
    expect(pageTakesDrop(at(10, 10))).toBe(false);
  });

  it("garde la demande d’une page dont l’identité change sans recharger son document", async () => {
    let identity: FrameIdentity = page;
    handle.dispose();
    handle = registerDropFrame(
      () => iframe,
      () => identity,
    );
    await handleFrameRequest(page, "files.acceptDrops", {}, push);
    identity = {
      ...page,
      view: { id: "notice", label: "Notice", params: null, page: "docs/documents", section: "docs" },
    };
    expect(pageTakesDrop(at(10, 10))).toBe(true);
  });

  it("refuse une fonction, ignore une capture et des types mal formés", async () => {
    await expect(
      handleFrameRequest(
        { kind: "function", module: "docs", reference: "docs/indexer" },
        "files.acceptDrops",
        {},
        push,
      ),
    ).rejects.toThrow("Une fonction ne reçoit pas de fichiers déposés");
    await handleFrameRequest({ ...page, capture: true }, "files.acceptDrops", {}, push);
    expect(pageTakesDrop(at(10, 10))).toBe(false);
    await expect(handleFrameRequest(page, "files.acceptDrops", { accept: "pdf" }, push)).rejects.toThrow(
      "Les types acceptés sont des extensions",
    );
  });
});

describe("notification des fichiers refusés", () => {
  it("nomme trois fichiers au plus", () => {
    const refused = ["a", "b", "c", "d", "e"].map((name) => ({ name: `${name}.txt`, reason: "plus de 50 Mo" }));
    expect(refusedNotice(refused)).toEqual({
      title: "5 fichiers non ajoutés",
      description: "« a.txt » : plus de 50 Mo. « b.txt » : plus de 50 Mo. « c.txt » : plus de 50 Mo. Et 2 autres.",
    });
    expect(refusedNotice(refused.slice(0, 1)).title).toBe("1 fichier non ajouté");
  });
});
