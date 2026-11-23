import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent, openExternal } from "../../lib/native";
import type {
  ModuleSummary,
  NewTab,
  PageTemplate,
  ResolvedPage,
  ResolvedSection,
  SectionTemplate,
  Snapshot,
} from "../../lib/types";
import { useShell } from "../../shell/store";
import type { ClientConfig, ClientInstanceConfig, ClientInstanceItem, ClientItem } from "../clients/api";
import { renderWithSocle } from "../modules/settingsHarness";
import type { VaultEntry } from "../vault/api";
import type { ModuleSetup, SetupStep } from "./api";
import { closeOnboarding, OnboardingHost, openOnboarding } from "./Onboarding";

/**
 * Parcours de configuration d’un module, de la page vers le compte, contre un faux backend qui tient le menu
 * (`space.menu.*`), les comptes de l’espace et leurs tests comme Alfred.
 */
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

type Stored = ClientConfig & { instances: ClientInstanceConfig[] };
let stored: Stored[];
let vault: VaultEntry[];
/** Dernier test de chaque compte (`client#instance`). */
let tests: Record<string, { ok: boolean; message: string }>;
/** Réponse du prochain test : réussite, ou la raison d’un échec. */
let nextTest: Array<"ok" | "refused" | "unreachable">;
let compatible: Record<string, string[]>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const _emit = (name: string) => {
  for (const handler of listeners.get(name) ?? []) handler({});
};
/** Arguments d’un appel, sans l’espace que la coquille peut joindre pour se protéger d’un changement d’espace. */
const argsOf = ({ space: _, ...rest }: Record<string, unknown>) => rest;
const lastCall = (command: string) => {
  const found = calls.filter((call) => call.command === command).at(-1);
  return found ? argsOf(found.args) : undefined;
};
const callsOf = (command: string) => calls.filter((call) => call.command === command).map((call) => argsOf(call.args));

const PREFECT_METHODS = [
  {
    id: "cle-api",
    label: "Prefect Cloud (clé d’API)",
    type: "bearer" as const,
    tokenPage: "https://app.prefect.cloud/my/api-keys",
    urlExample: "https://api.prefect.cloud/api/accounts/…/workspaces/…",
    help: "Dans Prefect Cloud : votre profil, puis Clés d’API, puis Créer.",
  },
  {
    id: "identifiant",
    label: "Serveur de l’entreprise (identifiant et mot de passe)",
    type: "basic" as const,
    urlExample: "https://prefect.entreprise.fr/api",
  },
];

function describe(config: Stored): ClientItem {
  const instances: ClientInstanceItem[] = config.instances.map((instance, index) => {
    const type = config.methods?.find((method) => method.id === instance.method)?.type ?? "none";
    const secret = vault.find((entry) => entry.id === instance.secret);
    const status = type === "none" || secret ? "ready" : "missingSecret";
    const test = tests[`${config.id}#${instance.id}`];
    return {
      ...instance,
      default: index === 0,
      status,
      hasSecret: Boolean(secret),
      connected: null,
      problem: null,
      validation: null,
      effectiveUrl: instance.url ?? config.baseUrl,
      authType: type,
      lastTest: test ? { ...test, testedAt: "2026-11-19T10:00:00Z" } : null,
    };
  });
  return {
    ...config,
    headers: {},
    methods: config.methods ?? [],
    instances,
    simple: false,
    status: instances.length === 0 ? "noInstance" : "ready",
    hasSecret: false,
    connected: null,
    usedBy: [],
    problem: null,
    validation: null,
  };
}

function summary(id: string, name: string, extra: Partial<ModuleSummary> = {}): ModuleSummary {
  return {
    id,
    name,
    version: "1.0.0",
    description: "",
    readOnly: true,
    origin: null,
    hidden: false,
    requires: [],
    requiredBy: [],
    pages: 1,
    functions: 0,
    clients: [],
    webhooks: [],
    schedules: [],
    ...extra,
  };
}

let modules: ModuleSummary[];

function needsOf() {
  return modules.flatMap((module) =>
    module.clients.map((need) => ({
      key: `${module.id}/${need.id}`,
      module: module.id,
      moduleName: module.name,
      id: need.id,
      label: need.label,
      baseUrl: null,
      auth: null,
      binding: null,
      client: stored.some((client) => client.id === need.id) ? need.id : null,
    })),
  );
}

