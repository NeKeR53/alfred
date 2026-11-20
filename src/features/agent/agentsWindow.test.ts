import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: vi.fn(async () => null),
  onNativeEvent: vi.fn(() => () => undefined),
}));

type Module = typeof import("./agentsWindow");
type Store = typeof import("./store");
type Message = { name: string; payload: unknown };

/** Deux bouts reliés : ce que l’un envoie, l’autre le reçoit, dans l’ordre et après coup. */
function pair() {
  const handlers: Array<Set<(message: Message) => void>> = [new Set(), new Set()];
  const end = (mine: number) => ({
    send: (name: string, payload: unknown) =>
      queueMicrotask(() => {
        for (const handler of handlers[1 - mine]) handler({ name, payload: structuredClone(payload) });
      }),
    listen: (handler: (message: Message) => void) => {
      handlers[mine].add(handler);
      return () => handlers[mine].delete(handler);
    },
  });
  return [end(0), end(1)] as const;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 120));

/** Deux fenêtres : chacune a ses propres modules, donc son propre magasin. */
async function windows() {
  vi.resetModules();
  const main = { window: (await import("./agentsWindow")) as Module, store: (await import("./store")) as Store };
  vi.resetModules();
  const detached = { window: (await import("./agentsWindow")) as Module, store: (await import("./store")) as Store };
  return { main, detached };
}

describe("fenêtre Agent détachée", () => {
  beforeEach(() => vi.useRealTimers());

  it("affiche les conversations de la principale et lui transmet les actions, sans changer sa conversation ouverte", async () => {
    const { main, detached } = await windows();
    expect(main.store.useAgents).not.toBe(detached.store.useAgents);
    const [mainEnd, detachedEnd] = pair();
    main.store.useAgents.setState({ ready: true });
    const first = main.store.useAgents.getState().create({ title: "Préparer la recette" });
    await main.store.useAgents.getState().open(first.id);
    const sent: unknown[][] = [];
    main.store.useAgents.setState({
      send: async (...args: unknown[]) => {
        sent.push(args);
      },
    } as never);
    const stopServing = await main.window.serveAgentsWindow(mainEnd);
    detached.window.mirrorAgents(detachedEnd);
    await flush();

    // L’état arrive dans le miroir ; la conversation ouverte de la principale ne le suit pas.
    const mirror = detached.store.useAgents;
    expect(mirror.getState().headers.map((header) => header.title)).toEqual(["Préparer la recette"]);
    expect(mirror.getState().activeId).toBeNull();

    // Une conversation créée dans la fenêtre détachée existe aussitôt chez elle, puis dans la principale.
    const second = mirror.getState().create({ title: "Liste de courses" });
    expect(mirror.getState().loaded[second.id]).toBeDefined();
    await mirror.getState().open(second.id);
    await flush();
    expect(main.store.useAgents.getState().loaded[second.id]?.title).toBe("Liste de courses");
    expect(main.store.useAgents.getState().activeId).toBe(first.id);
    expect(mirror.getState().activeId).toBe(second.id);

    // Un message part par la principale, propriétaire de la session.
    await mirror.getState().send(second.id, { text: "Bonjour", attachments: [], contexts: [] });
    expect(sent).toEqual([[second.id, { text: "Bonjour", attachments: [], contexts: [] }]]);

    // Un renommage dans la principale se voit dans le miroir.
    main.store.useAgents.getState().update(first.id, { title: "Recette du dimanche" });
    await flush();
    expect(mirror.getState().headers.find((header) => header.id === first.id)?.title).toBe("Recette du dimanche");

    // Une action refusée par la principale rejette dans la fenêtre détachée.
    main.store.useAgents.setState({
      cancel: async () => {
        throw new Error("Rien à arrêter.");
      },
    } as never);
    await expect(mirror.getState().cancel(second.id)).rejects.toThrow("Rien à arrêter.");
    stopServing();
  });

  it("ne publie que ce qui a changé", async () => {
    const { main } = await windows();
    const state = main.store.useAgents.getState();
    const conversation = state.create({ title: "A" });
    const before = main.store.useAgents.getState();
    const full = main.window.diffState(before, undefined);
    expect(full.full).toBe(true);
    main.store.useAgents.getState().update(conversation.id, { title: "B" });
    const after = main.store.useAgents.getState();
    const patch = main.window.diffState(after, before);
    expect(Object.keys(patch.loaded)).toEqual([conversation.id]);
    expect(Object.keys(patch.shared)).toContain("headers");
    expect(patch.shared).not.toHaveProperty("defaults");
    const applied = main.window.applyPatch(before, { shared: {}, loaded: {}, removed: [conversation.id] });
    expect(applied.loaded).toEqual({});
  });
});
