/**
 * S7 côté coquille : notifications à actions et persistantes, fenêtres ouvertes sur un élément précis (paramètres,
 * clé, titre, entrée du menu), et rythme à la seconde des planifications.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cadence } from "../features/schedules/api";
import { openPageWindow } from "../lib/native";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { frameContext, frameServices, handleFrameRequest } from "./frameBridge";
import { useMenuZones } from "./menuZones";
import { NotificationBell } from "./NotificationCenter";
import { useNotifications } from "./notifications";
import { PageWindow } from "./PageWindow";
import { runZoneAction } from "./PageZones";
import { useShell } from "./store";

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../lib/native", () => ({
  invoke: vi.fn(async () => null),
  onNativeEvent: vi.fn(() => () => undefined),
  frameBase: (base: string) => base,
  inTauri: true,
  openPageWindow: vi.fn(async () => undefined),
  notifySystem: vi.fn(async () => false),
  AlfredError: class extends Error {
    constructor({ message }: { message: string }) {
      super(message);
    }
  },
}));

const page = (module: string, id: string, title: string): ResolvedPage => ({
  reference: `${module}/${id}`,
  module,
  id,
  title,
  icon: null,
  description: "",
  hidden: false,
  readOnly: false,
  missing: true,
  errors: [],
  uses: {},
  panel: null,
});

const snapshot: Snapshot = {
  path: "/espace",
  name: "Espace",
  accent: null,
  sections: [
    {
      id: "ci/principal",
      module: "ci",
      label: "CI",
      icon: "workflow",
      color: null,
      hidden: false,
      pages: [page("ci", "executions", "Exécutions"), page("ci", "journal", "Journal")],
    },
  ],
  settingsPages: [],
  modules: [],
  functions: [],
  bindings: {},
  problems: [],
  layout: { sections: [] },
};

const sonde = { kind: "function" as const, module: "ci", reference: "ci/sonder" };
const opened = vi.mocked(openPageWindow);

beforeEach(() => {
  useShell.setState({ snapshot, view: { kind: "agent" }, activeTab: {}, activeEntry: {} });
  useNotifications.setState({ items: [], toasts: [] });
  useMenuZones.setState({
    zones: { "ci/executions": { order: "page", entries: [{ id: "build-42", label: "Build #42" }] } },
  });
  opened.mockClear();
  delete (window as { __ALFRED_PAGE_WINDOW__?: unknown }).__ALFRED_PAGE_WINDOW__;
});

describe("notifications à actions", () => {
  it("une fonction planifiée notifie avec « Journal » et « Relancer », gardés dans la cloche", async () => {
    const calls: unknown[] = [];
    frameServices.callFunction = async (_identity, reference, input) => {
      calls.push([reference, input]);
      return null;
    };
    await handleFrameRequest(sonde, "shell.notify", {
      title: "Build #42 en échec",
      tone: "error",
      persistent: true,
      actions: [
        { label: "Journal", window: { page: "journal", params: { build: 42 }, title: "Build #42" } },
        { label: "Relancer", function: { id: "relancer", input: { build: 42 } } },
      ],
    });
    const [item] = useNotifications.getState().items;
    expect(item.persistent).toBe(true);
    expect([item.action?.label, ...(item.actions ?? []).map((action) => action.label)]).toEqual([
      "Journal",
      "Relancer",
    ]);

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    const row = screen.getByText("Build #42 en échec").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Journal" }));
    expect(opened).toHaveBeenCalledWith("ci/journal", { params: { build: 42 }, title: "Build #42" });

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(
      within(screen.getByText("Build #42 en échec").closest("li") as HTMLElement).getByRole("button", {
        name: "Relancer",
      }),
    );
    expect(calls).toEqual([["ci/relancer", { build: 42 }]]);
  });

  it("ouvre une page sur l’entrée de sa zone", async () => {
    await handleFrameRequest(sonde, "shell.notify", {
      title: "Build #42 terminé",
      actions: [{ label: "Voir", navigate: "executions", entry: "build-42" }],
    });
    useNotifications.getState().items[0].action?.run();
    const state = useShell.getState();
    expect(state.view).toEqual({ kind: "section", id: "ci/principal" });
    expect(state.activeEntry["ci/executions"]).toEqual({ id: "build-42", label: "Build #42", zone: "ci/executions" });
  });

  it("refuse une action mal formée, sans rien notifier", async () => {
    const refused = [
      [{ label: "A", navigate: "absente" }],
      [{ label: "A", function: { id: "autre/fonction" } }],
      [{ label: "", navigate: "journal" }],
      [{ label: "A" }],
      [
        { label: "A", navigate: "journal" },
        { label: "B", navigate: "journal" },
        { label: "C", navigate: "journal" },
      ],
      [{ label: "A", window: { page: "journal", params: [1] } }],
    ];
    for (const actions of refused)
      await expect(handleFrameRequest(sonde, "shell.notify", { title: "x", actions })).rejects.toThrow();
    expect(useNotifications.getState().items).toEqual([]);
  });
});

describe("fenêtres sur un élément précis", () => {
  const journal = { kind: "page" as const, module: "ci", reference: "ci/executions" };

  it("passe paramètres, clé et titre à la fenêtre", async () => {
    await handleFrameRequest(journal, "shell.openWindow", {
      reference: "journal",
      params: { build: 42 },
      key: "build-42",
      title: "Build #42",
    });
    expect(opened).toHaveBeenCalledWith("ci/journal", { params: { build: 42 }, key: "build-42", title: "Build #42" });
    await handleFrameRequest(journal, "shell.openWindow", {});
    expect(opened).toHaveBeenLastCalledWith("ci/executions", {});
    await expect(
      handleFrameRequest(journal, "shell.openWindow", { reference: "journal", params: "x" }),
    ).rejects.toThrow(/objet/);
  });

  it("la page de la fenêtre lit ses paramètres ; une autre page non", () => {
    (window as { __ALFRED_PAGE_WINDOW__?: unknown }).__ALFRED_PAGE_WINDOW__ = {
      reference: "ci/journal",
      params: { build: 42 },
    };
    expect(frameContext({ kind: "page", module: "ci", reference: "ci/journal" }).params).toEqual({ build: 42 });
    expect(frameContext({ kind: "panel", module: "ci", reference: "ci/detail", host: "ci/journal" }).params).toEqual({
      build: 42,
    });
    expect(frameContext({ kind: "page", module: "ci", reference: "ci/executions" }).params).toBeNull();
    expect(frameContext(sonde).params).toBeNull();
  });

  it("« Ouvrir dans une fenêtre » d’une entrée ouvre sa page sur l’entrée, une fenêtre par entrée", () => {
    runZoneAction("ci/executions", { id: "build-42", label: "Build #42" }, "window");
    expect(opened).toHaveBeenCalledWith("ci/executions", {
      params: { entry: { id: "build-42", label: "Build #42", zone: "ci/executions" } },
      key: "entry:ci/executions:build-42",
      title: "Build #42",
    });
  });

  it("une fenêtre ouverte sur une entrée la donne à sa page", () => {
    (window as { __ALFRED_PAGE_WINDOW__?: unknown }).__ALFRED_PAGE_WINDOW__ = {
      reference: "ci/executions",
      params: { entry: { id: "build-42", label: "Build #42", zone: "ci/executions" } },
    };
    render(<PageWindow reference="ci/executions" />);
    expect(useShell.getState().activeEntry["ci/executions"]).toEqual({
      id: "build-42",
      label: "Build #42",
      zone: "ci/executions",
    });
  });
});

describe("relevés rapprochés", () => {
  it("dit le rythme en secondes", () => {
    expect(cadence({ everyMinutes: null, everySeconds: 10, at: null })).toBe("toutes les 10 secondes");
    expect(cadence({ everyMinutes: 15, at: null })).toBe("toutes les 15 minutes");
  });
});