function setupOf(module: ModuleSummary): ModuleSetup {
  const steps: SetupStep[] = module.clients.map((need) => {
    const client = stored.find((known) => known.id === need.id);
    const item = client ? describe(client) : undefined;
    const ready = item?.instances.filter((instance) => instance.status === "ready") ?? [];
    const state: SetupStep["state"] = !item
      ? "missing"
      : ready.length === 0
        ? "incomplete"
        : ready.some((instance) => instance.lastTest?.ok)
          ? "ready"
          : ready.every((instance) => instance.lastTest)
            ? "failed"
            : "untested";
    return {
      key: `${module.id}/${need.id}`,
      module: module.id,
      moduleName: module.name,
      need: need.id,
      label: need.label,
      help: need.help ?? "",
      optional: false,
      hasTemplate: Boolean(need.client),
      client: item ? item.id : null,
      state,
    };
  });
  return {
    module: module.id,
    name: module.name,
    description: module.description,
    welcome: module.setup?.welcome ?? "",
    installed: true,
    ready: steps.every((step) => step.state === "ready"),
    steps,
  };
}

function template(
  module: string,
  id: string,
  title: string,
  section: string,
  need: string,
  follows = false,
): PageTemplate {
  return {
    reference: `${module}/${id}`,
    module,
    title,
    icon: null,
    description: `Description de ${title}.`,
    section: `${module}/${section}`,
    needs: [need],
    perInstance: follows ? need : null,
  };
}

function sectionTemplate(module: string, id: string, label: string, pages: string[]): SectionTemplate {
  return { id: `${module}/${id}`, module, label, icon: null, iconUrl: null, color: "blue", pages };
}

function tab(
  reference: string,
  templateRef: string,
  title: string,
  accounts: Record<string, string> = {},
  follows?: string,
): ResolvedPage {
  return {
    reference,
    module: templateRef.split("/")[0] ?? "",
    id: templateRef.split("/")[1] ?? "",
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: true,
    missing: false,
    errors: [],
    uses: {},
    panel: null,
    perInstance: follows ?? null,
    template: templateRef,
    accounts,
  };
}

function entry(id: string, label: string, pages: ResolvedPage[]): ResolvedSection {
  return {
    id,
    module: id.split("/")[0] ?? "",
    label,
    icon: null,
    color: "blue",
    hidden: false,
    pages,
    instanceOf: id.split("@")[0],
  };
}

const TEMPLATES: PageTemplate[] = [
  template("prefect", "deploiements", "Déploiements", "principal", "prefect", true),
  template("atlassian", "jira", "Jira", "jira", "jira"),
  template("atlassian", "bitbucket", "Bitbucket", "bitbucket", "bitbucket"),
];
const SECTION_TEMPLATES: SectionTemplate[] = [
  sectionTemplate("prefect", "principal", "Prefect", ["prefect/deploiements"]),
  sectionTemplate("atlassian", "jira", "Jira", ["atlassian/jira"]),
  sectionTemplate("atlassian", "bitbucket", "Bitbucket", ["atlassian/bitbucket"]),
];

const templates: PageTemplate[] = [];
const sectionTemplates: SectionTemplate[] = [];

/** Le menu après l’import : chaque modèle y est une fois. */
function freshMenu(): ResolvedSection[] {
  return [
    entry("prefect/principal", "Prefect", [
      tab("prefect/deploiements", "prefect/deploiements", "Déploiements", {}, "prefect"),
    ]),
    entry("atlassian/jira", "Jira", [tab("atlassian/jira", "atlassian/jira", "Jira")]),
    entry("atlassian/bitbucket", "Bitbucket", [tab("atlassian/bitbucket", "atlassian/bitbucket", "Bitbucket")]),
  ];
}

function setSnapshot(sections: ResolvedSection[]) {
  useShell.setState({
    snapshot: {
      path: "/espace",
      name: "Essai",
      accent: null,
      sections,
      settingsPages: [],
      modules,
      functions: [],
      bindings: {},
      problems: [],
      templates,
      sectionTemplates,
      compatibleClients: compatible,
    } as unknown as Snapshot,
  });
}

const sections = () => useShell.getState().snapshot?.sections ?? [];
let copies = 0;

