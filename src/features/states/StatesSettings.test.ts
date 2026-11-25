import { describe, expect, it } from "vitest";
import { type Refresher, refresherRow, since } from "./StatesSettings";

const base: Refresher = {
  key: "k",
  state: "jira/tickets-du-filtre",
  description: "",
  params: { jql: "assignee = moi" },
  instance: "acme",
  examples: false,
  subscribers: ["page sprint/tableau", "automatisation nouveaux-tickets"],
  every: 30,
  incremental: true,
  mode: "subscribed",
  function: "rafraichir",
  running: false,
  runs: 3,
  lastRunAt: 1_000_000 - 12_000,
  lastError: null,
  failures: 0,
};

describe("ligne d’un état suivi", () => {
  it("dit l’état, ses abonnés, sa politique et son dernier passage", () => {
    expect(refresherRow(base, 1_000_000)).toMatchObject({
      state: "jira/tickets-du-filtre",
      account: "acme",
      subscribers: "2 abonnés",
      policy: "Toutes les 30 s, incrémental",
      last: "il y a 12 secondes",
      failures: "0",
      detail: "jql = assignee = moi",
    });
  });

  it("montre l’erreur du dernier passage et ce qui est en cours", () => {
    const failing = refresherRow({ ...base, lastError: "Jira a répondu 503.", failures: 2, subscribers: ["toujours"] });
    expect(failing.detail).toContain("Erreur : Jira a répondu 503.");
    expect(failing.subscribers).toBe("toujours");
    expect(refresherRow({ ...base, running: true }).last).toBe("En cours");
    expect(refresherRow({ ...base, every: null, lastRunAt: null }).policy).toBe("À la demande");
    expect(since(0, 3 * 60_000)).toBe("il y a 3 minutes");
  });
});
