/**
 * États partagés, par le vrai chemin de la coquille (pont des cadres, hub, hôte des fonctions) et un faux cœur qui
 * reproduit `states.rs` : il range la sortie des lectures (entités normalisées, listes d’identifiants), rend la
 * valeur avec ses dépendances, et annonce chaque changement (`states:changed`).
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
import { receiveStatesChanged, resetFunctionHosts } from "./functionHost";
import type { StatePush } from "./sharedStates";
import { useShell } from "./store";

function read(module: string, id: string, fields: Partial<ResolvedFunction>): ResolvedFunction {
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
    uses: { clients: [module] },
    runtime: "python",
    effect: "read",
    ...fields,
  } as ResolvedFunction;
}

// --- Faux cœur ---------------------------------------------------------------------------------------------------

type Mail = { id: string; sujet: string; lu: boolean };
type Ticket = { cle: string; etat: string };
let serverHits = 0;
let service: { boite: Mail[]; tickets: Record<string, Ticket> } = { boite: [], tickets: {} };
const stored = new Map<string, unknown>();

const BOITE = "etat mail/boite-de-reception";
const LISTES = { "jira/mes-tickets": "etat jira/mes-tickets", "jira/suivis": "etat jira/suivis" } as const;
const ticketKey = (cle: string) => `entite jira/ticket ${cle}`;

function announce(keys: string[]) {
  receiveStatesChanged({ keys });
}

/** Ce que fait le cœur après une lecture : il range la sortie et annonce les clés qui ont changé. */
function feed(reference: string, input: Record<string, unknown>) {
  serverHits += 1;
  const changed: string[] = [];
  const set = (key: string, value: unknown) => {
    if (JSON.stringify(stored.get(key)) === JSON.stringify(value)) return;
    stored.set(key, value);
    changed.push(key);
  };
  if (reference === "mail/lister-boite") set(BOITE, structuredClone(service.boite));
  if (reference === "jira/mes-tickets" || reference === "jira/suivis") {
    const tickets = Object.values(service.tickets);
    for (const ticket of tickets) set(ticketKey(ticket.cle), { ...ticket });
    set(
      LISTES[reference],
      tickets.map((ticket) => ticket.cle),
    );
  }
  if (reference === "jira/lire-ticket") {
    const ticket = service.tickets[String(input.cle)] as Ticket;
    set(ticketKey(ticket.cle), { ...ticket });
  }
  announce(changed);
  return {};
}

function get(name: string) {
  const qualified = name.includes("/") ? name : `jira/${name}`;
  if (qualified === "mail/boite-de-reception") {
    const value = stored.get(BOITE);
    return { value: value ?? null, empty: value === undefined, deps: [BOITE] };
  }
  const listKey = LISTES[qualified as keyof typeof LISTES];
  const ids = stored.get(listKey) as string[] | undefined;
  if (!ids) return { value: null, empty: true, deps: [listKey] };
  return {
    value: ids.map((cle) => stored.get(ticketKey(cle))),
    empty: false,
    deps: [listKey, ...ids.map(ticketKey)],
  };
}

// --- Pages -------------------------------------------------------------------------------------------------------

const boite: FrameIdentity = { kind: "page", module: "boite", reference: "boite/mails" };
const tableau: FrameIdentity = { kind: "page", module: "tableau", reference: "tableau/accueil" };
const sprint: FrameIdentity = { kind: "page", module: "sprint", reference: "sprint/tableau" };
const suivi: FrameIdentity = { kind: "page", module: "suivi", reference: "suivi/mes-suivis" };

function page() {
  const states: StatePush[] = [];
  const push = (name: string, payload: unknown) => {
    if (name === "state") states.push((payload as { state: StatePush }).state);
  };
  return { states, push, last: () => states.at(-1) };
}

