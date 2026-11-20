import { afterEach, describe, expect, it } from "vitest";
import { isExampleMode } from "./index";

describe("isExampleMode", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("lit le mode exemple dans l’adresse du cadre de la page", () => {
    expect(isExampleMode()).toBe(false);
    window.history.replaceState(null, "", "/?module=atom&examples=1");
    expect(isExampleMode()).toBe(true);
    window.history.replaceState(null, "", "/?module=atom&kind=panel");
    expect(isExampleMode()).toBe(false);
  });
});
