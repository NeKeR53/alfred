import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import type { SetupStep } from "./api";
import { useReadyServicesReload } from "./useModuleSetup";

let states: Record<string, SetupStep["state"]>;
const listeners = new Map<string, Set<() => void>>();

function step(need: string): SetupStep {
  return {
    key: `boite/${need}`,
    module: "boite",
    moduleName: "Boîte",
    need,
    label: need,
    help: "",
    optional: false,
    hasTemplate: true,
    client: need,
    state: states[need],
  } as SetupStep;
}

beforeEach(() => {
  states = { gmail: "missing", drive: "missing" };
  listeners.clear();
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler as () => void);
    listeners.set(name, set);
    return () => set.delete(handler as () => void);
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command !== "modules.setup") throw new Error(command);
    return {
      modules: [{ module: "boite", name: "Boîte", ready: false, steps: [step("gmail"), step("drive")] }],
    };
  });
});

const changed = () => {
  for (const handler of listeners.get("clients:changed") ?? []) handler();
};

it("recharge la page quand un service dont elle dépend devient prêt, pas pour un autre", async () => {
  const { result } = renderHook(() => useReadyServicesReload("boite", { clients: ["gmail"] }));
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(result.current).toBe(0);

  // Un service dont la page ne dépend pas : rien ne bouge.
  states.drive = "ready";
  act(changed);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(result.current).toBe(0);

  // Son service devient prêt : la page se recharge une fois.
  states.gmail = "ready";
  act(changed);
  await waitFor(() => expect(result.current).toBe(1));

  // Il redevient « à tester » puis prêt : nouveau rechargement.
  states.gmail = "untested";
  act(changed);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThanOrEqual(4));
  expect(result.current).toBe(1);
  states.gmail = "ready";
  act(changed);
  await waitFor(() => expect(result.current).toBe(2));
});
