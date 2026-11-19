import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/native");

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

import { userPages } from "../features/modules/menuApi";
import { invoke, onNativeEvent } from "../lib/native";
import type { Snapshot } from "../lib/types";
import { useShell } from "./store";

/**
 * Alfred n’a qu’un espace ouvert à la fois, et plusieurs fenêtres peuvent l’ouvrir (la fenêtre principale, une
 * interface branchée sur le pont de développement). La fenêtre suit l’espace ouvert ailleurs, et ses écritures du
 * menu disent l’espace qu’elle montrait, pour qu’Alfred refuse d’écrire dans un autre.
 */
const space = (path: string, name: string) => ({ path, name, sections: [], modules: [] }) as unknown as Snapshot;

let open: Snapshot | null;
let handlers: Map<string, (payload: unknown) => void>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;

beforeEach(async () => {
  open = space("/espaces/taff", "taff");
  handlers = new Map();
  calls = [];
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    handlers.set(name, handler as (payload: unknown) => void);
    return () => undefined;
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "app.info") return { version: "test" };
    if (command === "space.restore" || command === "space.snapshot") {
      if (!open) throw new Error("Aucun espace de travail n’est ouvert.");
      return open;
    }
    if (command.startsWith("space.menu.")) return { ...open, created: "atlassian/jira@2" };
    return null;
  });
  await useShell.getState().start();
  useShell.setState({ view: { kind: "settings", tab: "modules" } as never });
});

it("suit l’espace ouvert ailleurs, et revient à l’accueil s’il n’y en a plus", async () => {
  expect(useShell.getState().snapshot?.path).toBe("/espaces/taff");
  const revision = useShell.getState().revision;

  open = space("/essais/onboarding", "Essai");
  handlers.get("space:switched")?.({ path: "/essais/onboarding" });
  await vi.waitFor(() => expect(useShell.getState().snapshot?.path).toBe("/essais/onboarding"));
  expect(useShell.getState().revision).toBe(revision + 1);
  expect(useShell.getState().view).toEqual({ kind: "agent" });

  open = null;
  handlers.get("space:switched")?.(null);
  await vi.waitFor(() => expect(useShell.getState().snapshot).toBeNull());
});

it("ne recharge rien quand l’espace annoncé est déjà celui affiché", async () => {
  const revision = useShell.getState().revision;
  handlers.get("space:switched")?.({ path: "/espaces/taff" });
  await vi.waitFor(() => expect(calls.filter((call) => call.command === "space.snapshot")).toHaveLength(1));
  expect(useShell.getState().revision).toBe(revision);
  expect(useShell.getState().view).toEqual({ kind: "settings", tab: "modules" });
});

it("les écritures du menu disent l’espace affiché", async () => {
  await userPages.addPage("atlassian/jira", [{ page: "atlassian/jira", accounts: {} }]);
  await userPages.addTab("atlassian/jira", { page: "atlassian/jira", accounts: {} });
  const menu = calls.filter((call) => call.command.startsWith("space.menu."));
  expect(menu.map((call) => call.args.space)).toEqual(["/espaces/taff", "/espaces/taff"]);
});
