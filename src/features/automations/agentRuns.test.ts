import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

const created: Array<Record<string, unknown>> = [];
const sent: Array<{ id: string; message: { text: string; contexts: Array<{ title: string; text: string }> } }> = [];
const cancelled: string[] = [];
let finish: ((turn: unknown) => void) | undefined;
const loaded: Record<string, { archived: boolean; turns: Array<{ id: string }> }> = {};
const listeners = new Set<(state: { loaded: typeof loaded }) => void>();
const queued: string[] = [];
let sentOptions: unknown;
const runtime: Record<string, { status: string; queued: unknown[] }> = {};

vi.mock("../agent/store", () => ({
  useAgents: {
    subscribe: (listener: (state: { loaded: typeof loaded }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({
      loaded,
      runtime,
      ensureLoaded: async () => undefined,
      unqueue: (_id: string, queuedId: string) => {
        const index = queued.indexOf(queuedId);
        if (index < 0) return undefined;
        queued.splice(index, 1);
        return {};
      },
      create: (options: Record<string, unknown>) => {
        created.push(options);
        return { id: options.id };
      },
      send: async (
        id: string,
        message: { text: string; contexts: Array<{ title: string; text: string }> },
        options?: { messageId?: string },
      ) => {
        sent.push({ id, message });
        sentOptions = options;
        if (options?.messageId) queued.push(options.messageId);
      },
      cancel: async (id: string) => {
        cancelled.push(id);
      },
    }),
  },
  waitForTurn: () =>
    new Promise((resolve) => {
      finish = resolve;
    }),
}));

vi.mock("../agent/model", () => ({
  lastAssistantText: (turn: { text: string }) => turn.text,
}));

import { invoke } from "../../lib/native";
import { type AgentRunRequest, runAgentRequest, runsHere } from "./agentRuns";

const request: AgentRunRequest = {
  requestId: "r1",
  conversation: "auto-1",
  automation: "relances",
  name: "Relances",
  cwd: "/espace/.alfred/automations/relances",
  text: "Relance les impayés.\n\nPersonne ne regarde.",
  context: { from: "outils/echo", data: { client: "acme" } },
  maxMinutes: 5,
};

beforeEach(() => {
  queued.length = 0;
  for (const key of Object.keys(loaded)) delete loaded[key];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  created.length = 0;
  sent.length = 0;
  cancelled.length = 0;
  finish = undefined;
});

it("ouvre une conversation neuve, marquée par l’automatisation, et rend son dernier message", async () => {
  const never = () => new Promise<void>(() => undefined);
  const running = runAgentRequest(request, never);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(created[0]).toMatchObject({
    id: "auto-1",
    title: "Relances · automatisation",
    cwd: "/espace/.alfred/automations/relances",
    autonomy: "workspace",
    origin: { reference: "automation:relances", title: "l’automatisation « Relances »" },
  });
  expect(sent[0]?.message.text).toBe(request.text);
  expect(sent[0]?.message.contexts[0]?.title).toBe("Données du déclencheur");
  expect(JSON.parse(sent[0]?.message.contexts[0]?.text ?? "null")).toEqual(request.context);
  finish?.({ status: "done", text: "Trois relances envoyées." });
  expect(await running).toEqual({ conversation: "auto-1", status: "done", text: "Trois relances envoyées." });
});

it("arrête la conversation à la durée maximale", async () => {
  let elapsed: number | undefined;
  const answer = await runAgentRequest(request, async (ms) => {
    elapsed = ms;
  });
  expect(elapsed).toBe(5 * 60_000);
  expect(answer).toEqual({ conversation: "auto-1", status: "timeout", text: "" });
  expect(cancelled).toEqual(["auto-1"]);
});

const existing: AgentRunRequest = {
  ...request,
  requestId: "r2",
  conversation: "conv-test",
  existing: true,
  title: "Conversation d’essai",
  cwd: undefined,
};

it("poste dans une conversation existante, attend son tour, et ne pose le périmètre que pendant ce tour", async () => {
  loaded["conv-test"] = { archived: false, turns: [{ id: "tour-utilisateur" }] };
  const never = () => new Promise<void>(() => undefined);
  const running = runAgentRequest(existing, never);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(created).toHaveLength(0);
  expect(sent[0]?.id).toBe("conv-test");
  expect(sent[0]?.message.text.startsWith("Depuis l’automatisation « Relances » :")).toBe(true);
  expect(sentOptions).toEqual({ messageId: "automation-r2" });
  // Le tour de l’utilisateur finit d’abord : le passage attend le sien.
  finish?.({ id: "tour-utilisateur", status: "done", text: "autre" });
  await Promise.resolve();
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("automations.agentScope", expect.anything());
  // Son tour commence : le périmètre est posé ; il finit : le périmètre est rendu.
  loaded["conv-test"].turns.push({ id: "automation-r2" });
  for (const listener of listeners) listener({ loaded });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("automations.agentScope", {
      conversation: "conv-test",
      automation: "relances",
      on: true,
    }),
  );
  finish?.({ id: "automation-r2", status: "done", text: "Noté." });
  expect(await running).toEqual({ conversation: "conv-test", status: "done", text: "Noté." });
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("automations.agentScope", {
    conversation: "conv-test",
    automation: "relances",
    on: false,
  });
});

it("sort le message de la file à la durée maximale, sans toucher au tour de l’utilisateur", async () => {
  loaded["conv-test"] = { archived: false, turns: [{ id: "tour-utilisateur" }] };
  const answer = await runAgentRequest(existing, async () => undefined);
  expect(answer.status).toBe("timeout");
  expect(queued).toEqual([]);
  expect(cancelled).toEqual([]);
});

it("échoue clairement sur une conversation archivée ou supprimée", async () => {
  loaded["conv-test"] = { archived: true, turns: [] };
  expect(await runAgentRequest(existing)).toEqual({
    conversation: "conv-test",
    status: "gone",
    text: "",
    error: "Passage impossible : la conversation « Conversation d’essai » est archivée.",
  });
  delete loaded["conv-test"];
  expect((await runAgentRequest(existing)).error).toContain("a été supprimée");
  expect(sent).toHaveLength(0);
});

it("reconnaît la fenêtre où la conversation tourne", () => {
  // Un tour enregistré « en cours » ne suffit pas : il peut tourner dans une autre fenêtre.
  loaded["conv-test"] = { archived: false, turns: [{ id: "t1", status: "running" } as { id: string }] };
  expect(runsHere("conv-test")).toBe(false);
  runtime["conv-test"] = { status: "running", queued: [] };
  expect(runsHere("conv-test")).toBe(true);
  runtime["conv-test"] = { status: "idle", queued: [{}] };
  expect(runsHere("conv-test")).toBe(true);
  delete runtime["conv-test"];
});