/** Ce que fait `space.menu.*` : la vue rendue à la coquille. */
function menu(command: string, args: Record<string, unknown>) {
  let created: string | undefined;
  let list = sections().map((section) => ({ ...section, pages: [...section.pages] }));
  const newTab = (input: NewTab): ResolvedPage => {
    const known = templates.find((item) => item.reference === input.page) as PageTemplate;
    copies += 1;
    return tab(
      `${input.page}@${copies}`,
      input.page,
      input.label ?? known.title,
      input.accounts ?? {},
      known.perInstance ?? undefined,
    );
  };
  switch (command) {
    case "space.menu.addPage": {
      const { section, tabs, label } = args as { section: string; tabs: NewTab[]; label?: string };
      const known = sectionTemplates.find((item) => item.id === section) as SectionTemplate;
      copies += 1;
      created = `${section}@${copies}`;
      list.push({ ...entry(created, label ?? known.label, tabs.map(newTab)), instanceOf: section });
      break;
    }
    case "space.menu.addTab": {
      const { page, tab: input } = args as { page: string; tab: NewTab };
      const made = newTab(input);
      created = made.reference;
      list = list.map((section) => (section.id === page ? { ...section, pages: [...section.pages, made] } : section));
      break;
    }
    case "space.menu.configure": {
      const { target, label, accounts } = args as { target: string; label?: string; accounts?: Record<string, string> };
      list = list.map((section) =>
        section.id === target
          ? { ...section, label: label ?? section.label }
          : {
              ...section,
              pages: section.pages.map((page) =>
                page.reference === target
                  ? { ...page, title: label ?? page.title, accounts: accounts ?? page.accounts }
                  : page,
              ),
            },
      );
      break;
    }
    case "space.menu.remove": {
      const { target } = args as { target: string };
      list = list
        .filter((section) => section.id !== target)
        .map((section) => ({
          ...section,
          pages: section.pages.filter((page) => page.reference !== target),
        }));
      break;
    }
  }
  setSnapshot(list);
  return { ...useShell.getState().snapshot, created };
}

