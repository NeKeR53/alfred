import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), onNativeEvent: vi.fn() }));
vi.mock("../../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: native.onNativeEvent,
}));

const OWNED_KEY = "alfred.agentSessions";
let next = 0;

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  native.invoke.mockReset();
  native.onNativeEvent.mockReset().mockReturnValue(() => undefined);
  native.invoke.mockImplementation(async (command: string) =>
    command === "agents.spawn" ? { session: `s-${++next}` } : null,
  );
});

const commands = () => native.invoke.mock.calls.map(([command, args]) => `${command} ${args?.session ?? ""}`.trim());

it("arrête les sessions laissées par un chargement précédent de la fenêtre avant d’en lancer une autre", async () => {
  sessionStorage.setItem(OWNED_KEY, JSON.stringify(["ancienne-1", "ancienne-2"]));
  const { spawnProcess } = await import("./process");
  await spawnProcess("codex", { cwd: "/espace" });
  await spawnProcess("codex", { cwd: "/espace" });
  expect(commands()).toEqual(["agents.kill ancienne-1", "agents.kill ancienne-2", "agents.spawn", "agents.spawn"]);
  expect(JSON.parse(sessionStorage.getItem(OWNED_KEY) ?? "[]")).toEqual([`s-${next - 1}`, `s-${next}`]);
});

it("oublie une session qu’elle arrête elle-même", async () => {
  const { spawnProcess } = await import("./process");
  const process = await spawnProcess("claude", { cwd: "/espace" });
  await process.kill();
  expect(sessionStorage.getItem(OWNED_KEY)).toBeNull();
});
