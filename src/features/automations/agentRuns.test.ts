import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

const created: Array<Record<string, unknown>> = [];
const sent: Array<{ id: string; message: { text: string; contexts: Array<{ title: string; text: string }> } }> = [];
const cancelled: string[] = [];
let finish: ((turn: unknown) => void) | undefined;

vi.mock("../agent/store", () => ({
  useAgents: {
    getState: () => ({
      create: (options: Record<string, unknown>) => {
        created.push(options);
        return { id: options.id };
      },
      send: async (id: string, message: { text: string; contexts: Array<{ title: string; text: string }> }) => {
        sent.push({ id, message });
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

import { type AgentRunRequest, runAgentRequest } from "./agentRuns";

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