beforeEach(() => {
  closeOnboarding();
  templates.splice(0, templates.length, ...TEMPLATES);
  sectionTemplates.splice(0, sectionTemplates.length, ...SECTION_TEMPLATES);
  stored = [];
  vault = [];
  tests = {};
  nextTest = [];
  compatible = {};
  calls = [];
  copies = 0;
  listeners.clear();
  modules = [
    summary("prefect", "Prefect", {
      description: "Vos déploiements Prefect.",
      setup: { welcome: "Suivez vos déploiements Prefect d’un coup d’œil." },
      clients: [
        {
          id: "prefect",
          label: "Prefect",
          help: "Indiquez l’adresse de l’API Prefect.",
          client: { label: "Prefect", headers: {}, methods: PREFECT_METHODS, testPath: "/health" },
        },
      ],
    } as Partial<ModuleSummary>),
    summary("atlassian", "Atlassian", {
      clients: [
        {
          id: "jira",
          label: "Jira",
          client: { label: "Jira", methods: [{ id: "pat", label: "Jeton personnel", type: "bearer" }] },
        },
        {
          id: "bitbucket",
          label: "Bitbucket",
          client: { label: "Bitbucket", methods: [{ id: "pat", type: "bearer" }] },
        },
      ],
    } as Partial<ModuleSummary>),
  ];
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    if (command.startsWith("space.menu.")) return menu(command, args);
    switch (command) {
      case "modules.setup":
        return { modules: modules.map(setupOf) };
      case "clients.list":
        return { clients: stored.map(describe), needs: needsOf(), redirectUri: null };
      case "clients.save": {
        const config = (args as { client: ClientConfig }).client;
        const next: Stored = { ...config, instances: stored.find((known) => known.id === config.id)?.instances ?? [] };
        stored = [...stored.filter((known) => known.id !== config.id), next];
        return describe(next);
      }
      case "clients.saveInstance": {
        const { client, instance, create } = args as {
          client: string;
          instance: ClientInstanceConfig;
          create: boolean;
        };
        const owner = stored.find((known) => known.id === client) as Stored;
        owner.instances = create
          ? [...owner.instances, instance]
          : owner.instances.map((known) => (known.id === instance.id ? instance : known));
        delete tests[`${client}#${instance.id}`];
        return describe(owner);
      }
      case "clients.connect":
        return { authorizationUrl: "https://auth.outil.fr/authorize?state=x" };
      case "clients.probe":
        return { ok: true, status: 200, reason: null, message: "L’adresse répond (200)." };
      case "clients.test": {
        const { id, instance } = args as { id: string; instance?: string };
        const outcome = nextTest.shift() ?? "ok";
        const ok = outcome === "ok";
        tests[`${id}#${instance ?? "default"}`] = { ok, message: ok ? "Le service répond (200)." : "Refusé (401)." };
        return {
          ok,
          status: ok ? 200 : outcome === "refused" ? 401 : null,
          durationMs: 10,
          message: tests[`${id}#${instance ?? "default"}`]?.message,
          reason: ok ? null : outcome,
        };
      }
      case "vault.list":
        return vault;
      case "vault.save": {
        const input = args as unknown as VaultEntry & { secrets: Record<string, string> };
        const saved: VaultEntry = {
          id: input.id ?? `secret-${vault.length + 1}`,
          label: input.label,
          kind: input.kind,
          meta: input.meta,
          updatedAt: "2026-11-19T10:00:00Z",
          hasSecret: true,
        };
        vault = [...vault.filter((known) => known.id !== saved.id), saved];
        return saved;
      }
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

function prefectAccount(client: string, id: string, label: string, tested = true) {
  vault.push({ id: `s-${client}-${id}`, label, kind: "token", meta: {}, updatedAt: "", hasSecret: true });
  const found = stored.find((known) => known.id === client);
  const instance = {
    id,
    label,
    url: `https://${id}.prefect.acme.fr/api`,
    method: "cle-api",
    secret: `s-${client}-${id}`,
  };
  if (found) found.instances.push(instance);
  else
    stored.push({
      id: client,
      label: client === "prefect" ? "Prefect" : "Prefect (équipe)",
      baseUrl: "",
      methods: PREFECT_METHODS,
      instances: [instance],
    });
  if (tested) tests[`${client}#${id}`] = { ok: true, message: "Le service répond (200)." };
}

async function open(module: string, start: "intro" | "resume" = "intro") {
  renderWithSocle(<OnboardingHost />);
  openOnboarding(module, start);
  return screen.findByRole("dialog", { name: `Configurer ${modules.find((item) => item.id === module)?.name}` });
}

/**
 * Nom d’une case ou d’un bouton radio de Socle par son seul libellé : le nom accessible y colle la description
 * au libellé (« Recetterecette.prefect.acme.fr · Connecté »).
 */
function choice(label: string) {
  return (name: string, element: Element) => {
    const description = document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    return name === `${label}${description}`;
  };
}

/** Titres des étapes du `ProgressIndicator` de Socle, sans « (fait) » ni la précision de l’étape. */
function stepTitles(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("listitem")
    .map(
      (item) =>
        Array.from(item.querySelectorAll("span")).find(
          (span) =>
            !span.closest("[aria-hidden]") &&
            span.firstChild?.nodeType === Node.TEXT_NODE &&
            !span.textContent?.startsWith(" "),
        )?.firstChild?.textContent ?? "",
    );
}

it("choix des pages : chaque modèle coché une fois, une page décochée, une deuxième ajoutée et renommée", async () => {
  const user = userEvent.setup();
  setSnapshot(freshMenu());
  const dialog = await open("atlassian");
  await user.click(await within(dialog).findByRole("button", { name: "Commencer" }));
  expect(within(dialog).getByRole("heading", { name: "Quelles pages voulez-vous ?" })).toBeTruthy();
  expect(within(dialog).getByRole("checkbox", { name: choice("Jira") })).toBeChecked();
  expect(within(dialog).getByRole("checkbox", { name: choice("Bitbucket") })).toBeChecked();
  // Ni interrupteur ni menu « ⋯ » : des cases et des boutons simples.
  expect(within(dialog).queryByRole("switch")).toBeNull();
  await user.click(within(dialog).getByRole("checkbox", { name: choice("Bitbucket") }));
  await user.click(within(dialog).getByRole("button", { name: "Une autre page « Jira »" }));
  await user.click(within(dialog).getByRole("button", { name: "Renommer la page Jira 2" }));
  const field = within(dialog).getByRole("textbox", { name: "Nom de la page Jira" });
  await user.clear(field);
  await user.type(field, "Jira Recette{Enter}");
  await user.click(within(dialog).getByRole("button", { name: "Continuer" }));
  await waitFor(() => expect(lastCall("space.menu.remove")).toEqual({ target: "atlassian/bitbucket" }));
  expect(lastCall("space.menu.addPage")).toEqual({
    section: "atlassian/jira",
    label: "Jira Recette",
    tabs: [{ page: "atlassian/jira" }],
  });
  // Une étape par page cochée : Jira, puis Jira Recette.
  const steps = within(dialog).getByRole("list", { name: "Étapes de la configuration de Atlassian" });
  expect(stepTitles(steps)).toEqual(["Présentation", "Vos pages", "Jira", "Jira Recette", "Terminé"]);
  // Aucun compte Jira dans l’espace : l’assistant s’ouvre tout de suite.
  expect(await within(dialog).findByRole("heading", { name: "Connecter votre compte Jira" })).toBeTruthy();
  // Pas de vocabulaire technique.
  expect(dialog.textContent).not.toMatch(/service|instance|panneau|besoin|client/i);
});

it("reprend un compte déjà connecté par un autre module, puis ajoute un onglet pour un second compte", async () => {
  const user = userEvent.setup();
  prefectAccount("prefect-equipe", "partage", "Partagé");
  prefectAccount("prefect", "recette", "Recette");
  compatible = { "prefect/prefect": ["prefect", "prefect-equipe"] };
  setSnapshot(freshMenu());
  const dialog = await open("prefect", "resume");
  expect(
    await within(dialog).findByRole("heading", { name: "À quel compte Prefect se connecter pour « Prefect » ?" }),
  ).toBeTruthy();
  const cards = within(dialog).getByRole("radiogroup", { name: "Compte Prefect" });
  expect(
    within(cards)
      .getAllByRole("radio")
      .map((card) => card.closest("label")?.textContent),
  ).toEqual([expect.stringContaining("Recette"), expect.stringContaining("Partagé")]);
  expect(within(dialog).getByRole("button", { name: "Connecter un nouveau compte" })).toBeTruthy();
  const shared = within(cards).getByRole("radio", { name: choice("Partagé") });
  expect(shared).toHaveAccessibleDescription("partage.prefect.acme.fr · déjà utilisé par Prefect (équipe) · Connecté");
  await user.click(shared);
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({
      target: "prefect/deploiements",
      accounts: { prefect: "prefect-equipe/partage" },
    }),
  );
  // Après le premier compte : un autre ?
  expect(await within(dialog).findByRole("heading", { name: "Vous avez un autre compte Prefect ?" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Non, c’est tout" })).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Ajouter un onglet pour un autre compte" }));
  const others = await within(dialog).findByRole("radiogroup", { name: "Compte Prefect" });
  // Le compte déjà choisi n’est plus proposé.
  expect(within(others).queryByRole("radio", { name: /Partagé/ })).toBeNull();
  await user.click(within(others).getByRole("radio", { name: choice("Recette") }));
  await waitFor(() =>
    expect(lastCall("space.menu.addTab")).toEqual({
      page: "prefect/principal",
      tab: { page: "prefect/deploiements", label: "Recette", accounts: { prefect: "recette" } },
    }),
  );
  // Le premier onglet prend le nom de son compte.
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({ target: "prefect/deploiements", label: "Partagé" }),
  );
  expect(sections()[0]?.pages.map((page) => page.title)).toEqual(["Partagé", "Recette"]);
  await within(dialog).findByRole("heading", { name: "Vous avez un autre compte Prefect ?" });
  await user.click(within(dialog).getByRole("button", { name: "Non, c’est tout" }));
  // Fin : le menu tel qu’il sera, et « Ouvrir ».
  const preview = await within(dialog).findByRole("grid", { name: "Aperçu du menu" });
  expect(preview.textContent).toContain("Prefect");
  expect(preview.textContent).toContain("Recette");
  expect(within(dialog).getByRole("button", { name: "Ouvrir « Prefect »" })).toBeTruthy();
});

it("connecte un nouveau compte pas à pas : méthode en clair, page du jeton, échec de test expliqué, puis réussite", async () => {
  const user = userEvent.setup();
  setSnapshot(freshMenu());
  nextTest = ["refused", "ok"];
  const dialog = await open("prefect", "resume");
  // Aucun compte Prefect : l’assistant d’abord.
  expect(await within(dialog).findByRole("heading", { name: "Connecter votre compte Prefect" })).toBeTruthy();
  expect(within(dialog).getByLabelText("Nom du compte")).toHaveValue("Mon Prefect");
  expect(within(dialog).getByRole("radio", { name: "Prefect Cloud (clé d’API)" })).toBeChecked();
  const address = within(dialog).getByLabelText("Adresse");
  await user.type(address, "https://api.prefect.cloud/api/accounts/a/workspaces/b");
  await user.tab();
  expect(await within(dialog).findByText("L’adresse répond.")).toBeTruthy();
  expect(lastCall("clients.probe")).toEqual({ url: "https://api.prefect.cloud/api/accounts/a/workspaces/b" });
  expect(within(dialog).getByText("Dans Prefect Cloud : votre profil, puis Clés d’API, puis Créer.")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Créer mon jeton" }));
  expect(openExternal).toHaveBeenCalledWith("https://app.prefect.cloud/my/api-keys");
  await user.type(within(dialog).getByLabelText("Collez votre jeton ici"), "mauvais-jeton");
  await user.click(within(dialog).getByRole("button", { name: "Connecter" }));
  // Échec : un message clair, le compte reste enregistré et donné à la page.
  expect(
    await within(dialog).findByText(
      "Le jeton a été refusé. Vérifiez que vous l’avez copié en entier, ou créez-en un nouveau.",
    ),
  ).toBeTruthy();
  expect(lastCall("clients.saveInstance")).toMatchObject({
    client: "prefect",
    create: true,
    instance: {
      id: "mon-prefect",
      label: "Mon Prefect",
      method: "cle-api",
      url: "https://api.prefect.cloud/api/accounts/a/workspaces/b",
    },
  });
  expect(lastCall("space.menu.configure")).toEqual({
    target: "prefect/deploiements",
    accounts: { prefect: "mon-prefect" },
  });
  // Nouvel essai : le même compte est modifié, pas un second créé.
  await user.type(within(dialog).getByLabelText(/^Collez votre jeton ici/), "bon-jeton");
  await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
  expect(await within(dialog).findByRole("heading", { name: "Vous avez un autre compte Prefect ?" })).toBeTruthy();
  expect(lastCall("clients.saveInstance")).toMatchObject({ create: false, instance: { id: "mon-prefect" } });
  expect(callsOf("clients.saveInstance")).toHaveLength(2);
  expect(callsOf("vault.save").map((call) => (call as { secrets: Record<string, string> }).secrets)).toEqual([
    { value: "mauvais-jeton" },
    { value: "bon-jeton" },
  ]);
});

it("un serveur d’entreprise : la méthode se choisit en clair, un identifiant refusé se dit comme tel", async () => {
  const user = userEvent.setup();
  setSnapshot(freshMenu());
  nextTest = ["refused"];
  const dialog = await open("prefect", "resume");
  await within(dialog).findByRole("heading", { name: "Connecter votre compte Prefect" });
  await user.click(
    within(dialog).getByRole("radio", { name: "Serveur de l’entreprise (identifiant et mot de passe)" }),
  );
  expect(within(dialog).getByLabelText("Adresse")).toHaveAttribute("placeholder", "https://prefect.entreprise.fr/api");
  // Sans page de jeton déclarée, pas de bouton « Créer mon jeton ».
  expect(within(dialog).queryByRole("button", { name: "Créer mon jeton" })).toBeNull();
  await user.type(within(dialog).getByLabelText("Adresse"), "https://prefect.acme.fr/api");
  await user.type(within(dialog).getByLabelText("Identifiant"), "alice");
  await user.type(within(dialog).getByLabelText("Mot de passe ou jeton"), "secret");
  await user.click(within(dialog).getByRole("button", { name: "Connecter" }));
  expect(
    await within(dialog).findByText("L’identifiant ou le mot de passe a été refusé. Vérifiez-les, puis réessayez."),
  ).toBeTruthy();
});

it("reprend après « Terminer plus tard » à la première page qui attend un compte", async () => {
  const user = userEvent.setup();
  // Prefect a son compte, testé ; Jira n’en a pas.
  prefectAccount("prefect", "prod", "Prod");
  modules = [
    {
      ...summary("tout", "Tout"),
      clients: [modules[0]?.clients[0], modules[1]?.clients[0]].filter(Boolean),
    } as ModuleSummary,
  ];
  const own = (ref: PageTemplate) => ({
    ...ref,
    module: "tout",
    reference: ref.reference.replace(/^[a-z]+\//, "tout/"),
  });
  templates.splice(
    0,
    templates.length,
    own(template("prefect", "deploiements", "Déploiements", "principal", "prefect", true)),
    own(template("atlassian", "jira", "Jira", "jira", "jira")),
  );
  sectionTemplates.splice(
    0,
    sectionTemplates.length,
    sectionTemplate("tout", "principal", "Prefect", ["tout/deploiements"]),
    sectionTemplate("tout", "jira", "Jira", ["tout/jira"]),
  );
  setSnapshot([
    entry("tout/principal", "Prefect", [
      tab("tout/deploiements", "tout/deploiements", "Déploiements", { prefect: "prod" }, "prefect"),
    ]),
    entry("tout/jira", "Jira", [tab("tout/jira", "tout/jira", "Jira")]),
  ]);
  let dialog = await open("tout");
  await user.click(await within(dialog).findByRole("button", { name: "Commencer" }));
  await user.click(within(dialog).getByRole("button", { name: "Continuer" }));
  // La page Prefect est prête : son compte Prod est choisi.
  const cards = await within(dialog).findByRole("radiogroup", { name: "Compte Prefect" });
  expect(within(cards).getByRole("radio", { name: choice("Prod") })).toBeChecked();
  await user.click(within(dialog).getByRole("button", { name: "Terminer plus tard" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // À la reprise : directement la page Jira, qui attend encore un compte.
  openOnboarding("tout", "resume");
  dialog = await screen.findByRole("dialog", { name: "Configurer Tout" });
  expect(await within(dialog).findByRole("heading", { name: "Connecter votre compte Jira" })).toBeTruthy();
  const steps = within(dialog).getByRole("list", { name: "Étapes de la configuration de Tout" });
  expect(within(steps).getAllByRole("listitem")[stepTitles(steps).indexOf("Jira")]).toHaveAttribute(
    "aria-current",
    "step",
  );
});

it("un module qui déclare son application OAuth : « Se connecter avec… », sans jeton à créer", async () => {
  const user = userEvent.setup();
  modules = [
    summary("outil", "Outil", {
      clients: [
        {
          id: "outil",
          label: "Outil",
          client: {
            label: "Outil",
            baseUrl: "https://api.outil.fr",
            methods: [
              {
                id: "sso",
                label: "Compte Outil",
                type: "oauth2",
                authorizationUrl: "https://auth.outil.fr/authorize",
                tokenUrl: "https://auth.outil.fr/token",
                clientId: "alfred-public",
              },
            ],
          },
        },
      ],
    } as Partial<ModuleSummary>),
  ];
  templates.splice(0, templates.length, template("outil", "tableau", "Tableau", "principal", "outil"));
  sectionTemplates.splice(
    0,
    sectionTemplates.length,
    sectionTemplate("outil", "principal", "Outil", ["outil/tableau"]),
  );
  setSnapshot([entry("outil/principal", "Outil", [tab("outil/tableau", "outil/tableau", "Tableau")])]);
  const dialog = await open("outil", "resume");
  await within(dialog).findByRole("heading", { name: "Connecter votre compte Outil" });
  // Ni adresse (le module la fixe), ni identifiant, ni jeton.
  expect(within(dialog).queryByLabelText("Adresse")).toBeNull();
  expect(within(dialog).queryByRole("textbox", { name: /Identifiant|jeton/ })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Se connecter avec Outil" }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://auth.outil.fr/authorize?state=x"));
  expect(lastCall("vault.save")).toMatchObject({ kind: "oauth2", meta: { clientId: "alfred-public" }, secrets: {} });
  expect(lastCall("clients.connect")).toEqual({ id: "outil", instance: "mon-outil" });
  // Connecté : le compte est testé, puis la page passe à la suite.
  expect(await within(dialog).findByRole("heading", { name: "Vous avez un autre compte Outil ?" })).toBeTruthy();
  expect(lastCall("clients.test")).toEqual({ id: "outil", instance: "mon-outil" });
});
