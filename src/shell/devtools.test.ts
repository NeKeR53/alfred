import { describe, expect, it } from "vitest";
import { bindDevtoolsShortcut, isInspectShortcut } from "./devtools";

const key = (init: Partial<KeyboardEvent>) =>
  ({
    key: "i",
    code: "KeyI",
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

describe("inspecteur en développement", () => {
  it("reconnaît Cmd+Option+I et Ctrl+Maj+I, pas Cmd+I ni Ctrl+I", () => {
    expect(isInspectShortcut(key({ metaKey: true, altKey: true, key: "ˆ" }))).toBe(true);
    expect(isInspectShortcut(key({ ctrlKey: true, shiftKey: true, key: "I" }))).toBe(true);
    expect(isInspectShortcut(key({ metaKey: true }))).toBe(false);
    expect(isInspectShortcut(key({ ctrlKey: true }))).toBe(false);
  });

  it("ne pose rien hors développement", () => {
    let added = 0;
    const target = { addEventListener: () => added++, removeEventListener: () => undefined } as unknown as Window;
    bindDevtoolsShortcut(target, false)();
    expect(added).toBe(0);
  });
});
