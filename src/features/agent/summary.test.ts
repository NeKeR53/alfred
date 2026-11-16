import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
});

import { agentEntryLabel } from "../../shell/AppShell";
import type { ConversationRuntime } from "./model";
import { agentSummary, conversationState } from "./summary";

const runtime = (patch: Partial<ConversationRuntime> = {}): ConversationRuntime => ({
  status: "idle",
  approvals: [],
  questions: [],
  queued: [],
  ...patch,
});

describe("état visible d’une conversation", () => {
  it("une question bloquante en fin de réponse attend l’utilisateur, lue ou non, tant que la file est vide", () => {
    const asking = { unread: false, lastStatus: "done" as const, pendingQuestion: "Quelle couleur ?" };
    expect(conversationState(asking, runtime())).toBe("attention");
    expect(conversationState(asking, undefined)).toBe("attention");
    expect(conversationState(asking, runtime({ status: "connecting" }))).toBe("working");
    const queued = [{ id: "q", message: { text: "x", attachments: [], contexts: [] } }];
    expect(conversationState(asking, runtime({ queued }))).toBe("waiting");
  });

  it("suit l’ordre de OneApp", () => {
    const approval = { id: "a", title: "x", options: [] };
    expect(conversationState({ unread: false }, runtime({ status: "responding", approvals: [approval] }))).toBe(
      "attention",
    );
    expect(conversationState({ unread: true }, runtime({ status: "connecting" }))).toBe("working");
    expect(conversationState({ unread: false, lastStatus: "running" }, undefined)).toBe("working");
    expect(
      conversationState(
        { unread: false, lastStatus: "error" },
        runtime({ queued: [{ id: "q", message: { text: "x", attachments: [], contexts: [] } }] }),
      ),
    ).toBe("waiting");
    expect(conversationState({ unread: true, lastStatus: "done" }, runtime())).toBe("done");
    expect(conversationState({ unread: false, lastStatus: "done" }, runtime())).toBe("idle");
  });

  it("compte un tour arrêté non lu comme un échec", () => {
    expect(conversationState({ unread: true, lastStatus: "cancelled" }, undefined)).toBe("error");
    expect(conversationState({ unread: true, lastStatus: "error" }, undefined)).toBe("error");
    expect(conversationState({ unread: false, lastStatus: "cancelled" }, undefined)).toBe("idle");
  });
});

describe("entrée Agent du menu", () => {
  it("la pastille montre l’état prioritaire, le libellé cite tous les compteurs comme dans OneApp", () => {
    const summary = agentSummary(["attention", "working", "waiting", "done", "error", "idle"]);
    expect(summary).toMatchObject({ state: "attention", count: 1 });
    expect(agentEntryLabel(summary)).toBe("Agent · 1 réponse attendue · Activité en cours · 2 à consulter");
    expect(agentEntryLabel(agentSummary(["working"]))).toBe("Agent · Activité en cours");
    expect(agentEntryLabel(agentSummary(["done", "done"]))).toBe("Agent · 2 à consulter");
    expect(agentEntryLabel(agentSummary(["idle"]))).toBe("Agent");
  });
});
