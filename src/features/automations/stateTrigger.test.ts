import { expect, it } from "vitest";
import { triggerLabel } from "./api";

it("dit en clair le déclencheur « un état change »", () => {
  expect(triggerLabel({ kind: "state", state: "jira/tickets-du-filtre", params: { jql: "assignee = moi" } })).toBe(
    "Quand jira/tickets-du-filtre change (jql = assignee = moi)",
  );
  expect(triggerLabel({ kind: "state", state: "mail/boite-de-reception" })).toBe(
    "Quand mail/boite-de-reception change",
  );
});
