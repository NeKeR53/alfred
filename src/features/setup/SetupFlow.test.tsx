import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import type { ClientNeed, ModuleSummary, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { ClientConfig, ClientInstanceItem, ClientItem } from "../clients/api";
import { MODULE_FOCUS, ModulesSettings } from "../modules/ModulesSettings";
import type { VaultEntry } from "../vault/api";
import { type ModuleSetup, remainingSummary, type SetupStep } from "./api";
import { OnboardingHost, openOnboarding, useOnboarding } from "./Onboarding";
import { pageNeeds, SetupGate } from "./SetupGate";

/**
 * Parcours de configuration d’un module, par l’écran réel des Réglages → Modules, contre un faux backend qui
 * calcule l’état des étapes comme `src-tauri/src/setup.rs`.
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

let modules: ModuleSummary[];
let stored: ClientConfig[];
let vault: VaultEntry[];
/** Résultat du dernier test, par service ; une modification du service l’efface. */
let tests: Record<string, { ok: boolean; message: string }>;
let testOk: boolean;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, Set<(payload: unknown) => void>>();

function emit(name: string, payload: unknown = {}) {
  for (const handler of listeners.get(name) ?? []) handler(payload);
}

function describe(config: ClientConfig): ClientItem {
  const type = config.auth?.type ?? "none";
  const secret = vault.find((item) => item.id === config.auth?.secret);
  const status: ClientInstanceItem["status"] = type === "none" || secret ? "ready" : "missingSecret";
  const instance: ClientInstanceItem = {
    id: "default",
    label: "Principale",
    method: "default",
    secret: config.auth?.secret,
    default: true,
    status,
    hasSecret: status === "ready",
    connected: null,
    problem: null,
    validation: null,
    effectiveUrl: config.baseUrl,
    authType: type,
    lastTest: tests[config.id] ? { ...tests[config.id], testedAt: "2026-11-15T10:00:00Z" } : null,
  };
  return {
    ...config,
    headers: config.headers ?? {},
    methods: [{ id: "default", type }],
    instances: [instance],
    simple: true,
    status,
    hasSecret: instance.hasSecret,
    connected: null,
    usedBy: [],
    problem: null,
    validation: null,
  };
}

function setupOf(module: ModuleSummary): ModuleSetup {
  const owners = [module, ...module.requires.map((req) => modules.find((m) => m.id === req.module) as ModuleSummary)];
  const steps: SetupStep[] = owners.flatMap((owner) =>
    owner.clients.map((need) => {
      const client = stored.find((known) => known.id === need.id);
      const item = client ? describe(client) : undefined;
      const instance = item?.instances[0];
      const state: SetupStep["state"] = !item
        ? "missing"
        : instance?.status !== "ready"
          ? "incomplete"
          : instance.lastTest?.ok
            ? "ready"
            : instance.lastTest
              ? "failed"
              : "untested";
      return {
        key: `${owner.id}/${need.id}`,
        module: owner.id,
        moduleName: owner.name,
        need: need.id,
        label: need.label,
        help: need.help ?? "",
        optional: Boolean(need.optional),
        hasTemplate: Boolean(need.client),
        client: item ? item.id : null,
        state,
      };
    }),
  );
  return {
    module: module.id,
    name: module.name,
    description: module.description,
    welcome: module.setup?.welcome ?? "",
    installed: true,
    ready: steps.every((step) => step.optional || step.state === "ready"),
    steps,
  };
}

beforeEach(() => {
  useOnboarding.setState({ module: null, start: "resume" });
  stored = [];
  vault = [];
  tests = {};
  testOk = true;
  calls = [];
  listeners.clear();
  useNotifications.getState().clear();
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "modules.setup":
        return { modules: modules.map(setupOf) };
      case "clients.list":
        return {
          clients: stored.map(describe),
          needs: modules.flatMap((module) =>
            module.clients.map((need) => ({
              key: `${module.id}/${need.id}`,
              module: module.id,
              moduleName: module.name,
              id: need.id,
              label: need.label,
              baseUrl: need.baseUrl ?? null,
              auth: need.auth ?? null,
              binding: null,
              client: stored.some((known) => known.id === need.id) ? need.id : null,
            })),
          ),
          redirectUri: null,
        };
      case "clients.save": {
        const config = (args as { client: ClientConfig }).client;
        stored = [...stored.filter((known) => known.id !== config.id), config];
        delete tests[config.id];
        emit("clients:changed");
        return describe(config);
      }
      case "clients.saveInstance": {
        // Le compte d’un service à une seule adresse : son entrée du coffre rejoint l’authentification.
        const { client, instance } = args as { client: string; instance: { secret?: string } };
        stored = stored.map((known) =>
          known.id === client
            ? { ...known, auth: { ...(known.auth ?? { type: "none" }), secret: instance.secret } }
            : known,
        );
        delete tests[client];
        emit("clients:changed");
        return describe(stored.find((known) => known.id === client) as ClientConfig);
      }
      case "clients.test": {
        const { id } = args as { id: string };
        tests[id] = testOk
          ? { ok: true, message: "Le service répond (200)." }
          : { ok: false, message: "Le service refuse l’authentification (401)." };
        emit("clients:changed");
        return { ok: testOk, status: testOk ? 200 : 401, durationMs: 12, message: tests[id].message };
      }
      case "vault.list":
        return vault;
      case "vault.save": {
        const input = args as unknown as VaultEntry;
        const saved: VaultEntry = {
          ...input,
          id: input.id ?? input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          meta: {},
          updatedAt: "2026-11-15T10:00:00Z",
          hasSecret: true,
        };
        vault = [...vault, saved];
        emit("vault:changed");
        return saved;
      }
      case "marketplace.list":
      case "marketplace.updates":
      case "marketplace.modules":
        return [];
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

function summary(id: string, name: string, extra: Partial<ModuleSummary> = {}): ModuleSummary {
  return {
    id,
    name,
    version: "1.0.0",
    description: "",
    readOnly: true,
    origin: {
      marketplace: "https://depot.exemple/modules.git",
      version: "1.0.0",
      commit: "abc",
      detached: false,
      pinned: false,
    },
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

const GMAIL: ClientNeed = {
  id: "gmail",
  label: "Gmail",
  help: "Créez un mot de passe d’application dans votre compte Google.",
  client: { baseUrl: "https://gmail.googleapis.com", auth: { type: "bearer" }, testPath: "/gmail/v1/users/me/profile" },
};

function renderModules() {
  const snapshot: Snapshot = {
    path: "/espace",
    name: "Démo",
    accent: null,
    sections: [],
    settingsPages: [],
    modules,
    functions: [],
    bindings: {},
    problems: [],
    layout: { sections: [] },
  } as unknown as Snapshot;
  useShell.setState({ snapshot });
  return render(
    <>
      <ModulesSettings />
      <OnboardingHost />
    </>,
  );
}

it("résume ce qui reste, compte par compte", () => {
  const step = (key: string, state: SetupStep["state"], optional = false): SetupStep => ({
    key,
    module: "m",
    moduleName: "M",
    need: key,
    label: key.toUpperCase(),
    help: "",
    optional,
    hasTemplate: false,
    client: null,
    state,
  });
  const setup = (steps: SetupStep[]): ModuleSetup => ({
    module: "m",
    name: "M",
    description: "",
    welcome: "",
    installed: true,
    ready: false,
    steps,
  });
  expect(remainingSummary(setup([step("a", "failed"), step("b", "missing", true)]))).toBe(
    "Test échoué pour A : vérifiez le compte, puis testez à nouveau.",
  );
  // Compte par compte quand on les connaît : lesquels tester, lesquels ont échoué.
  const accounts = (state: string) =>
    state === "untested"
      ? [
          { label: "Prod", status: "ready", lastTest: null },
          { label: "Recette", status: "ready", lastTest: null },
        ]
      : [{ label: "Prod", status: "ready", lastTest: { ok: false } }];
  expect(remainingSummary(setup([step("a", "untested"), step("b", "failed")]), (item) => accounts(item.state))).toBe(
    "Comptes A à tester : Prod et Recette. Test échoué pour B : Prod. Vérifiez ce compte, puis testez à nouveau.",
  );
  expect(remainingSummary(setup([step("a", "missing")]))).toBe("Compte A à ajouter.");
});

it("une page à qui il manque un service affiche la page d’attente, et son bouton ouvre l’onboarding du module", async () => {
  const user = userEvent.setup();
  modules = [summary("boite", "Boîte", { clients: [GMAIL] })];
  render(
    <SetupGate module="boite">
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Il manque un compte à cette page")).toBeTruthy();
  expect(screen.getByText("Pour l’afficher, ajoutez votre compte Gmail.")).toBeTruthy();
  expect(screen.queryByText("Vraie page")).toBeNull();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Configurer",
    "Voir avec des données d’exemple",
  ]);
  await user.click(screen.getByRole("button", { name: "Configurer" }));
  expect(useOnboarding.getState()).toEqual({ module: "boite", start: "resume", step: "boite/gmail" });
});

it("la page d’attente cède la place à la vraie page dès que le service est prêt, sans recharger", async () => {
  modules = [summary("boite", "Boîte", { clients: [GMAIL] })];
  render(
    <SetupGate module="boite">
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Il manque un compte à cette page")).toBeTruthy();
  stored = [{ id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "none" } }];
  tests.gmail = { ok: true, message: "Le service répond (200)." };
  act(() => emit("clients:changed"));
  expect(await screen.findByText("Vraie page")).toBeTruthy();
  expect(screen.queryByText(/attend/)).toBeNull();
});

it("un service seulement pas encore testé est vérifié de lui-même ; un test raté laisse la page d’attente", async () => {
  stored = [{ id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "none" } }];
  modules = [summary("boite", "Boîte", { clients: [GMAIL] })];
  const { unmount } = render(
    <SetupGate module="boite">
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Vraie page")).toBeTruthy();
  expect(calls.filter((call) => call.command === "clients.test").map((call) => call.args)).toEqual([{ id: "gmail" }]);
  unmount();

  testOk = false;
  delete tests.gmail;
  render(
    <SetupGate module="boite">
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(
    await screen.findByText("Pour l’afficher, vérifiez votre compte Gmail, dont la connexion a échoué."),
  ).toBeTruthy();
  expect(screen.queryByText("Vraie page")).toBeNull();
});

it("une page qui n’utilise que les services prêts s’affiche, même si le module attend un autre service", async () => {
  stored = [{ id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "none" } }];
  tests.gmail = { ok: true, message: "Le service répond (200)." };
  modules = [summary("boite", "Boîte", { clients: [GMAIL, { id: "agenda", label: "Agenda" }] })];
  const { unmount } = render(
    <SetupGate module="boite" uses={{ clients: ["gmail"] }}>
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Vraie page")).toBeTruthy();
  expect(screen.queryByText(/attend/)).toBeNull();
  unmount();
  render(
    <SetupGate module="boite" uses={{ clients: ["agenda"] }}>
      <p>Vraie page</p>
    </SetupGate>,
  );
  // L’autre page ne parle que de son compte, pas de Gmail, déjà prêt.
  expect(await screen.findByText("Pour l’afficher, ajoutez votre compte Agenda.")).toBeTruthy();
  expect(screen.queryByText("Vraie page")).toBeNull();
});

it("la page d’attente nomme chaque compte qui manque à la page, avec ce qu’il reste à faire", async () => {
  stored = [{ id: "agenda", label: "Agenda", baseUrl: "https://agenda.exemple", auth: { type: "bearer" } }];
  modules = [
    summary("boite", "Boîte", { clients: [GMAIL, { id: "agenda", label: "Agenda" }, { id: "slack", label: "Slack" }] }),
  ];
  render(
    <SetupGate module="boite" uses={{ clients: ["gmail", "agenda"] }}>
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Il manque des comptes à cette page")).toBeTruthy();
  expect(
    screen.getByText("Pour l’afficher, il reste à ajouter votre compte Gmail et à connecter votre compte Agenda."),
  ).toBeTruthy();
  expect(screen.queryByText(/Slack/)).toBeNull();
});

it("les comptes qui attendent la même chose sont regroupés sous un seul verbe", () => {
  const step = (label: string, state: SetupStep["state"], module = "boite"): SetupStep => ({
    key: `${module}/${label}`,
    module,
    moduleName: module === "boite" ? "Boîte" : "Atlassian",
    need: label,
    label,
    help: "",
    optional: false,
    hasTemplate: false,
    client: null,
    state,
  });
  expect(
    pageNeeds([step("Météo", "missing"), step("Agenda", "missing"), step("Jira", "missing", "atlassian")], "boite"),
  ).toBe(
    "Pour l’afficher, il reste à ajouter votre compte Météo, votre compte Agenda et votre compte Jira, utilisé par le module Atlassian.",
  );
  expect(pageNeeds([step("Gmail", "missing"), step("Agenda", "missing"), step("Slack", "untested")], "boite")).toBe(
    "Pour l’afficher, il reste à ajouter votre compte Gmail et votre compte Agenda, et à tester votre compte Slack.",
  );
});

it("un compte qui vient d’une dépendance est nommé avec son module, et le parcours s’ouvre sur son étape", async () => {
  const user = userEvent.setup();
  modules = [
    summary("atlassian", "Atlassian", { clients: [{ id: "jira", label: "Jira" }] }),
    summary("suivi", "Suivi", {
      clients: [{ id: "notes", label: "Notes" }],
      requires: [{ module: "atlassian" }] as ModuleSummary["requires"],
    }),
  ];
  useShell.setState({ snapshot: { modules, sections: [] } as unknown as Snapshot });
  render(
    <>
      <SetupGate module="suivi" uses={{ clients: ["atlassian/jira"] }}>
        <p>Vraie page</p>
      </SetupGate>
      <OnboardingHost />
    </>,
  );
  expect(
    await screen.findByText("Pour l’afficher, ajoutez votre compte Jira, utilisé par le module Atlassian."),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Configurer" }));
  expect(useOnboarding.getState()).toMatchObject({ module: "suivi", step: "atlassian/jira" });
  // Le parcours s’ouvre sur le compte Jira, pas sur la présentation du module ni sur Notes.
  const panel = await screen.findByRole("dialog", { name: "Configurer Suivi" });
  expect(await within(panel).findByRole("heading", { name: "Connecter votre compte Jira" })).toBeTruthy();
});

it("un service facultatif qui manque ne retient pas la page", async () => {
  modules = [summary("boite", "Boîte", { clients: [{ ...GMAIL, optional: true }] })];
  render(
    <SetupGate module="boite">
      <p>Vraie page</p>
    </SetupGate>,
  );
  expect(await screen.findByText("Vraie page")).toBeTruthy();
});

it("l’agent ouvre l’onboarding d’un module : le panneau s’ouvre sur sa présentation", async () => {
  modules = [summary("boite", "Boîte", { description: "Vos mails importants.", clients: [GMAIL] })];
  renderModules();
  act(() => emit("onboarding:open", { module: "boite" }));
  expect(await screen.findByRole("heading", { name: "Configurer Boîte" })).toBeTruthy();
  expect(screen.getByText("Vos mails importants.")).toBeTruthy();
  expect(useOnboarding.getState()).toEqual({ module: "boite", start: "intro" });
});

it("la fiche d’un module teste d’office un compte prêt jamais testé, et propose de tester à nouveau un test raté", async () => {
  const user = userEvent.setup();
  modules = [summary("boite", "Boîte", { clients: [GMAIL] })];
  vault = [
    { id: "jeton", label: "Jeton", kind: "token", meta: {}, updatedAt: "2026-11-15T10:00:00Z", hasSecret: true },
  ];
  stored = [
    { id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "bearer", secret: "jeton" } },
  ];
  testOk = false;
  renderModules();
  act(() => useShell.getState().setActiveTab(MODULE_FOCUS, "boite"));
  // Jamais testé : la fiche le teste d’elle-même, une fois ; il échoue, elle dit lequel et propose de retester.
  expect(await screen.findByText("Test échoué pour Gmail : vérifiez le compte, puis testez à nouveau.")).toBeTruthy();
  expect(calls.filter((call) => call.command === "clients.test")).toHaveLength(1);
  testOk = true;
  await user.click(screen.getByRole("button", { name: "Tester les comptes" }));
  await waitFor(() => expect(document.querySelector(".module-row__todo")).toBeNull());
  expect(calls.filter((call) => call.command === "clients.test")).toHaveLength(2);
});
