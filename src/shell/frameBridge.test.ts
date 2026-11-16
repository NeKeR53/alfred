import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), openExternal: vi.fn(), openPageWindow: vi.fn(), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
  openExternal: native.openExternal,
  openPageWindow: native.openPageWindow,
  pickFiles: native.pickFiles,
  pickSaveFile: native.pickSaveFile,
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
    await handleFrameRequest(page, "clients.instances", { subject: forged, client: "jira" });
    const subjects = native.invoke.mock.calls.map(([, args]) => (args as { subject: unknown }).subject);
    expect(subjects).toEqual([own, own, own, own]);
  });

  it("ne transmet au backend que les champs attendus", async () => {
    await handleFrameRequest(page, "db.query", { sql: "SELECT 1", params: [1], autre: "x" });
    await handleFrameRequest(page, "clients.request", {
      client: "jira",
      instance: "acme",
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
          instance: "acme",
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

describe("page d’une section par instance", () => {
  const copy: FrameIdentity = { kind: "page", module: "jira", reference: "jira/tickets@acme", instance: "acme" };

  it("se présente comme la page déclarée, avec son instance à part", async () => {
    const context = (await handleFrameRequest(copy, "shell.context", {})) as Record<string, unknown>;
    expect(context).toMatchObject({ reference: "jira/tickets", module: "jira", page: "tickets", instance: "acme" });
    await handleFrameRequest(copy, "clients.request", { client: "jira", path: "/x", subject: forged });
    expect(native.invoke).toHaveBeenCalledWith("frame.clients.request", {
      subject: { kind: "page", module: "jira", reference: "jira/tickets", instance: "acme" },
      client: "jira",
      path: "/x",
    });
  });

  it("n’a pas d’instance hors d’une section par instance", async () => {
    const context = (await handleFrameRequest(page, "shell.context", {})) as Record<string, unknown>;
    expect(context.instance).toBeNull();
  });
});

describe("fenêtres de page", () => {
  it("ouvrent la page nommée, ou la page elle-même sans argument", async () => {
    await handleFrameRequest(page, "shell.openWindow", { reference: "jira/tickets@acme" });
    await handleFrameRequest(page, "shell.openWindow", {});
    const panel: FrameIdentity = { kind: "panel", module: "notes", reference: "notes/detail", host: "notes/liste" };
    await handleFrameRequest(panel, "shell.openWindow", {});
    expect(native.openPageWindow.mock.calls).toEqual([["jira/tickets@acme"], ["notes/liste"], ["notes/liste"]]);
  });
});

describe("fichiers du module", () => {
  const fn: FrameIdentity = { kind: "function", module: "notes", reference: "notes/importer" };

  it("range et lit pour le module du cadre, sans champ de trop", async () => {
    await handleFrameRequest(page, "files.save", { subject: forged, name: "a.txt", text: "x", chemin: "/etc" });
    await handleFrameRequest(page, "files.read", { subject: forged, id: "abc", path: "/etc/passwd" });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.files.save", { subject: own, name: "a.txt", text: "x" }],
      ["frame.files.read", { subject: own, id: "abc" }],
    ]);
  });

  it("montre le sélecteur dans la coquille : la page ne nomme jamais un chemin", async () => {
    native.pickFiles.mockResolvedValue(["/Users/x/facture.pdf"]);
    await handleFrameRequest(page, "files.pick", { accept: [".pdf"], multiple: true, paths: ["/etc/passwd"] });
    expect(native.pickFiles).toHaveBeenCalledWith("Choisir un fichier", { multiple: true, extensions: ["pdf"] });
    expect(native.invoke).toHaveBeenCalledWith("frame.files.importPaths", {
      paths: ["/Users/x/facture.pdf"],
      subject: own,
    });

    native.invoke.mockReset().mockResolvedValue({ name: "facture.pdf" });
    native.pickSaveFile.mockResolvedValue("/Users/x/Bureau/facture.pdf");
    expect(await handleFrameRequest(page, "files.export", { id: "abc", path: "/etc/x" })).toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith("frame.files.exportTo", {
      id: "abc",
      path: "/Users/x/Bureau/facture.pdf",
      subject: own,
    });
  });

  it("refuse les gestes de l’utilisateur à une fonction en arrière-plan", async () => {
    await expect(handleFrameRequest(fn, "files.pick", {})).rejects.toThrow(/fonction/);
    await expect(handleFrameRequest(fn, "files.export", { id: "abc" })).rejects.toThrow(/fonction/);
    expect(native.pickFiles).not.toHaveBeenCalled();
  });
});

describe("documents", () => {
  it("transmet les seuls champs de chaque document, pour le module du cadre", async () => {
    await handleFrameRequest(page, "documents.pdf", { subject: forged, name: "r", title: "T", blocks: [], path: "/x" });
    await handleFrameRequest(page, "documents.extractText", { id: "abc", module: "banque" });
    await handleFrameRequest(page, "search.query", { index: "notes", text: "été", limit: 5, sql: "DROP" });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.documents.pdf", { subject: own, name: "r", title: "T", blocks: [] }],
      ["frame.documents.extractText", { subject: own, id: "abc" }],
      ["frame.search.query", { subject: own, index: "notes", text: "été", limit: 5 }],
    ]);
  });
});
