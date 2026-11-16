import { describe, expect, it, vi } from "vitest";
import type { Turn, TurnItem } from "./model";
import { createSilenceWatch, DEFAULT_SILENCE_WATCH, silenceLimit, silenceMessage } from "./watchdog";

const turn = (items: TurnItem[]): Turn => ({
  id: "t",
  user: { text: "x", attachments: [], contexts: [] },
  items,
  status: "running",
  startedAt: 0,
});
const text = (id: string): TurnItem => ({ kind: "message", id, content: "…" });
const activity = (id: string, activityKind: "command" | "analysis", status: "running" | "completed"): TurnItem => ({
  kind: "activity",
  id,
  activityKind,
  title: "x",
  status,
});

describe("silence permis", () => {
  it("comme OneApp, un outil mis à jour après le dernier texte travaille encore", () => {
    const at = (item: TurnItem, occurredAt: number): TurnItem => ({ ...item, occurredAt });
    const items = [at(activity("c", "command", "running"), 20), at(text("m"), 10)];
    expect(silenceLimit(turn(items))).toBeUndefined();
    const older = [at(activity("c", "command", "running"), 5), at(text("m"), 10)];
    expect(silenceLimit(turn(older))).toBe(DEFAULT_SILENCE_WATCH.streamMs);
    // Une activité arrêtée par OneApp est close, comme une activité terminée.
    const stopped: TurnItem = { kind: "activity", id: "c", activityKind: "command", title: "x", status: "cancelled" };
    expect(silenceLimit(turn([stopped]))).toBe(DEFAULT_SILENCE_WATCH.thinkingMs);
  });

  it("3 min en pleine réponse, 15 min en réflexion, aucune limite pendant un outil", () => {
    expect(silenceLimit(turn([text("m")]))).toBe(DEFAULT_SILENCE_WATCH.streamMs);
    expect(silenceLimit(turn([]))).toBe(DEFAULT_SILENCE_WATCH.thinkingMs);
    expect(silenceLimit(turn([text("m"), activity("a", "analysis", "running")]))).toBe(
      DEFAULT_SILENCE_WATCH.thinkingMs,
    );
    expect(silenceLimit(turn([text("m"), activity("c", "command", "running")]))).toBeUndefined();
    expect(silenceLimit(turn([activity("c", "command", "completed")]))).toBe(DEFAULT_SILENCE_WATCH.thinkingMs);
    // Une commande ouverte avant le dernier texte ne compte plus.
    expect(silenceLimit(turn([activity("c", "command", "running"), text("m")]))).toBe(DEFAULT_SILENCE_WATCH.streamMs);
  });

  it("dit depuis combien de minutes le CLI se tait", () => {
    expect(silenceMessage(20_000, false)).toBe(
      "Le CLI ne donne plus signe de vie depuis 1 min. Le tour a été arrêté ; relancez la tâche.",
    );
    expect(silenceMessage(16 * 60_000, true)).toContain("16 min au milieu de sa réponse");
  });
});

describe("surveillance", () => {
  it("arrête les tours trop silencieux, sauf ceux qui attendent l’utilisateur, et s’arrête sans tour", () => {
    vi.useFakeTimers();
    try {
      const fail = vi.fn();
      let running = [
        { id: "muet", turn: turn([text("m")]), lastEventAt: 0, waitingForUser: false },
        { id: "accord", turn: turn([text("m")]), lastEventAt: 0, waitingForUser: true },
        { id: "vif", turn: turn([text("m")]), lastEventAt: 9 * 60_000, waitingForUser: false },
      ];
      const watch = createSilenceWatch({ running: () => running, fail, now: () => 10 * 60_000 });
      watch.start();
      vi.advanceTimersByTime(30_000);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledWith("muet", expect.stringContaining("10 min au milieu de sa réponse"));
      running = [];
      vi.advanceTimersByTime(30_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
