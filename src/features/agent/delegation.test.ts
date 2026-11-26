import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agents = {
    loaded: {} as Record<
      string,
      { id: string; provider: string; coordinator?: boolean; archived: boolean; turns?: Record<string, unknown>[] }
    >,
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

import { RESUME_MESSAGE, RETURN_CONTRACT, runReadyTasks } from "./delegation";
import { listModels } from "./harness";
import { INTERFACE_ID } from "./harness/native";
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
  mocks.agents.send.mockClear();
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

/** Tâche à reprendre ou à rendre, telle que `agents.tasks.claim` la rend, et les appels faits à Rust. */
const resume = async (task: Record<string, unknown>) => {
  const reports: Record<string, unknown>[] = [];
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "agents.tasks.claim") return [{ ...claimed({}), conversation: "d1", launch: "resume", ...task }];
    if (command === "agents.tasks.report") {
      reports.push(args);
      return { coordinator: "coord", message: "Rapport" };
    }
    return null;
  });
  await runReadyTasks();
  return reports;
};

const turn = (status: string, content = "") => ({
  id: "t1",
  status,
  user: { text: "Base documentaire", attachments: [], contexts: [] },
  items: content ? [{ kind: "message", id: "m1", content }] : [],
  startedAt: 1,
});

describe("tâche interrompue (session du délégué fermée avant son rapport)", () => {
  it("réclame les tâches pour cette interface, avec celles qu’elle fait déjà avancer", async () => {
    mocks.invoke.mockResolvedValue([]);
    await runReadyTasks();
    expect(mocks.invoke).toHaveBeenCalledWith("agents.tasks.claim", { owner: INTERFACE_ID, busy: [] });
  });

  it("reprend le délégué dans sa conversation, avec le message de reprise, puis rend son contrat", async () => {
    mocks.agents.loaded.d1 = { id: "d1", provider: "claude", archived: false, turns: [turn("cancelled")] };
    const reports = await resume({});
    expect(mocks.agents.create).not.toHaveBeenCalled();
    expect(mocks.agents.send).toHaveBeenCalledWith("d1", {
      text: `${RESUME_MESSAGE}\n\n${RETURN_CONTRACT}`,
      attachments: [],
      contexts: [],
    });
    expect(reports).toHaveLength(1);
  });

  it("rend le contrat d’un délégué qui avait fini, sans le relancer", async () => {
    const done = 'Fait.\n```json\n{ "status": "success", "summary": "Base prête" }\n```';
    mocks.agents.loaded.d1 = { id: "d1", provider: "claude", archived: false, turns: [turn("done", done)] };
    const reports = await resume({});
    expect(mocks.agents.send).not.toHaveBeenCalledWith("d1", expect.anything());
    expect(reports[0]).toMatchObject({ contract: { status: "success", summary: "Base prête" } });
  });

  it("rend la tâche en échec quand la conversation du délégué est archivée", async () => {
    mocks.agents.loaded.d1 = { id: "d1", provider: "claude", archived: true, turns: [turn("cancelled")] };
    const reports = await resume({});
    expect(mocks.agents.send).not.toHaveBeenCalledWith("d1", expect.anything());
    expect(reports[0]).toMatchObject({ contract: { status: "failed" } });
  });

  it("dépose dans la coordinatrice le rapport d’une tâche qui a épuisé ses reprises", async () => {
    mocks.agents.loaded.coord.archived = false;
    const reports = await resume({ launch: "report", message: "Rapport de la tâche déléguée « documents » : failed." });
    expect(reports).toHaveLength(0);
    expect(mocks.agents.send).toHaveBeenCalledWith(
      "coord",
      { text: "Rapport de la tâche déléguée « documents » : failed.", attachments: [], contexts: [] },
      expect.objectContaining({ messageId: expect.stringMatching(/^task:/) }),
    );
  });
});
