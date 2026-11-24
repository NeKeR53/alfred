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

import { activityItem } from "./Activities";
import type { Turn } from "./model";
import { turnToolCount } from "./Transcript";

const turn = (items: Turn["items"], endedAt?: number): Turn => ({
  id: "t",
  user: { text: "", attachments: [], contexts: [] },
  items,
  status: "done",
  startedAt: 0,
  endedAt,
});

test("un tour compte ses outils, sans la réflexion", () => {
  expect(
    turnToolCount(
      turn(
        [
          { kind: "activity", id: "a", activityKind: "analysis", title: "Analyse", status: "completed" },
          { kind: "activity", id: "b", activityKind: "command", title: "Commande", status: "completed" },
          { kind: "message", id: "m", content: "Fait." },
        ],
        80_000,
      ),
    ),
  ).toBe(1);
  expect(turnToolCount(turn([]))).toBe(0);
});

test("une activité devient une ligne Socle : type, verbe, objet, état et sortie", () => {
  expect(
    activityItem({
      kind: "activity",
      id: "a",
      activityKind: "command",
      title: "Commande",
      detail: '{"command":"ls -la"}',
      status: "completed",
      content: "total 0",
    }),
  ).toEqual({
    id: "a",
    kind: "command",
    verb: "Exécuté",
    object: "ls -la",
    status: "done",
    detail: '{"command":"ls -la"}\ntotal 0',
  });
  expect(
    activityItem({ kind: "activity", id: "b", activityKind: "file", title: "page.tsx", status: "running" }),
  ).toMatchObject({
    kind: "edit",
    verb: "page.tsx",
    status: "running",
  });
  expect(
    activityItem({ kind: "activity", id: "c", activityKind: "tool", title: "check", status: "failed" }),
  ).toMatchObject({
    kind: "other",
    status: "error",
  });
  expect(
    activityItem({ kind: "activity", id: "d", activityKind: "analysis", title: "Réflexion", status: "completed" }),
  ).toMatchObject({ kind: "think", verb: "Réflexion" });
  expect(
    activityItem({ kind: "activity", id: "e", activityKind: "command", title: "ls", status: "cancelled" as never }),
  ).toMatchObject({ verb: "ls · Arrêté", status: "done" });
});
