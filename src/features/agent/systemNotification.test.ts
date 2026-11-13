import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppInfo, Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { createSession, type HarnessEvent, type HarnessSession, type SessionOptions } from "./harness";
import { useAgents } from "./store";
import { resetSystemNotification } from "./systemNotification";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), tauri: vi.fn(), inTauri: true };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
  get inTauri() {
    return native.inTauri;
  },
}));
// Le module de notifications de Tauri, tel que la fenêtre de l’application l’appelle.
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.tauri }));
vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  createSession: vi.fn(),
}));

let emit: (event: HarnessEvent) => void;
let focused: boolean;

beforeEach(() => {
  native.inTauri = true;
  focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  resetSystemNotification();
  native.invoke.mockImplementation(async (command: string) => (command === "space.commit" ? { commit: null } : null));
  native.tauri.mockImplementation(async (command: string) =>
    command === "plugin:notification|is_permission_granted" ? true : null,
  );
  vi.mocked(createSession).mockImplementation(async (options: SessionOptions) => {
    emit = (event) => options.onEvent(event);
    const noop = vi.fn(async () => undefined) as Mock;
    return { send: noop, steer: noop, answer: noop, cancel: noop, close: noop } as unknown as HarnessSession;
  });
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
    info: { serverPort: 4100 } as AppInfo,
    view: { kind: "agent" },
  });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: true });
});

const notifications = () =>
  native.tauri.mock.calls.filter(([command]) => command === "plugin:notification|notify").map(([, args]) => args);

async function turn(text: string, reply: string) {
  const { id } = useAgents.getState().create({ provider: "claude", autonomy: "ask" });
  useAgents.setState({ activeId: id });
  await useAgents.getState().send(id, { text, attachments: [], contexts: [] });
  emit({ type: "status", status: "responding" });
  return {
    id,
    finish: async () => {
      emit({ type: "message", itemId: "m1", content: reply, replace: true });
      emit({ type: "status", status: "idle" });
      await vi.waitFor(() => expect(useAgents.getState().loaded[id]?.turns.at(-1)?.status).toBe("done"));
    },
  };
}

describe("notification du système", () => {
  it("prévient quand l’agent attend un accord puis termine, fenêtre en arrière-plan", async () => {
    const { finish } = await turn("Ajoute une page Factures", "Page Factures créée.");
    emit({
      type: "approval",
      request: { id: "a1", kind: "command", title: "Exécuter une commande", options: [] },
    } as HarnessEvent);
    await vi.waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0]).toEqual({
      options: { title: "Ajoute une page Factures attend votre accord", body: "Exécuter une commande" },
    });

    await finish();
    await vi.waitFor(() => expect(notifications()).toHaveLength(2));
    expect(notifications()[1]).toEqual({
      options: { title: "Ajoute une page Factures : l’agent a terminé", body: "Page Factures créée." },
    });
  });

  it("se tait quand la fenêtre est au premier plan, et en mode navigateur", async () => {
    focused = true;
    await (await turn("Premier", "Fait.")).finish();
    focused = false;
    native.inTauri = false;
    await (await turn("Second", "Fait.")).finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications()).toEqual([]);
  });

  it("ne notifie pas sans la permission du système", async () => {
    native.tauri.mockImplementation(async (command: string) =>
      command === "plugin:notification|is_permission_granted"
        ? null
        : command === "plugin:notification|request_permission"
          ? "denied"
          : null,
    );
    await (await turn("Troisième", "Fait.")).finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.tauri).toHaveBeenCalledWith("plugin:notification|request_permission");
    expect(notifications()).toEqual([]);
  });
});
