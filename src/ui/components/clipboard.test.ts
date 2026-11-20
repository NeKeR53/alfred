import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("passe par le presse-papiers asynchrone quand il est permis", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("session");
    expect(writeText).toHaveBeenCalledWith("session");
  });

  it("dans un cadre isolé, se rabat sur la commande « copier » du document, et le dit quand elle est refusée", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("refusé")) } });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await copyText("session");
    expect(execCommand).toHaveBeenCalledWith("copy");
    execCommand.mockReturnValue(false);
    await expect(copyText("session")).rejects.toThrow("La copie n’est pas permise ici.");
  });
});
