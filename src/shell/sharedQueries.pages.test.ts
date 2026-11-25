/**
 * Deux pages montrent les tickets Jira de l’utilisateur, par la même fonction de lecture du connecteur : une seule
 * requête part, et les deux pages sont à jour. Le chemin est le vrai : pont des cadres, hôte des fonctions, magasin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
}));

import type { ModuleSummary, ResolvedFunction, Snapshot } from "../lib/types";
import { type FrameIdentity, handleFrameRequest, releaseFrame } from "./frameBridge";
import { receiveClientChange, receiveSharedResult, resetFunctionHosts } from "./functionHost";
import type { QueryState } from "./sharedQueries";
import { useShell } from "./store";

function fn(id: string, effect: "read" | "write" | null): ResolvedFunction {
  return {
    reference: `jira/${id}`,
    module: "jira",
    id,
    description: "",
    input: null,
    output: null,
    tool: false,
    missing: false,
    errors: [],
    uses: { clients: ["jira"] },
    // Un script : lancé par le cœur (`functions.call`), sans cadre à simuler.
    runtime: "python",
    effect,
  } as ResolvedFunction;
}

const modules = [
  { id: "jira", requires: [] },
  { id: "sprint", requires: [{ module: "jira" }] },
  { id: "suivi", requires: [{ module: "jira" }] },
] as unknown as ModuleSummary[];

// Deux modules qui ne déclarent pas le client : ils lisent la fonction du connecteur `jira`.
const sprint: FrameIdentity = { kind: "page", module: "sprint", reference: "sprint/tableau" };
const suivi: FrameIdentity = { kind: "page", module: "suivi", reference: "suivi/mes-tickets" };
const assigned = { jql: "assignee = currentUser()" };

let served = 0;
let pending: Array<() => void> = [];

function callsOf(command: string) {
  return native.invoke.mock.calls.filter(([name]) => name === command);
}

function watcher() {
  const states: QueryState[] = [];
  const push = (name: string, payload: unknown) => {
    if (name === "query") states.push((payload as { state: QueryState }).state);
  };
  return { states, push, last: () => states.at(-1) };
}

const flush = async () => {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  resetFunctionHosts();
  served = 0;
  pending = [];
  useShell.setState({
    snapshot: {
      functions: [fn("lister-tickets", "read"), fn("commenter-ticket", "write")],
      modules,
      examples: [],
    } as unknown as Snapshot,
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args: { function?: string }) => {
    if (command !== "functions.call") return null;
    if (args.function === "jira/commenter-ticket") return { ok: true };
    // La réponse attend qu’on la libère : les deux pages sont abonnées pendant que la requête est en vol.
    served += 1;
    const version = served;
    await new Promise<void>((resolve) => pending.push(resolve));
    return { tickets: [`ALF-${version}`] };
  });
});

const release = () => {
  for (const resolve of pending.splice(0)) resolve();
};

describe("deux pages sur le même client", () => {
  it("une seule requête, et les deux pages sont à jour", async () => {
    const first = watcher();
    const second = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      first.push,
    );
    await handleFrameRequest(
      suivi,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: { ...assigned } },
      second.push,
    );
    expect(callsOf("functions.call")).toHaveLength(1);
    release();
    await flush();
    expect(first.last()).toMatchObject({ data: { tickets: ["ALF-1"] }, loading: false });
    expect(second.last()).toMatchObject({ data: { tickets: ["ALF-1"] }, loading: false });
    // Chaque page a demandé l’accord pour la fonction du connecteur (accordée d’office à une dépendance).
    expect(callsOf("frame.functions.authorize")).toHaveLength(2);

    // Une troisième page ouverte ensuite : la valeur tout de suite, sans requête.
    const third = watcher();
    await handleFrameRequest(
      { ...suivi, reference: "suivi/accueil" },
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      third.push,
    );
    expect(third.states).toHaveLength(1);
    expect(third.last()).toMatchObject({ data: { tickets: ["ALF-1"] }, fetching: false });
    expect(callsOf("functions.call")).toHaveLength(1);
  });

  it("une lecture faite par functions.call met aussi à jour les pages abonnées", async () => {
    const page = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      page.push,
    );
    release();
    await flush();
    const read = handleFrameRequest(suivi, "functions.call", { function: "jira/lister-tickets", input: assigned });
    await flush();
    release();
    await expect(read).resolves.toEqual({ tickets: ["ALF-2"] });
    await flush();
    expect(page.last()?.data).toEqual({ tickets: ["ALF-2"] });
  });

  it("une écriture du connecteur fait relire la liste une fois pour les deux pages", async () => {
    const first = watcher();
    const second = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      first.push,
    );
    await handleFrameRequest(
      suivi,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      second.push,
    );
    release();
    await flush();
    await handleFrameRequest(sprint, "functions.call", { function: "jira/commenter-ticket", input: { cle: "ALF-1" } });
    await flush();
    expect(callsOf("functions.call").filter(([, args]) => args.function === "jira/lister-tickets")).toHaveLength(2);
    release();
    await flush();
    expect(first.last()?.data).toEqual({ tickets: ["ALF-2"] });
    expect(second.last()?.data).toEqual({ tickets: ["ALF-2"] });
    // L’écriture est annoncée aux autres fenêtres.
    expect(callsOf("functions.shareResult").some(([, args]) => args.function === "jira/commenter-ticket")).toBe(true);
  });

  it("une page sur un autre compte a sa propre lecture", async () => {
    const acme = watcher();
    const interne = watcher();
    await handleFrameRequest(
      { ...sprint, accounts: { "jira/jira": "acme" } },
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      acme.push,
    );
    await handleFrameRequest(
      { ...suivi, accounts: { "jira/jira": "interne" } },
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      interne.push,
    );
    expect(callsOf("functions.call")).toHaveLength(2);
  });

  it("une réponse venue d’une autre fenêtre ou du cœur met les pages à jour sans requête", async () => {
    const page = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      page.push,
    );
    release();
    await flush();
    receiveSharedResult({
      function: "jira/lister-tickets",
      input: assigned,
      accounts: {},
      examples: false,
      output: { tickets: ["ALF-9"] },
      at: Date.now() + 1,
    });
    expect(page.last()?.data).toEqual({ tickets: ["ALF-9"] });
    expect(callsOf("functions.call")).toHaveLength(1);
  });

  it("refuse de suivre une écriture, et se désabonne quand le cadre disparaît", async () => {
    await expect(
      handleFrameRequest(
        sprint,
        "functions.watch",
        { watch: "w1", function: "jira/commenter-ticket", input: {} },
        () => undefined,
      ),
    ).rejects.toThrow(/effect: "read"/);
    const page = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w2", function: "jira/lister-tickets", input: assigned },
      page.push,
    );
    release();
    await flush();
    releaseFrame(sprint);
    const count = page.states.length;
    receiveSharedResult({
      function: "jira/lister-tickets",
      input: assigned,
      output: { tickets: [] },
      at: Date.now() + 1,
    });
    expect(page.states).toHaveLength(count);
  });

  it("une écriture d’un script vue par le cœur fait relire les pages ; celle d’une fonction TypeScript, non", async () => {
    const page = watcher();
    await handleFrameRequest(
      sprint,
      "functions.watch",
      { watch: "w1", function: "jira/lister-tickets", input: assigned },
      page.push,
    );
    release();
    await flush();
    // Sans nom de fonction (TypeScript) : la coquille d’origine invalide elle-même ; rien ne repart ici.
    receiveClientChange({ module: "jira", client: "jira", instance: "acme" });
    await flush();
    expect(callsOf("functions.call")).toHaveLength(1);
    // Un script d’écriture lancé par le cœur : la liste se relit une fois.
    receiveClientChange({ module: "jira", client: "jira", instance: "acme", function: "jira/commenter-ticket" });
    await flush();
    expect(callsOf("functions.call")).toHaveLength(2);
    release();
    await flush();
    expect(page.last()?.data).toEqual({ tickets: ["ALF-2"] });
  });
});
