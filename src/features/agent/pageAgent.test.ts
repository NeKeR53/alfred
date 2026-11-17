import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  const conversation = { id: "conv-1", provider: "claude" };
  const agents = {
    ready: true,
    defaults: { provider: "claude", autonomy: "ask", models: { claude: { model: "sonnet", effort: "low" } } },
    load: vi.fn(),
    create: vi.fn(() => conversation),
    remove: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
  return { invoke: vi.fn(), agents, conversation };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: mocks.invoke,
}));
vi.mock("./store", () => ({
  useAgents: { getState: () => mocks.agents },
  bindAgentQuestions: vi.fn(),
  waitForTurn: vi.fn(async () => ({ status: "done", items: [] })),
}));

import { type FrameIdentity, frameServices } from "../../shell/frameBridge";
import { bindPageAi } from "./pageAgent";
import { useAgentPreferences } from "./panel/ModelPicker";

const page: FrameIdentity = { kind: "page", module: "notes", reference: "notes/liste" };

beforeEach(() => {
  bindPageAi();
  mocks.invoke.mockReset().mockResolvedValue(null);
  mocks.agents.create.mockClear();
  setPageModel(null);
});

const setPageModel = (pageModel: { provider: "claude" | "codex"; model?: string; effort?: string } | null) =>
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel, textEditor: null },
    status: "ready",
  });
const journal = () =>
  mocks.invoke.mock.calls.filter(([command]) => command === "journal.record").map(([, args]) => args);

describe("agent lancé par une page", () => {
  it("demande l’accord, fixe le périmètre et impose l’autonomie stricte avant d’envoyer la consigne", async () => {
    await frameServices.startAgent?.(page, {
      instruction: "Classe les notes",
      functions: ["classer", "banque/exporter"],
    });
    expect(mocks.agents.create).toHaveBeenCalledWith(expect.objectContaining({ autonomy: "strict" }));
    expect(mocks.invoke).toHaveBeenCalledWith("frame.agents.authorize", {
      subject: { kind: "page", module: "notes", reference: "notes/liste" },
      conversation: "conv-1",
      functions: ["notes/classer", "banque/exporter"],
    });
    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("agents.allowFunctions");
    const authorized = mocks.invoke.mock.invocationCallOrder[commands.indexOf("frame.agents.authorize")];
    expect(authorized).toBeLessThan(mocks.agents.send.mock.invocationCallOrder[0]);
  });

  it("n’envoie rien et retire la conversation si l’utilisateur refuse", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "frame.agents.authorize") throw new Error("Accès refusé");
      return null;
    });
    await expect(frameServices.startAgent?.(page, { instruction: "Exporte tout" })).rejects.toThrow("Accès refusé");
    expect(mocks.agents.send).not.toHaveBeenCalled();
    expect(mocks.agents.remove).toHaveBeenCalledWith("conv-1");
  });

  it("ouvre la conversation avec le modèle de l’agent, « Comme l’agent » par défaut", async () => {
    await frameServices.startAgent?.(page, { instruction: "Classe les notes" });
    expect(mocks.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", model: "sonnet", effort: "low" }),
    );
    expect(journal()).toEqual([
      expect.objectContaining({
        kind: "agent",
        ok: true,
        summary: "Conversation d’agent via Claude Code · sonnet",
        detail: expect.objectContaining({ provider: "claude", model: "sonnet", conversation: "conv-1" }),
      }),
    ]);
  });

  it("ouvre la conversation avec le modèle réglé pour les pages", async () => {
    setPageModel({ provider: "codex", model: "gpt-5", effort: "high" });
    await frameServices.startAgent?.(page, { instruction: "Classe les notes" });
    expect(mocks.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", model: "gpt-5", effort: "high" }),
    );
    expect(journal()).toEqual([expect.objectContaining({ summary: "Conversation d’agent via Codex · gpt-5" })]);
  });
});
