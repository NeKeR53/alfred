import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
}));

import type { ResolvedPage, Snapshot } from "../lib/types";
import { menu } from "../sdk";
import type { FrameRequest } from "../sdk/protocol";
import { type FrameIdentity, frameContext, handleFrameRequest } from "./frameBridge";
import { useShell } from "./store";

function page(reference: string): ResolvedPage {
  const [module, id] = reference.split("/");
  return {
    reference,
    module,
    id: id.replace(/@.*$/, ""),
    title: id,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: true,
    errors: [],
    uses: {},
    panel: null,
  };
}

const snapshot: Snapshot = {
  path: "/espace",
  name: "Espace",
  accent: null,
  sections: [
    {
      id: "projets/principal",
      module: "projets",
      label: "Projets",
      icon: null,
      color: null,
      hidden: false,
      pages: [page("projets/liste")],
    },
    {
      id: "projets/principal@atlas",
      module: "projets",
      label: "Atlas",
      icon: "folder-kanban",
      color: null,
      hidden: false,
      created: "atlas",
      pages: [page("projets/projet@atlas"), page("projets/planning@atlas")],
    },
  ],
  settingsPages: [],
  modules: [],
  functions: [],
  bindings: {},
  problems: [],
  layout: { sections: [] },
};

const liste: FrameIdentity = { kind: "page", module: "projets", reference: "projets/liste" };
const subject = { kind: "page", module: "projets", reference: "projets/liste" };

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(null);
  useShell.setState({ snapshot });
});

describe("sections créées (pont)", () => {
  it("crée une section avec la page qui la demande, au nom du cadre", async () => {
    await handleFrameRequest(liste, "menu.sections", {
      op: "add",
      id: "borea",
      title: "Boréa",
      subject: { module: "banque" },
    });
    expect(native.invoke).toHaveBeenCalledWith("frame.menuSections.update", {
      op: "add",
      id: "borea",
      title: "Boréa",
      pages: ["projets/liste"],
      subject,
    });
  });

  it("transmet les pages nommées, une icône effacée, et laisse une fonction nommer ses pages", async () => {
    await handleFrameRequest(liste, "menu.sections", { op: "add", id: "a", title: "A", pages: ["projet", "planning"] });
    await handleFrameRequest(liste, "menu.sections", { op: "update", id: "a", icon: null });
    const fn: FrameIdentity = { kind: "function", module: "projets", reference: "projets/importer" };
    await handleFrameRequest(fn, "menu.sections", { op: "add", id: "b", title: "B" });
    const args = native.invoke.mock.calls.map(([, value]) => value as Record<string, unknown>);
    expect(args[0].pages).toEqual(["projet", "planning"]);
    expect(args[1]).toMatchObject({ op: "update", id: "a", icon: "" });
    expect(args[2].pages).toBeUndefined();
  });

  it("vise les entrées d’une section par son premier onglet, et refuse une section inconnue", async () => {
    await handleFrameRequest(liste, "menu.update", { op: "setEntries", entries: [], section: "atlas" });
    expect(native.invoke).toHaveBeenCalledWith("frame.menuZones.update", {
      op: "setEntries",
      entries: [],
      subject,
      page: "projets/projet@atlas",
    });
    await expect(
      handleFrameRequest(liste, "menu.update", { op: "setEntries", entries: [], section: "absente" }),
    ).rejects.toThrow(/n’existe pas/);
  });

  it("dit à la page la notion de sa section, et rien dans une section déclarée", () => {
    const projet: FrameIdentity = { kind: "page", module: "projets", reference: "projets/planning@atlas" };
    expect(frameContext(projet).section).toEqual({ id: "atlas", title: "Atlas" });
    const panel: FrameIdentity = {
      ...projet,
      kind: "panel",
      reference: "projets/detail@atlas",
      host: "projets/planning@atlas",
    };
    expect(frameContext(panel).section?.id).toBe("atlas");
    expect(frameContext(liste).section).toBeNull();
  });
});

describe("SDK", () => {
  it("envoie addSection, updateSection, removeSection, listSections et la cible section", () => {
    const sent: FrameRequest[] = [];
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
      if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
    });
    void menu.addSection({ id: "atlas", title: "Atlas", icon: "folder-kanban", pages: ["projet"] });
    void menu.updateSection("atlas", { title: "Projet Atlas" });
    void menu.removeSection("atlas");
    void menu.listSections();
    void menu.setEntries([{ id: "lot-1", label: "Lot 1" }], { section: "atlas" });
    expect(sent.map((request) => [request.method, request.params])).toEqual([
      ["menu.sections", { op: "add", id: "atlas", title: "Atlas", icon: "folder-kanban", pages: ["projet"] }],
      ["menu.sections", { op: "update", id: "atlas", title: "Projet Atlas" }],
      ["menu.sections", { op: "remove", id: "atlas" }],
      ["menu.sections", { op: "list" }],
      ["menu.update", { op: "setEntries", entries: [{ id: "lot-1", label: "Lot 1" }], section: "atlas" }],
    ]);
    spy.mockRestore();
  });
});
