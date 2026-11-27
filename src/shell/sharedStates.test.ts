/**
 * États partagés, par le vrai chemin de la coquille (pont des cadres, hub, hôte des fonctions) et un faux cœur qui
 * reproduit `states.rs` et `state_refresh.rs` : le fournisseur lit l’état au premier abonnement et sur « Actualiser »,
 * range sa sortie (entités normalisées, listes d’identifiants) et annonce chaque changement (`states:changed`). La
 * coquille ne lance jamais elle-même une lecture.
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

import type { ModuleSummary, Snapshot } from "../lib/types";
import { type FrameIdentity, handleFrameRequest, releaseFrame } from "./frameBridge";
import { receiveStatesChanged, resetFunctionHosts, stateHub } from "./functionHost";
import type { StatePush } from "./sharedStates";
import { useShell } from "./store";

// --- Faux cœur ---------------------------------------------------------------------------------------------------

type Mail = { id: string; sujet: string; lu: boolean };
type Ticket = { cle: string; etat: string };
let serverHits = 0;
let service: { boite: Mail[]; tickets: Record<string, Ticket> } = { boite: [], tickets: {} };
const stored = new Map<string, unknown>();
let subscriptionSequence = 0;

const ticketKey = (cle: string) => `entite jira/ticket ${cle}`;

function keyOf(args: Record<string, unknown>): string {
  const name = String(args.name);
  const qualified = name.includes("/") ? name : `${String((args.subject as { module: string }).module)}/${name}`;
  return qualified === "jira/ticket" ? ticketKey(String(args.key)) : `etat ${qualified}`;
}

/** Le fournisseur lit le service (une requête), range la sortie et annonce les clés qui ont changé. */
function provide(key: string) {
  serverHits += 1;
  const changed: string[] = [];
  const set = (target: string, value: unknown) => {
    if (JSON.stringify(stored.get(target)) === JSON.stringify(value)) return;
    stored.set(target, value);
    changed.push(target);
  };
  if (key === "etat mail/boite-de-reception") set(key, structuredClone(service.boite));
  if (key === "etat jira/mes-tickets" || key === "etat jira/suivis") {
    const tickets = Object.values(service.tickets);
    for (const ticket of tickets) set(ticketKey(ticket.cle), { ...ticket });
    set(
      key,
      tickets.map((ticket) => ticket.cle),
    );
  }
  if (key.startsWith("entite jira/ticket ")) {
    const ticket = service.tickets[key.slice("entite jira/ticket ".length)] as Ticket;
    set(key, { ...ticket });
  }
  receiveStatesChanged({ keys: changed });
}

function get(args: Record<string, unknown>) {
  const key = keyOf(args);
  const value = stored.get(key);
  if (value === undefined) return { value: null, empty: true, deps: [key], refresh: { running: true } };
  const refresh = { running: false, lastRunAt: 1_000 };
  if (key === "etat jira/mes-tickets" || key === "etat jira/suivis") {
    const ids = value as string[];
    return {
      value: ids.map((cle) => stored.get(ticketKey(cle))),
      empty: false,
      deps: [key, ...ids.map(ticketKey)],
      refresh,
    };
  }
  return { value, empty: false, deps: [key], refresh };
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

const commands = (name: string) => native.invoke.mock.calls.filter(([command]) => command === name);

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
      functions: [],
      modules: ["mail", "jira", "boite", "tableau", "sprint", "suivi"].map((id) => ({
        id,
        requires: [],
      })) as unknown as ModuleSummary[],
      examples: [],
    } as unknown as Snapshot,
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "frame.states.get") return get(args);
    if (command === "frame.states.subscribe") {
      const key = keyOf(args);
      subscriptionSequence += 1;
      // Premier abonné d’un état vide : le fournisseur le lit (dans le cœur, juste après).
      if (!stored.has(key)) setTimeout(() => provide(key), 0);
      return { id: `abo-${subscriptionSequence}`, key };
    }
    if (command === "frame.states.refresh") {
      provide(keyOf(args));
      return null;
    }
    return null;
  });
});

