import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  // jsdom n’a pas de modale native.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  return { invoke: vi.fn(), pickSaveFile: vi.fn() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  pickSaveFile: native.pickSaveFile,
}));

import { type FrameIdentity, handleFrameRequest } from "../../shell/frameBridge";
import { SecretRevealHost } from "./SecretReveal";

const REF = `alfred-secret-ref:v1:${"a".repeat(43)}`;
const VALUE = "v4l3ur-r3v3l33";
const page: FrameIdentity = { kind: "page", module: "secrets", reference: "secrets/coffre" };
const subject = { kind: "page", module: "secrets", reference: "secrets/coffre" };

beforeEach(() => {
  native.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "secrets.describe") return { client: "openbao", instance: "prod", expiresIn: 280 };
    if (command === "secrets.reveal") return { value: VALUE };
    if (command === "secrets.writeEnvFile") return { written: 2, name: "app.env" };
    return null;
  });
  native.pickSaveFile.mockReset();
});

describe("valeurs scellées", () => {
  it("la page ne reçoit jamais la valeur : la coquille l’affiche sur un clic", async () => {
    render(<SecretRevealHost />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = handleFrameRequest(page, "secrets.reveal", { ref: REF, label: "DB_PASSWORD", subject: { module: "x" } });
    });
    await screen.findByText(/lue sur le compte prod de openbao/);
    // Rien n’est lu avant le clic.
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["secrets.describe"]);
    fireEvent.click(screen.getByRole("button", { name: /Afficher/ }));
    await screen.findByText(VALUE);
    expect(native.invoke).toHaveBeenCalledWith("secrets.reveal", { subject, reference: REF, label: "DB_PASSWORD" });
    const closers = screen.getAllByRole("button", { name: "Fermer" });
    fireEvent.click(closers[closers.length - 1] as HTMLElement);
    const result = await answer;
    expect(result).toEqual({ shown: true });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    await waitFor(() => expect(screen.queryByText(VALUE)).toBeNull());
  });

  it("une fonction ne peut ni afficher ni écrire un secret", async () => {
    const fn: FrameIdentity = { kind: "function", module: "secrets", reference: "secrets/lire" };
    await expect(handleFrameRequest(fn, "secrets.reveal", { ref: REF })).rejects.toThrow(/fonction/);
    await expect(handleFrameRequest(fn, "secrets.writeEnvFile", { entries: [] })).rejects.toThrow(/fonction/);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("le .env s’écrit à l’endroit choisi par l’utilisateur, ou pas du tout", async () => {
    native.pickSaveFile.mockResolvedValueOnce(null);
    const entries = [{ name: "DB_PASSWORD", ref: REF }];
    expect(await handleFrameRequest(page, "secrets.writeEnvFile", { entries })).toEqual({ saved: false });
    expect(native.invoke).not.toHaveBeenCalled();
    native.pickSaveFile.mockResolvedValueOnce("/Users/moi/app.env");
    expect(await handleFrameRequest(page, "secrets.writeEnvFile", { name: "app.env", entries })).toEqual({
      saved: true,
      written: 2,
    });
    expect(native.pickSaveFile).toHaveBeenLastCalledWith(expect.any(String), "app.env");
    expect(native.invoke).toHaveBeenCalledWith("secrets.writeEnvFile", {
      subject,
      path: "/Users/moi/app.env",
      entries,
    });
  });

  it("transmet l’accord `sealed` et lit les paramètres du compte", async () => {
    await handleFrameRequest(page, "clients.request", { client: "openbao", path: "/v1/kv/data/a", sealed: true });
    await handleFrameRequest(page, "clients.params", { client: "openbao", instance: "prod", autre: 1 });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.clients.request", { subject, client: "openbao", path: "/v1/kv/data/a", sealed: true }],
      ["frame.clients.params", { subject, client: "openbao", instance: "prod" }],
    ]);
  });
});
