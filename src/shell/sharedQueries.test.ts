import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryStore, type QueryCall, type QueryState, queryKey } from "./sharedQueries";

const tickets: QueryCall = { reference: "jira/lister-tickets", input: { jql: "assignee = currentUser()" } };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  const states: QueryState[] = [];
  return { states, listener: (state: QueryState) => states.push(state), last: () => states.at(-1) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("clé d’une lecture", () => {
  it("ne dépend pas de l’ordre des champs, mais du compte et du mode exemple", () => {
    const a = queryKey({ reference: "jira/l", input: { b: 1, a: { d: 2, c: 3 } }, accounts: { jira: "acme" } });
    const b = queryKey({ reference: "jira/l", input: { a: { c: 3, d: 2 }, b: 1 }, accounts: { jira: "acme" } });
    expect(a).toBe(b);
    expect(queryKey({ reference: "jira/l", input: {}, accounts: { jira: "interne" } })).not.toBe(
      queryKey({ reference: "jira/l", input: {}, accounts: { jira: "acme" } }),
    );
    expect(queryKey({ reference: "jira/l", input: {}, examples: true })).not.toBe(
      queryKey({ reference: "jira/l", input: {} }),
    );
  });
});

describe("magasin partagé", () => {
  it("deux lectures identiques en vol n’en font qu’une, publiée à tous les abonnés", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn(() => pending.promise);
    const store = createQueryStore({ execute });
    const first = recorder();
    const second = recorder();
    store.subscribe(tickets, first.listener);
    store.subscribe({ ...tickets, input: { jql: "assignee = currentUser()" } }, second.listener);
    const direct = store.run(tickets);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.last()).toMatchObject({ loading: true, fetching: true });
    pending.resolve({ tickets: ["ALF-1"] });
    await expect(direct).resolves.toEqual({ tickets: ["ALF-1"] });
    await flush();
    expect(first.last()).toMatchObject({ data: { tickets: ["ALF-1"] }, loading: false, fetching: false });
    expect(second.last()?.data).toEqual({ tickets: ["ALF-1"] });
  });

  it("un nouvel abonné reçoit tout de suite la dernière valeur, sans requête tant qu’elle est fraîche", async () => {
    let time = 1_000;
    const execute = vi.fn(async () => ({ etat: "vert" }));
    const store = createQueryStore({ execute, now: () => time });
    await store.run({ reference: "jenkins/etat", input: { job: "alfred" } });
    const page = recorder();
    store.subscribe({ reference: "jenkins/etat", input: { job: "alfred" } }, page.listener);
    expect(page.states).toHaveLength(1);
    expect(page.last()).toMatchObject({ data: { etat: "vert" }, loading: false, fetching: false });
    expect(execute).toHaveBeenCalledTimes(1);

    // Plus vieille que `staleAfter` : affichée tout de suite, puis relue en fond.
    time += 31_000;
    const late = recorder();
    store.subscribe({ reference: "jenkins/etat", input: { job: "alfred" } }, late.listener);
    expect(late.states[0]).toMatchObject({ data: { etat: "vert" }, loading: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("une réponse lue ailleurs met à jour les abonnés sans requête", () => {
    const execute = vi.fn(async () => null);
    const store = createQueryStore({ execute, now: () => 5 });
    store.publish(tickets, { tickets: [] }, 4);
    const page = recorder();
    store.subscribe(tickets, page.listener);
    store.publish(tickets, { tickets: ["ALF-2"] }, 6);
    expect(page.last()?.data).toEqual({ tickets: ["ALF-2"] });
    // Une réponse plus ancienne ne remplace pas la plus récente.
    store.publish(tickets, { tickets: ["vieux"] }, 1);
    expect(page.last()?.data).toEqual({ tickets: ["ALF-2"] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("deux comptes ne partagent jamais une réponse", async () => {
    const execute = vi.fn(async (call: QueryCall) => ({ compte: call.accounts?.jira }));
    const store = createQueryStore({ execute });
    const acme = recorder();
    const interne = recorder();
    store.subscribe({ ...tickets, accounts: { jira: "acme" } }, acme.listener);
    store.subscribe({ ...tickets, accounts: { jira: "interne" } }, interne.listener);
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(acme.last()?.data).toEqual({ compte: "acme" });
    expect(interne.last()?.data).toEqual({ compte: "interne" });
  });

  it("une écriture relit les lectures suivies du module, sur le même compte seulement", async () => {
    let version = 1;
    const execute = vi.fn(async (call: QueryCall) => ({ version, compte: call.accounts?.jira }));
    const store = createQueryStore({ execute });
    const acme = recorder();
    const interne = recorder();
    const autre = recorder();
    store.subscribe({ ...tickets, accounts: { jira: "acme" } }, acme.listener);
    store.subscribe({ ...tickets, accounts: { jira: "interne" } }, interne.listener);
    store.subscribe({ reference: "jenkins/etat", input: {} }, autre.listener);
    // Lue sans abonné : seulement marquée caduque.
    await store.run({ reference: "jira/lire-ticket", input: { cle: "ALF-1" }, accounts: { jira: "acme" } });
    await flush();
    expect(execute).toHaveBeenCalledTimes(4);

    version = 2;
    store.invalidate({ modules: ["jira"], accounts: { jira: "acme" }, examples: false });
    await flush();
    expect(execute).toHaveBeenCalledTimes(5);
    expect(acme.last()?.data).toEqual({ version: 2, compte: "acme" });
    expect(interne.last()?.data).toEqual({ version: 1, compte: "interne" });
    expect(autre.last()?.data).toEqual({ version: 1 });

    // La lecture sans abonné, caduque, se relit au prochain abonnement même si elle est récente.
    store.subscribe(
      { reference: "jira/lire-ticket", input: { cle: "ALF-1" }, accounts: { jira: "acme" } },
      recorder().listener,
    );
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("une instance nommée dans l’entrée limite l’invalidation", async () => {
    const execute = vi.fn(async () => "ok");
    const store = createQueryStore({ execute });
    store.subscribe({ reference: "jira/l", input: { instance: "acme" } }, recorder().listener);
    store.subscribe({ reference: "jira/l", input: { instance: "interne" } }, recorder().listener);
    await flush();
    store.invalidate({ modules: ["jira"], instance: "acme" });
    await flush();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("une réponse partie avant une écriture n’est pas montrée comme à jour : la lecture repart", async () => {
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let index = 0;
    const execute = vi.fn(() => (answers[index++] as ReturnType<typeof deferred<unknown>>).promise);
    const store = createQueryStore({ execute });
    const page = recorder();
    store.subscribe(tickets, page.listener);
    store.invalidate({ modules: ["jira"] });
    answers[0]?.resolve("avant");
    await flush();
    expect(page.last()?.data).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    answers[1]?.resolve("après");
    await flush();
    expect(page.last()?.data).toBe("après");
  });

  it("une erreur garde la dernière valeur", async () => {
    let fail = false;
    const store = createQueryStore({
      execute: async () => {
        if (fail) throw Object.assign(new Error("Jira a répondu 503."), { detail: { status: 503 } });
        return "liste";
      },
    });
    const page = recorder();
    store.subscribe(tickets, page.listener);
    await flush();
    fail = true;
    await expect(store.refresh(tickets)).rejects.toThrow("503");
    await flush();
    expect(page.last()).toMatchObject({ data: "liste", error: { message: "Jira a répondu 503." }, loading: false });
  });

  it("une relecture périodique ne part qu’une fois pour toutes les pages, et s’arrête sans abonné", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => "vert");
    const store = createQueryStore({ execute });
    const stopA = store.subscribe({ reference: "jenkins/etat", input: {} }, recorder().listener, { refreshEvery: 10 });
    const stopB = store.subscribe({ reference: "jenkins/etat", input: {} }, recorder().listener, { refreshEvery: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    // 2 s demandées : ramenées au minimum de 5 s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(2);
    stopB();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledTimes(3);
    stopA();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("oublie une lecture sans abonné après dix minutes", async () => {
    let time = 0;
    const store = createQueryStore({ execute: async () => 1, now: () => time });
    await store.run(tickets);
    time = 11 * 60_000;
    await store.run({ reference: "jira/autre", input: {} });
    expect(store.size()).toBe(1);
    expect(store.peek(tickets).data).toBeUndefined();
  });
});