describe("états partagés", () => {
  it("deux modules de mail : la page A lit la boîte, la page B se met à jour sans aucune requête", async () => {
    const a = page();
    const b = page();
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, a.push);
    await flush();
    // La boîte était vide : le fournisseur la lit, une fois.
    expect(serverHits).toBe(1);
    await handleFrameRequest(tableau, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, b.push);
    await flush();
    expect(serverHits, "la seconde page reçoit la valeur courante, sans lecture").toBe(1);
    expect(b.last()).toMatchObject({ data: [{ id: "m1", sujet: "Bonjour", lu: false }], loading: false });

    // Un mail arrive ; la page A demande une relecture au fournisseur.
    service.boite.push({ id: "m2", sujet: "Facture", lu: false });
    await handleFrameRequest(boite, "states.refresh", { watch: "w1" });
    await flush();
    expect(serverHits, "une seule requête au service").toBe(2);
    expect(a.last()?.data).toHaveLength(2);
    expect(b.last()?.data).toEqual([
      { id: "m1", sujet: "Bonjour", lu: false },
      { id: "m2", sujet: "Facture", lu: false },
    ]);
    // La coquille n’a lancé aucune fonction elle-même.
    expect(commands("functions.call")).toHaveLength(0);
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
    const before = serverHits;

    // ALF-1 est fermé chez le service ; une page relit ce seul ticket.
    (service.tickets["ALF-1"] as Ticket).etat = "fermé";
    await handleFrameRequest(sprint, "states.watch", { watch: "w2", name: "jira/ticket", key: "ALF-1" }, () => {});
    await flush();
    await handleFrameRequest(sprint, "states.refresh", { watch: "w2" });
    await flush();
    expect(serverHits - before, "une seule lecture : celle du ticket").toBe(1);
    expect((listeA.last()?.data as Ticket[] | undefined)?.[0]?.etat).toBe("fermé");
    expect((listeB.last()?.data as Ticket[] | undefined)?.[0]?.etat).toBe("fermé");
  });

  it("abonne chaque page au cœur, renouvelle tant qu’elle est ouverte et se désabonne quand elle se ferme", async () => {
    await expect(handleFrameRequest(boite, "states.watch", { watch: "w1" }, () => {})).rejects.toThrow(/nom d’état/);
    await handleFrameRequest(
      boite,
      "states.watch",
      { watch: "w1", name: "jira/tickets-du-filtre", params: { jql: "assignee = moi" } },
      () => {},
    );
    await flush();
    expect(commands("frame.states.subscribe").at(-1)?.[1]).toMatchObject({
      name: "jira/tickets-du-filtre",
      params: { jql: "assignee = moi" },
    });
    await stateHub.renew();
    const renewed = commands("states.renew").at(-1)?.[1] as { ids: string[] } | undefined;
    expect(renewed?.ids).toHaveLength(1);
    const mine = renewed?.ids[0];
    expect(mine).toMatch(/^abo-/);
    releaseFrame(boite);
    await flush();
    // Les abonnements des tests d’avant se retirent aussi, plus tard : seul compte celui de cette page.
    expect(commands("states.unsubscribe").some(([, args]) => (args as { id: string }).id === mine)).toBe(true);
  });

  it("la dernière valeur connue (gardée sur le disque) s’affiche tout de suite, sans attendre l’abonnement", async () => {
    // Après un redémarrage : le cœur a la valeur du lancement précédent ; l’abonnement tarde.
    stored.set("etat mail/boite-de-reception", [{ id: "m9", sujet: "D’hier", lu: true }]);
    const base = native.invoke.getMockImplementation();
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "frame.states.subscribe") return new Promise(() => {});
      return base?.(command, args);
    });
    const a = page();
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, a.push);
    await flush();
    expect(a.last()).toMatchObject({ data: [{ id: "m9", sujet: "D’hier", lu: true }], loading: false });
    expect(serverHits, "valeur connue : aucune lecture").toBe(0);
  });

  it("une relecture met à jour tous les abonnés, et « Actualiser » attend la fin de la lecture", async () => {
    const a = page();
    const b = page();
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, a.push);
    await handleFrameRequest(tableau, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, b.push);
    await flush();
    const before = serverHits;
    let runs = 1;
    let finish: () => void = () => {};
    const base = native.invoke.getMockImplementation();
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "frame.states.refresh") {
        // Le cœur lit plus tard (boucle du fournisseur) : la lecture finit quand on le décide.
        finish = () => {
          runs += 1;
          provide(keyOf(args));
        };
        return { key: keyOf(args), runs, reading: true };
      }
      if (command === "frame.states.get") {
        const read = (await base?.(command, args)) as { refresh?: Record<string, unknown> };
        return { ...read, refresh: { ...read.refresh, running: false, runs } };
      }
      return base?.(command, args);
    });
    service.boite.push({ id: "m2", sujet: "Facture", lu: false });
    let done = false;
    const asked = handleFrameRequest(boite, "states.refresh", { watch: "w1" }).then(() => {
      done = true;
    });
    await flush();
    expect(done, "la lecture n’est pas finie : le bouton attend").toBe(false);
    expect(a.last()?.refreshing).toBe(true);
    expect(a.last()?.data, "les données restent affichées").toHaveLength(1);
    finish();
    await asked;
    await flush();
    expect(done).toBe(true);
    expect(serverHits - before, "une seule lecture pour les deux pages").toBe(1);
    expect(a.last()).toMatchObject({ refreshing: false });
    expect(a.last()?.data).toHaveLength(2);
    expect(b.last()?.data, "l’autre page suit sans rien demander").toHaveLength(2);
  });

  it("le retour sur une page demande au cœur de relire ses seuls états périmés", async () => {
    await handleFrameRequest(boite, "states.watch", { watch: "w1", name: "mail/boite-de-reception" }, () => {});
    await handleFrameRequest(tableau, "states.watch", { watch: "w1", name: "jira/mes-tickets" }, () => {});
    await flush();
    await stateHub.revisit(boite);
    const asked = commands("states.revisit").at(-1)?.[1] as { ids: string[] } | undefined;
    expect(asked?.ids, "seuls les abonnements de la page revenue").toHaveLength(1);
  });
});
