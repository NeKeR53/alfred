import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  const conversation = { id: "conv-1", provider: "claude" };
  const agents = {
    ready: true,
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

const page: FrameIdentity = { kind: "page", module: "notes", reference: "notes/liste" };

beforeEach(() => {
  bindPageAi();
  mocks.invoke.mockReset().mockResolvedValue(null);
});

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
});
