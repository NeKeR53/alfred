import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
});

import type { ConversationRuntime } from "./model";
import { conversationState } from "./summary";

const runtime = (patch: Partial<ConversationRuntime> = {}): ConversationRuntime => ({
  status: "idle",
  approvals: [],
  questions: [],
  queued: [],
  ...patch,
});

describe("état visible d’une conversation", () => {
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
