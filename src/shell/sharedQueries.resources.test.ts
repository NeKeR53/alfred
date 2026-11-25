/**
 * « Je lis mes mails ; deux modules lisent les mails ; si le premier déclenche la lecture, les deux se mettent à
 * jour. » Deux modules ont chacun leur fonction de lecture sur la même ressource du service. Le faux cœur reproduit
 * `client_reads.rs` : il garde chaque réponse, la sert à une relance (`reuse`) et annonce chaque nouvelle réponse
 * (`clients:read`). Une lecture de la première page met à jour la seconde, et le service ne reçoit qu’une requête.
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
import { type FrameIdentity, handleFrameRequest } from "./frameBridge";
import { receiveClientRead, resetFunctionHosts } from "./functionHost";
import type { QueryState } from "./sharedQueries";
import { useShell } from "./store";

function read(module: string, id: string): ResolvedFunction {
  return {
    reference: `${module}/${id}`,
    module,
    id,
    description: "",
    input: null,
    output: null,
    tool: false,
    missing: false,
    errors: [],
    uses: { clients: ["mail"] },
    runtime: "python",
    effect: "read",
  } as ResolvedFunction;
}

const MESSAGES = "mail:perso GET /messages?dossier=inbox";

/** Faux cœur : le service, les réponses gardées et l’annonce des nouvelles réponses. */
let inbox: string[] = [];
let serverHits = 0;
let kept: unknown;
let gate: Promise<void> = Promise.resolve();

function coreGet(reuse: boolean, reader: string) {
  if (reuse && kept !== undefined) return kept;
  serverHits += 1;
  kept = { status: 200, ok: true, body: [...inbox] };
  receiveClientRead({ resource: MESSAGES, module: reader.split("/")[0], function: reader });
  return kept;
}

const pageA: FrameIdentity = { kind: "page", module: "boite", reference: "boite/mails" };
const pageB: FrameIdentity = { kind: "page", module: "tableau", reference: "tableau/accueil" };

function watcher() {
  const states: QueryState[] = [];
  const push = (name: string, payload: unknown) => {
    if (name === "query") states.push((payload as { state: QueryState }).state);
  };
  return { states, push, last: () => states.at(-1) };
}

const flush = async () => {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const scriptCalls = () =>
  native.invoke.mock.calls.filter(([command]) => command === "functions.call").map(([, args]) => args);

beforeEach(() => {
  resetFunctionHosts();
  inbox = ["Bonjour"];
  serverHits = 0;
  kept = undefined;
  gate = Promise.resolve();
  useShell.setState({
    snapshot: {
      functions: [read("boite", "lister-mails"), read("tableau", "derniers-mails")],
      modules: [
        { id: "boite", requires: [] },
        { id: "tableau", requires: [] },
      ] as unknown as ModuleSummary[],
      examples: [],
    } as unknown as Snapshot,
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "frame.clients.request")
      return { ...(coreGet(args.reuse === true, "x/*") as object), resource: MESSAGES };
    if (command !== "functions.call") return null;
    await gate;
    // Chaque fonction lit la même ressource du service et met la réponse à sa façon.
    const response = coreGet(args.reuse === true, String(args.function)) as { body: string[] };
    return args.function === "boite/lister-mails"
      ? { mails: response.body }
      : { derniers: response.body.slice(-1), total: response.body.length };
  });
});

describe("deux modules, deux fonctions de lecture sur la même ressource", () => {
  it("une lecture de la première page met à jour la seconde, avec une seule requête au service", async () => {
    const a = watcher();
    const b = watcher();
    await handleFrameRequest(pageA, "functions.watch", { watch: "w1", function: "boite/lister-mails" }, a.push);
    await flush();
    await handleFrameRequest(pageB, "functions.watch", { watch: "w1", function: "tableau/derniers-mails" }, b.push);
    await flush();
    expect(a.last()?.data).toEqual({ mails: ["Bonjour"] });
    expect(b.last()?.data).toEqual({ derniers: ["Bonjour"], total: 1 });

    // Un mail arrive ; la première page relit (« Actualiser »).
    inbox = ["Bonjour", "Facture"];
    const before = serverHits;
    await handleFrameRequest(pageA, "functions.refresh", { watch: "w1" }, a.push);
    await flush();
    expect(a.last()?.data).toEqual({ mails: ["Bonjour", "Facture"] });
    expect(b.last()?.data).toEqual({ derniers: ["Facture"], total: 2 });
    expect(serverHits - before, "une seule requête au service").toBe(1);
    // La seconde fonction a été relancée en relance : elle a lu la réponse gardée.
    expect(scriptCalls().at(-1)).toMatchObject({ function: "tableau/derniers-mails", reuse: true });
  });

  it("une page qui ne montre plus la donnée ne se relance pas", async () => {
    const a = watcher();
    await handleFrameRequest(pageA, "functions.watch", { watch: "w1", function: "boite/lister-mails" }, a.push);
    await handleFrameRequest(pageB, "functions.watch", { watch: "w2", function: "tableau/derniers-mails" }, () => {});
    await flush();
    await handleFrameRequest(pageB, "functions.unwatch", { watch: "w2" });
    const calls = scriptCalls().length;
    await handleFrameRequest(pageA, "functions.refresh", { watch: "w1" }, a.push);
    await flush();
    expect(scriptCalls().length - calls).toBe(1);
  });

  it("une fonction TypeScript est rattachée par le pont, qui retire la ressource et demande la réponse gardée", async () => {
    // Une lecture en cours dans le cadre de « boite » (lancée par une page) : le cadre lit le client.
    let open: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = watcher();
    await handleFrameRequest(pageA, "functions.watch", { watch: "w1", function: "boite/lister-mails" }, a.push);
    const frame: FrameIdentity = { kind: "function", module: "boite", reference: "boite/*" };
    const response = (await handleFrameRequest(frame, "clients.request", {
      client: "mail",
      path: "/messages",
    })) as Record<string, unknown>;
    expect(response).not.toHaveProperty("resource");
    const sent = native.invoke.mock.calls.filter(([command]) => command === "frame.clients.request").at(-1)?.[1];
    expect(sent).not.toHaveProperty("reuse");
    open();
    await flush();

    // Une autre fonction relit la ressource : la lecture de « boite » se relance, en relance.
    const calls = scriptCalls().length;
    receiveClientRead({ resource: MESSAGES, module: "autre" });
    await flush();
    expect(scriptCalls().length - calls).toBe(1);
    expect(scriptCalls().at(-1)).toMatchObject({ function: "boite/lister-mails", reuse: true });
  });
});
