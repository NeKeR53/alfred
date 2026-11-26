import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agents = {
    loaded: {} as Record<string, { id: string; provider: string; coordinator?: boolean; archived: boolean }>,
    create: vi.fn((options: Record<string, unknown>) => ({ id: `delegue-${String(options.title)}`, ...options })),
    update: vi.fn(),
    send: vi.fn(async () => undefined),
    ensureLoaded: vi.fn(async () => undefined),
  };
  return { invoke: vi.fn(), agents };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: mocks.invoke,
}));
vi.mock("./store", () => ({
  useAgents: { getState: () => mocks.agents },
  waitForTurn: vi.fn(async () => ({ status: "done", items: [] })),
}));

import { runReadyTasks } from "./delegation";
import { listModels } from "./harness";
import { modelChoiceLabel } from "./panel/ModelPicker";

/** Une tâche prête, telle que `agents.tasks.claim` la rend. */
const claimed = (harness: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  coordinator: "coord",
  key: "documents",
  goal: "Base documentaire",
  cwd: "/espace",
  autonomy: "workspace",
  ...harness,
});

const launch = async (harness: Record<string, unknown>) => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "agents.tasks.claim") return [claimed(harness)];
    if (command === "agents.tasks.report") return { coordinator: "coord", message: "Rapport" };
    return null;
  });
  await runReadyTasks();
  const [options] = mocks.agents.create.mock.calls[0] ?? [];
  const [, patch] = mocks.agents.update.mock.calls.find(([, change]) => "parent" in change) ?? [];
  return { options, patch };
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.agents.create.mockClear();
  mocks.agents.update.mockClear();
  mocks.agents.loaded = { coord: { id: "coord", provider: "codex", coordinator: true, archived: true } };
});

describe("conversation d’un délégué", () => {
  it("prend le harnais, le modèle et l’effort de la coordinatrice", async () => {
    const { options, patch } = await launch({ provider: "claude", model: "opus", effort: "high", inherited: true });
    expect(options).toMatchObject({ title: "documents · délégué", provider: "claude", model: "opus", effort: "high" });
    expect(patch).toStrictEqual({ parent: "coord", taskKey: "documents", model: "opus", effort: "high" });
    // Sous la saisie du délégué, la page Agent affiche ce modèle, et non « Claude Code · modèle par défaut ».
    expect(modelChoiceLabel({ ...options, ...patch }, await listModels("claude", "/espace"))).toBe("Opus · élevé");
  });

  it("garde le modèle par défaut du CLI repris de la coordinatrice, sans les choix des réglages", async () => {
    const { options, patch } = await launch({ provider: "claude", model: null, effort: null, inherited: true });
    expect(options).not.toHaveProperty("model");
    // Le modèle et l’effort par défaut du réglage, posés par `create`, sont effacés.
    expect(patch).toStrictEqual({ parent: "coord", taskKey: "documents", model: undefined, effort: undefined });
  });

  it("prend ce que la tâche précise ; le reste suit les choix des réglages", async () => {
    const { options, patch } = await launch({ provider: "claude", model: "sonnet", effort: null, inherited: false });
    expect(options).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(options).not.toHaveProperty("effort");
    expect(patch).toStrictEqual({ parent: "coord", taskKey: "documents" });
  });

  it("reprend au moins le harnais de la coordinatrice quand Rust ne le connaît pas", async () => {
    const { options } = await launch({ provider: null, model: null, inherited: false });
    expect(options).toMatchObject({ provider: "codex" });
  });
});
