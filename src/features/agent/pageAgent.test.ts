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
    update: vi.fn(),
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
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === "frame.agents.authorize" ? { cwd: "/espace/modules/notes", autonomy: "workspace" } : null,
    );
  mocks.agents.create.mockClear();
  mocks.agents.update.mockClear();
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
  it("demande l’accord, fixe le périmètre, le dossier et le mode avant d’envoyer la consigne", async () => {
    await frameServices.startAgent?.(page, {
      instruction: "Classe les notes",
      functions: ["classer", "banque/exporter", { name: "lire", input: { produit: "alpha" } }],
    });
    expect(mocks.invoke).toHaveBeenCalledWith("frame.agents.authorize", {
      subject: { kind: "page", module: "notes", reference: "notes/liste" },
      conversation: "conv-1",
      functions: ["notes/classer", "banque/exporter", { name: "notes/lire", input: { produit: "alpha" } }],
    });
    // Le dossier et l’autonomie sont ceux que Rust a vérifiés.
    expect(mocks.agents.update).toHaveBeenCalledWith("conv-1", { cwd: "/espace/modules/notes", autonomy: "workspace" });
    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("agents.allowFunctions");
    const authorized = mocks.invoke.mock.invocationCallOrder[commands.indexOf("frame.agents.authorize")];
    expect(authorized).toBeLessThan(mocks.agents.send.mock.invocationCallOrder[0]);
  });

  it("désigne la coordinatrice lancée par la page", async () => {
    await frameServices.startAgent?.(page, { instruction: "Répartis", coordinator: true });
    expect(mocks.invoke).toHaveBeenCalledWith("agents.coordinator.set", {
      conversation: "conv-1",
      on: true,
      cwd: "/espace/modules/notes",
      maxMode: "espace-de-travail",
    });
    expect(mocks.agents.update).toHaveBeenCalledWith("conv-1", { coordinator: true });
  });

  it("transmet le dossier accordé et le mode complet", async () => {
    await frameServices.startAgent?.(page, {
      instruction: "Corrige le test",
      folder: { id: "depot", path: "web" },
      mode: "complet",
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "frame.agents.authorize",
      expect.objectContaining({ folder: { id: "depot", path: "web" }, mode: "complet" }),
    );
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
