import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FileInfo, useFileDrop } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

const sent: FrameRequest[] = [];
const spyPost = () =>
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
  });

const fromShell = (name: string, payload: unknown) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { alfred: ALFRED_MESSAGE, kind: "event", name, payload },
        source: window.parent,
      }),
    );
  });

const notice: FileInfo = {
  id: "a".repeat(32),
  name: "notice.pdf",
  mime: "application/pdf",
  size: 8,
  sha256: "0".repeat(64),
  createdAt: "2026-11-26T20:00:00Z",
};

afterEach(() => {
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("useFileDrop", () => {
  it("demande le dépôt avec ses types, suit le survol et reçoit les fichiers copiés par Alfred", () => {
    spyPost();
    const onFiles = vi.fn();
    const { result, unmount } = renderHook(() => useFileDrop({ accept: ["pdf"], onFiles }));
    expect(sent.at(-1)).toMatchObject({ method: "files.acceptDrops", params: { accept: ["pdf"] } });
    expect(result.current).toEqual({ isDraggingFiles: false, isImporting: false });

    fromShell("fileDrag", { dragging: true });
    expect(result.current.isDraggingFiles).toBe(true);
    fromShell("fileDrag", { dragging: false, importing: true });
    expect(result.current).toEqual({ isDraggingFiles: false, isImporting: true });
    fromShell("filesDropped", { files: [notice] });
    fromShell("fileDrag", { dragging: false, importing: false });
    expect(onFiles).toHaveBeenCalledWith([notice]);
    expect(result.current.isImporting).toBe(false);

    unmount();
    expect(sent.at(-1)?.method).toBe("files.refuseDrops");
  });

  it("donne le dépôt à la déclaration la plus récente, puis le rend à la précédente", () => {
    spyPost();
    const page = vi.fn();
    const subview = vi.fn();
    const first = renderHook(() => useFileDrop({ onFiles: page }));
    expect(sent.at(-1)).toMatchObject({ method: "files.acceptDrops", params: { accept: null } });
    const second = renderHook(() => useFileDrop({ accept: ["png"], onFiles: subview }));
    expect(sent.at(-1)).toMatchObject({ method: "files.acceptDrops", params: { accept: ["png"] } });

    fromShell("fileDrag", { dragging: true });
    expect(second.result.current.isDraggingFiles).toBe(true);
    expect(first.result.current.isDraggingFiles).toBe(false);
    fromShell("filesDropped", { files: [notice] });
    expect(subview).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();

    second.unmount();
    expect(sent.at(-1)).toMatchObject({ method: "files.acceptDrops", params: { accept: null } });
    fromShell("filesDropped", { files: [notice] });
    expect(page).toHaveBeenCalledWith([notice]);
    first.unmount();
  });

  it("ne prend plus de dépôt quand `enabled` est faux", () => {
    spyPost();
    const { rerender, unmount } = renderHook(({ enabled }) => useFileDrop({ onFiles: vi.fn(), enabled }), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    expect(sent.at(-1)?.method).toBe("files.refuseDrops");
    unmount();
  });
});