const flush = async () => {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const functionCalls = () => native.invoke.mock.calls.filter(([command]) => command === "functions.call");

beforeEach(() => {
  resetFunctionHosts();
  serverHits = 0;
  stored.clear();
  service = {
    boite: [{ id: "m1", sujet: "Bonjour", lu: false }],
    tickets: { "ALF-1": { cle: "ALF-1", etat: "ouvert" }, "ALF-2": { cle: "ALF-2", etat: "ouvert" } },
  };
  useShell.setState({
    snapshot: {
      functions: [
        read("mail", "lister-boite", { state: "boite-de-reception" }),
        read("jira", "mes-tickets", { state: "mes-tickets" }),
        read("jira", "suivis", { state: "suivis" }),
        read("jira", "lire-ticket", { entity: "ticket", param: "cle" }),
      ],
      modules: ["mail", "jira", "boite", "tableau", "sprint", "suivi"].map((id) => ({
        id,
        requires: ["boite", "tableau"].includes(id)
          ? [{ module: "mail" }]
          : ["sprint", "suivi"].includes(id)
            ? [{ module: "jira" }]
            : [],
      })) as unknown as ModuleSummary[],
      examples: [],
    } as unknown as Snapshot,
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "frame.states.get") return get(String(args.name));
    // Un script : le cœur l’exécute (une requête au service) et alimente l’état lui-même (`functions::call_in`).
    if (command === "functions.call") return feed(String(args.function), (args.input ?? {}) as Record<string, unknown>);
    return null;
  });
});

describe("états partagés", () => {
  it("deux modules de mail : la page A lit la boîte, la page B se met à jour sans aucune requête", async () => {
    const a = page();
    const b = page();
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, a.push);
    await flush();
    // La boîte était vide : la page qui s’ouvre la lit, une fois.
    expect(serverHits).toBe(1);
    await handleFrameRequest(tableau, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, b.push);
    await flush();
    expect(serverHits, "la seconde page reçoit la valeur courante, sans lecture").toBe(1);
    expect(b.last()).toMatchObject({ data: [{ id: "m1", sujet: "Bonjour", lu: false }], loading: false });

    // Un mail arrive ; la page A relit la boîte.
    service.boite.push({ id: "m2", sujet: "Facture", lu: false });
    await handleFrameRequest(boite, "states.refresh", { watch: "w1" });
    await flush();
    expect(serverHits, "une seule requête au service").toBe(2);
    expect(a.last()?.data).toHaveLength(2);
    expect(b.last()?.data).toEqual([
      { id: "m1", sujet: "Bonjour", lu: false },
      { id: "m2", sujet: "Facture", lu: false },
    ]);
  });

  it("un ticket présent dans deux listes de deux modules : on relit ce seul ticket, les deux pages suivent", async () => {
    const listeA = page();
    const listeB = page();
    await handleFrameRequest(sprint, "states.watch", { watch: "w1", name: "jira/mes-tickets" }, listeA.push);
    await handleFrameRequest(suivi, "states.watch", { watch: "w1", name: "jira/suivis" }, listeB.push);
    await flush();
    expect(listeA.last()?.data).toEqual([
      { cle: "ALF-1", etat: "ouvert" },
      { cle: "ALF-2", etat: "ouvert" },
    ]);
    const calls = functionCalls().length;

    // ALF-1 est fermé chez le service ; une page relit ce seul ticket.
    (service.tickets["ALF-1"] as Ticket).etat = "fermé";
    await handleFrameRequest(sprint, "states.watch", { watch: "w2", name: "jira/ticket", key: "ALF-1" }, () => {});
    await handleFrameRequest(sprint, "states.refresh", { watch: "w2" });
    await flush();
    expect(functionCalls().length - calls, "une seule lecture : celle du ticket").toBe(1);
    expect(functionCalls().at(-1)?.[1]).toMatchObject({ function: "jira/lire-ticket", input: { cle: "ALF-1" } });
    expect((listeA.last()?.data as Ticket[] | undefined)?.[0]?.etat).toBe("fermé");
    expect((listeB.last()?.data as Ticket[] | undefined)?.[0]?.etat).toBe("fermé");
  });

  it("refuse un abonnement sans nom, et ferme ceux d’un cadre qui disparaît", async () => {
    await expect(handleFrameRequest(boite, "states.watch", { watch: "w1" }, () => {})).rejects.toThrow(/nom d’état/);
    const { releaseFrame } = await import("./frameBridge");
    const a = page();
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, a.push);
    await flush();
    releaseFrame(boite);
    const count = a.states.length;
    service.boite = [];
    await handleFrameRequest(tableau, "states.watch", { watch: "w9", name: "mail/boite-de-reception" }, () => {});
    await handleFrameRequest(tableau, "states.refresh", { watch: "w9" });
    await flush();
    expect(a.states).toHaveLength(count);
  });
});
