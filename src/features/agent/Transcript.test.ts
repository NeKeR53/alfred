import { expect, test, vi } from "vitest";

// Le magasin de la coquille lit le thème du système à son chargement ; jsdom n’a pas `matchMedia`.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { activitySummary } from "./Activities";
import type { Turn } from "./model";
import { turnSummary } from "./Transcript";

const turn = (items: Turn["items"], endedAt?: number): Turn => ({
  id: "t",
  user: { text: "", attachments: [], contexts: [] },
  items,
  status: "done",
  startedAt: 0,
  endedAt,
});

test("le résumé d’un tour compte les outils, sans la réflexion, et sa durée", () => {
  expect(
    turnSummary(
      turn(
        [
          { kind: "activity", id: "a", activityKind: "analysis", title: "Analyse", status: "completed" },
          { kind: "activity", id: "b", activityKind: "command", title: "Commande", status: "completed" },
          { kind: "message", id: "m", content: "Fait." },
        ],
        80_000,
      ),
    ),
  ).toBe("A travaillé pendant 1 min 20 s · 1 outil appelé");
  expect(turnSummary(turn([]))).toBe("Travail terminé · aucun outil appelé");
});

test("une suite d’activités se résume comme dans OneApp", () => {
  expect(
    activitySummary([
      { kind: "activity", id: "a", activityKind: "command", title: "ls", status: "completed" },
      { kind: "activity", id: "b", activityKind: "file", title: "page.tsx", status: "running" },
      { kind: "activity", id: "c", activityKind: "tool", title: "check", status: "failed" },
    ]),
  ).toBe("3 outils · 1 en cours · 1 en échec");
});
