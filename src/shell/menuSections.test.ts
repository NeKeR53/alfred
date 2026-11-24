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
import { entryTarget } from "./menuZones";
import { useShell } from "./store";

function page(reference: string): ResolvedPage {
  const [module, id] = reference.split("/");
  return {
    reference,
    module,
    id,
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
      pages: [page("projets/liste"), page("projets/projet")],
    },
  ],
  settingsPages: [],
  modules: [],
  functions: [],
  bindings: {},
  problems: [],
  layout: { sections: [] },
  createdSections: [{ module: "projets", id: "atlas", title: "Atlas", page: "projet" }],
};

const liste: FrameIdentity = { kind: "page", module: "projets", reference: "projets/liste" };
const subject = { kind: "page", module: "projets", reference: "projets/liste" };

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(null);
  useShell.setState({ snapshot, activeEntry: {} });
});

describe("sections créées (pont)", () => {
  it("crée une section au nom du cadre ; ses entrées ouvrent par défaut la page qui l’a créée", async () => {
    await handleFrameRequest(liste, "menu.sections", {
      op: "add",
      id: "borea",
      title: "Boréa",
      subject: { module: "x" },
    });
    expect(native.invoke).toHaveBeenCalledWith("frame.menuSections.update", {
      op: "add",
      id: "borea",
      title: "Boréa",
      page: "liste",
      subject,
    });
    const fn: FrameIdentity = { kind: "function", module: "projets", reference: "projets/importer" };
    await handleFrameRequest(fn, "menu.sections", { op: "add", id: "b", title: "B" });
    expect(native.invoke.mock.calls[1][1]).not.toHaveProperty("page");
  });

  it("range les entrées d’une section dans sa zone, toujours celle du module du cadre", async () => {
    await handleFrameRequest(liste, "menu.update", { op: "setEntries", entries: [], section: "atlas" });
    expect(native.invoke).toHaveBeenCalledWith("frame.menuZones.update", {
      op: "setEntries",
      entries: [],
      subject,
      page: "section:projets/atlas",
    });
  });

  it("ouvre la page de la section, ou celle de l’entrée", () => {
    expect(entryTarget("section:projets/atlas", { id: "lot-1", label: "Lot 1" })).toBe("projets/projet");
    expect(entryTarget("section:projets/atlas", { id: "lot-1", label: "Lot 1", page: "liste" })).toBe("projets/liste");
  });

  it("dit à la page l’entrée ouverte et sa section", () => {
    useShell.setState({
      activeEntry: { "projets/projet": { id: "lot-1", label: "Lot 1", zone: "section:projets/atlas" } },
    });
    const projet: FrameIdentity = { kind: "page", module: "projets", reference: "projets/projet" };
    expect(frameContext(projet).entry).toEqual({ id: "lot-1", label: "Lot 1", section: "atlas" });
  });
});

describe("SDK", () => {
  it("envoie addSection, removeSection, listSections et la cible section", () => {
    const sent: FrameRequest[] = [];
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
      if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
    });
    void menu.addSection({ id: "atlas", title: "Atlas", page: "projet" });
    void menu.removeSection("atlas");
    void menu.listSections();
    void menu.setEntries([{ id: "lot-1", label: "Lot 1" }], { section: "atlas" });
    expect(sent.map((request) => [request.method, request.params])).toEqual([
      ["menu.sections", { op: "add", id: "atlas", title: "Atlas", page: "projet" }],
      ["menu.sections", { op: "remove", id: "atlas" }],
      ["menu.sections", { op: "list" }],
      ["menu.update", { op: "setEntries", entries: [{ id: "lot-1", label: "Lot 1" }], section: "atlas" }],
    ]);
    spy.mockRestore();
  });
});
