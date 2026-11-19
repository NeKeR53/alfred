import { expect, it } from "vitest";
import type { ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
import { accountsWithPage, baseOf, needsWithoutPage, otherGroupsUsing, pageGroups } from "./pageGroups";

function page(reference: string, title: string, extra: Partial<ResolvedPage> = {}): ResolvedPage {
  const [module, id] = reference.split("/");
  return {
    reference,
    module,
    id: id.replace(/@.*/, ""),
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: false,
    errors: [],
    uses: {},
    panel: null,
    ...extra,
  };
}

function section(id: string, label: string, pages: ResolvedPage[], extra: Partial<ResolvedSection> = {}) {
  return { id, module: id.split("/")[0], label, icon: null, color: null, hidden: false, pages, ...extra };
}

function snapshot(extra: Partial<Snapshot>): Snapshot {
  return {
    path: "/espace",
    name: "Démo",
    accent: null,
    sections: [],
    settingsPages: [],
    modules: [],
    functions: [],
    bindings: {},
    problems: [],
    ...extra,
  };
}

it("range les pages d’un module par entrée du menu, chacune avec les comptes dont elle se sert", () => {
  const groups = pageGroups(
    snapshot({
      sections: [
        section("atlassian/jira", "Jira", [
          page("atlassian/jira", "Jira", {
            uses: { clients: ["jira"] },
            panel: page("atlassian/ticket", "Ticket", { uses: { clients: ["jira", "confluence"] } }),
          }),
        ]),
        section("atlassian/support", "Support", [
          page("atlassian/support", "Support", { uses: { clients: ["jira"] } }),
        ]),
        section("outils/principal", "Outils", [page("atlassian/recherche", "Recherche")]),
      ],
      settingsPages: [page("atlassian/reglages", "Atlassian", { uses: { clients: ["annuaire/ldap"] } })],
    }),
    "atlassian",
  );
  expect(groups.map((group) => [group.key, group.title, group.place])).toEqual([
    ["atlassian/jira", "Jira", undefined],
    ["atlassian/support", "Support", undefined],
    ["ailleurs:outils/principal", "Outils", "Outils"],
    ["réglages", "Réglages", "Réglages"],
  ]);
  // Le panneau compte avec sa page ; un besoin d’une dépendance garde son module.
  expect(groups[0].needs).toEqual(["atlassian/jira", "atlassian/confluence"]);
  expect(groups[3].needs).toEqual(["annuaire/ldap"]);
  // Un compte partagé : Jira sert aussi à Support.
  expect(otherGroupsUsing(groups, "atlassian/jira", "atlassian/jira").map((group) => group.title)).toEqual(["Support"]);
  expect(needsWithoutPage(groups, ["atlassian/jira", "atlassian/bitbucket"])).toEqual(["atlassian/bitbucket"]);
});

it("replie les copies par compte sur la section et la page déclarées, sous le titre de la page", () => {
  const tab = (instance: string) =>
    page(`prefect/deploiements@${instance}`, instance === "prod" ? "Prod" : "Recette", {
      instance,
      perInstance: "prefect",
    });
  const snap = snapshot({
    sections: [
      section("prefect/principal", "Prefect", [tab("prod"), tab("recette")], {
        perInstance: "prefect",
        instancesAs: "tabs",
      }),
      section("jira/tickets@acme", "Tickets — Acme", [page("jira/liste@acme", "Liste", { instance: "acme" })], {
        perInstance: "jira",
        instance: "acme",
        instanceOf: "jira/tickets",
      }),
      section("jira/tickets@desk", "Tickets — Desk", [page("jira/liste@desk", "Liste", { instance: "desk" })], {
        perInstance: "jira",
        instance: "desk",
        instanceOf: "jira/tickets",
      }),
    ],
    accountPages: [
      {
        reference: "prefect/deploiements",
        module: "prefect",
        title: "Déploiements",
        section: "Prefect",
        need: "prefect",
        client: "prefect",
      },
    ],
    accounts: { "prefect/prod": ["prefect/deploiements"], "autre/prod": ["prefect/deploiements"] },
  });
  const groups = pageGroups(snap, "prefect");
  expect(groups).toHaveLength(1);
  const [prefect] = groups;
  expect(prefect.instancesAs).toBe("tabs");
  expect(prefect.pages.map((entry) => [entry.reference, entry.title, entry.perInstance])).toEqual([
    ["prefect/deploiements", "Déploiements", "prefect/prefect"],
  ]);
  // Seuls les comptes de ce service qui ont ajouté la page.
  expect([
    ...(accountsWithPage({ "prefect/prod": ["prefect/deploiements"] }, "prefect", prefect.pages[0]) ?? []),
  ]).toEqual(["prod"]);

  // Une section par compte : ses copies ne font qu’un groupe, sous la section déclarée.
  const jira = pageGroups(snap, "jira");
  expect(jira.map((group) => [group.key, group.pages.map((entry) => entry.reference)])).toEqual([
    ["jira/tickets", ["jira/liste"]],
  ]);
  expect(jira[0].pages[0].perInstance).toBe("jira/jira");
  expect(pageGroups(snapshot({}), "jira")).toEqual([]);
  expect(baseOf("jira/tickets@acme")).toBe("jira/tickets");
});
