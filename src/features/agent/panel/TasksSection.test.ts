import { expect, it } from "vitest";
import type { ConversationHeader } from "../model";
import { delegateTasks, shownTasks } from "./TasksSection";

const header = (id: string, extra: Partial<ConversationHeader>) =>
  ({ id, title: `${id} · délégué`, createdAt: 1000, updatedAt: 5000, ...extra }) as ConversationHeader;

it("montre les délégués d’une coordinatrice comme tâches de fond de sa conversation", () => {
  const conversations = [
    header("notes", { parent: "coord" }),
    header("contacts", { parent: "coord" }),
    header("ailleurs", { parent: "autre" }),
    header("coord", {}),
  ];
  const states = { notes: "working", contacts: "error" } as const;
  const tasks = delegateTasks(conversations, "coord", (id) => states[id as keyof typeof states] ?? "idle");
  expect(tasks.map((task) => [task.title, task.status, task.kind])).toEqual([
    ["notes · délégué", "running", "agent"],
    ["contacts · délégué", "failed", "agent"],
  ]);
  expect(tasks[1]?.endedAt).toBe(5000);
  const shown = shownTasks(tasks, 6000);
  expect(shown.running.map((task) => task.title)).toEqual(["notes · délégué"]);
  expect([shown.finished, shown.failed]).toEqual([1, 1]);
});
