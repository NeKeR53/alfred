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
      cache: 60,
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
          cache: 60,
        },
      ],
    ]);
  });
});

describe("décisions locales", () => {
  it("transmettent la question et ses choix, au nom du cadre émetteur", async () => {
    await handleFrameRequest(page, "ai.decide", {
      subject: forged,
      text: "Prélevé deux fois",
      question: "Quelle équipe ?",
      choices: [
        ["facturation", "paiements"],
        ["technique", null],
      ],
      autre: "x",
    });
    await handleFrameRequest(page, "ai.decide", { text: { corps: "x" }, preset: "email" });
    expect(native.invoke.mock.calls).toEqual([
      [
        "frame.ai.decide",
        {
          subject: own,
          text: "Prélevé deux fois",
          question: "Quelle équipe ?",
          choices: [
            ["facturation", "paiements"],
            ["technique", null],
          ],
        },
      ],
      ["frame.ai.decide", { subject: own, text: { corps: "x" }, preset: "email" }],
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

  it("une copie dont le suffixe n’est pas un compte reçoit ses comptes par besoin, et `instance` reste rempli", async () => {
    const tab: FrameIdentity = {
      kind: "page",
      module: "prefect",
      reference: "prefect/deploiements@prefect-recette",
      instance: "recette",
      accounts: { prefect: "recette" },
    };
    const context = (await handleFrameRequest(tab, "shell.context", {})) as Record<string, unknown>;
    expect(context).toMatchObject({
      reference: "prefect/deploiements",
      page: "deploiements",
      instance: "recette",
      accounts: { prefect: "recette" },
    });
    await handleFrameRequest(tab, "clients.instances", { client: "prefect" });
    expect(native.invoke).toHaveBeenCalledWith("frame.clients.instances", {
      subject: {
        kind: "page",
        module: "prefect",
        reference: "prefect/deploiements",
        instance: "recette",
        accounts: { prefect: "recette" },
      },
      client: "prefect",
    });
  });

  it("n’a pas d’instance hors d’une section par instance", async () => {
    const context = (await handleFrameRequest(page, "shell.context", {})) as Record<string, unknown>;
    expect(context.instance).toBeNull();
    expect(context.accounts).toEqual({});
  });
});

describe("fenêtres de page", () => {
  it("ouvrent la page nommée, ou la page elle-même sans argument", async () => {
    await handleFrameRequest(page, "shell.openWindow", { reference: "jira/tickets@acme" });
    await handleFrameRequest(page, "shell.openWindow", {});
    const panel: FrameIdentity = { kind: "panel", module: "notes", reference: "notes/detail", host: "notes/liste" };
    await handleFrameRequest(panel, "shell.openWindow", {});
    await handleFrameRequest(page, "shell.openWindow", {
      reference: "liste",
      params: { id: 7 },
      key: "7",
      title: "N° 7",
    });
    expect(native.openPageWindow.mock.calls).toEqual([
      ["jira/tickets@acme", {}],
      ["notes/liste", {}],
      ["notes/liste", {}],
      ["notes/liste", { params: { id: 7 }, key: "7", title: "N° 7" }],
    ]);
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
    await handleFrameRequest(page, "events.publish", {
      subject: forged,
      event: "note-creee",
      payload: { id: 1 },
      to: "x",
    });
    await handleFrameRequest(page, "commands.run", {
      program: "git",
      args: ["status"],
      cwd: { folder: "api" },
      env: { X: "1" },
    });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.documents.pdf", { subject: own, name: "r", title: "T", blocks: [] }],
      ["frame.documents.extractText", { subject: own, id: "abc" }],
      ["frame.search.query", { subject: own, index: "notes", text: "été", limit: 5 }],
      ["frame.events.publish", { subject: own, event: "note-creee", payload: { id: 1 } }],
      // `cwd` passe (un dossier accordé, vérifié par Alfred) ; `env` non.
      ["frame.commands.run", { subject: own, program: "git", args: ["status"], cwd: { folder: "api" } }],
    ]);
  });
});

describe("dossiers du poste et git", () => {
  it("transmettent les seuls champs prévus, et seule une page fait choisir un dossier", async () => {
    const page: FrameIdentity = { kind: "page", module: "produits", reference: "produits/liste" };
    const own = { kind: "page", module: "produits", reference: "produits/liste" };
    await handleFrameRequest(page, "folders.writeText", {
      folder: "api",
      path: "a.json",
      text: "{}",
      subject: { module: "autre" },
    });
    await handleFrameRequest(page, "git.commit", {
      folder: "api",
      repo: "web",
      message: "m",
      paths: ["a"],
      force: true,
    });
    await expect(
      handleFrameRequest({ kind: "function", module: "produits", reference: "produits/f" }, "folders.pick", {}),
    ).rejects.toThrow(/depuis une page/);
    expect(native.invoke.mock.calls).toEqual([
      ["frame.folders.writeText", { subject: own, folder: "api", path: "a.json", text: "{}" }],
      ["frame.git.commit", { subject: own, folder: "api", repo: "web", message: "m", paths: ["a"] }],
    ]);
  });
});

describe("transport des comptes et canaux", () => {
  it("transmet téléchargements, envois, flux et WebSocket sans champ de plus", async () => {
    const fn: FrameIdentity = { kind: "function", module: "ci", reference: "ci/suivre" };
    const subject = { kind: "function", module: "ci", reference: "ci/suivre" };
    await handleFrameRequest(fn, "clients.download", { client: "art", path: "/a.zip", name: "a.zip", autre: 1 });
    await handleFrameRequest(fn, "clients.request", {
      client: "jira",
      method: "POST",
      path: "/pj",
      multipart: [{ name: "file", file: "f1" }],
      responseType: "base64",
      subject: forged,
    });
    await handleFrameRequest(fn, "clients.stream", { client: "p", path: "/logs", format: "docker" });
    await handleFrameRequest(fn, "clients.socket", { client: "p", path: "/ws", body: "ignoré", query: { id: "x" } });
    expect(native.invoke.mock.calls).toEqual([
      ["frame.clients.download", { subject, client: "art", path: "/a.zip", name: "a.zip" }],
      [
        "frame.clients.request",
        {
          subject,
          client: "jira",
          method: "POST",
          path: "/pj",
          multipart: [{ name: "file", file: "f1" }],
          responseType: "base64",
        },
      ],
      ["frame.clients.stream", { subject, client: "p", path: "/logs", format: "docker" }],
      ["frame.clients.socket", { subject, client: "p", path: "/ws", query: { id: "x" } }],
    ]);
  });

  it("lit un canal au nom du cadre, copie comprise, et le ferme avec lui", async () => {
    const copy: FrameIdentity = { kind: "page", module: "notes", reference: "notes/liste@recette" };
    await handleFrameRequest(copy, "channels.read", { channel: "c1", after: 3, wait: 20, holder: "forgé" });
    await handleFrameRequest(copy, "channels.write", { channel: "c1", text: "ls" });
    await handleFrameRequest(copy, "channels.release", {});
    expect(native.invoke.mock.calls).toEqual([
      ["frame.channels.read", { subject: own, channel: "c1", after: 3, wait: 20, holder: "page:notes/liste@recette" }],
      ["frame.channels.write", { subject: own, channel: "c1", text: "ls" }],
      ["frame.channels.release", { subject: own, holder: "page:notes/liste@recette" }],
    ]);
  });
});
