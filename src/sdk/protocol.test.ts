import { describe, expect, it } from "vitest";
import { frameShortcut, isShellShortcut, parseFrameShortcut } from "./protocol";

const key = (init: Partial<KeyboardEventInit> & { key: string }) =>
  new KeyboardEvent("keydown", { code: `Key${init.key.toUpperCase()}`, ...init });

describe("raccourcis remontés par un cadre", () => {
  it("remonte Cmd+K et Ctrl+K, et les reconnaît comme raccourcis de la coquille", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const shortcut = frameShortcut(key({ key: "k", ...modifier }));
      expect(shortcut).toMatchObject({ key: "k", code: "KeyK", ...modifier });
      expect(shortcut && isShellShortcut(shortcut)).toBe(true);
    }
  });

  it("reconnaît Cmd+F et Ctrl+F, qui mènent à la recherche de la barre du haut", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const shortcut = frameShortcut(key({ key: "f", ...modifier }));
      expect(shortcut && isShellShortcut(shortcut)).toBe(true);
    }
    const shifted = frameShortcut(key({ key: "f", metaKey: true, shiftKey: true }));
    expect(shifted && isShellShortcut(shifted)).toBe(false);
  });

  it("ne remonte jamais la frappe ordinaire, une répétition ou une touche de modification seule", () => {
    expect(frameShortcut(key({ key: "k" }))).toBeUndefined();
    expect(frameShortcut(key({ key: "K", shiftKey: true }))).toBeUndefined();
    expect(frameShortcut(key({ key: "k", metaKey: true, repeat: true }))).toBeUndefined();
    expect(frameShortcut(key({ key: "Meta", metaKey: true }))).toBeUndefined();
  });

  it("laisse au navigateur les autres combinaisons (copier, coller)", () => {
    const copy = frameShortcut(key({ key: "c", metaKey: true }));
    expect(copy && isShellShortcut(copy)).toBe(false);
  });

  it("refuse un message mal formé ou sans Cmd ni Ctrl", () => {
    expect(parseFrameShortcut(null)).toBeUndefined();
    expect(parseFrameShortcut({ key: "k", code: "KeyK" })).toBeUndefined();
    expect(
      parseFrameShortcut({ key: "k", code: "KeyK", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBeUndefined();
    const valid = { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(parseFrameShortcut({ ...valid, extra: "ignoré" })).toEqual(valid);
  });
});
