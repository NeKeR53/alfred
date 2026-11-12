import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), openExternal: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
  openExternal: native.openExternal,
}));

import { type FrameIdentity, handleFrameRequest } from "./frameBridge";

const page: FrameIdentity = { kind: "page", module: "notes", reference: "notes/liste" };
const own = { kind: "page", module: "notes", reference: "notes/liste" };
const forged = { kind: "page", module: "banque", reference: "banque/comptes" };

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(null);
  native.openExternal.mockReset().mockResolvedValue(undefined);
});

describe("identité du demandeur", () => {
  it("vient du cadre émetteur, jamais d’un champ du message", async () => {
    await handleFrameRequest(page, "db.query", { subject: forged, sql: "SELECT * FROM banque_operations", params: [] });
    await handleFrameRequest(page, "db.execute", { subject: forged, sql: "DELETE FROM banque_operations" });
    await handleFrameRequest(page, "clients.request", { subject: forged, client: "jira", path: "/x" });
    const subjects = native.invoke.mock.calls.map(([, args]) => (args as { subject: unknown }).subject);
    expect(subjects).toEqual([own, own, own]);
  });

  it("ne transmet au backend que les champs attendus", async () => {
    await handleFrameRequest(page, "db.query", { sql: "SELECT 1", params: [1], autre: "x" });
    await handleFrameRequest(page, "clients.request", {
      client: "jira",
      method: "GET",
      path: "/x",
      query: { a: 1 },
      headers: { accept: "json" },
      body: { b: 2 },
      autre: "x",
    });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.db.query", { subject: own, sql: "SELECT 1", params: [1] }],
      [
        "frame.clients.request",
        {
          subject: own,
          client: "jira",
          method: "GET",
          path: "/x",
          query: { a: 1 },
          headers: { accept: "json" },
          body: { b: 2 },
        },
      ],
    ]);
  });
});

describe("liens externes", () => {
  it("n’ouvrent une adresse qu’après l’accord donné par Rust, au nom du cadre émetteur", async () => {
    native.invoke.mockResolvedValue({ url: "https://docs.example.com/" });
    await handleFrameRequest(page, "shell.openExternal", { url: "https://docs.example.com/", subject: forged });
    expect(native.invoke).toHaveBeenCalledWith("frame.shell.openExternal", {
      subject: own,
      url: "https://docs.example.com/",
    });
    expect(native.openExternal).toHaveBeenCalledWith("https://docs.example.com/");
  });

  it("n’ouvrent rien si l’accord est refusé", async () => {
    native.invoke.mockRejectedValue(new Error("Accès refusé"));
    await expect(handleFrameRequest(page, "shell.openExternal", { url: "https://x.example/?d=1" })).rejects.toThrow();
    expect(native.openExternal).not.toHaveBeenCalled();
  });
});
