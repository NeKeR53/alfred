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
import { SetupBanner } from "./SetupBanner";
import { resumeStep } from "./SetupFlow";

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

function emit(name: string) {
  for (const handler of listeners.get(name) ?? []) handler({});
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
        const saved: VaultEntry = { ...input, meta: {}, updatedAt: "2026-11-15T10:00:00Z", hasSecret: true };
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

it("guide la configuration d’un module : service créé depuis son modèle, clé saisie, test lancé d’office", async () => {
  const user = userEvent.setup();
  modules = [summary("boite", "Boîte", { description: "Vos mails importants.", clients: [GMAIL] })];
  renderModules();

  // La fiche signale le module incomplet et propose de terminer sa configuration.
  useShell.getState().setActiveTab(MODULE_FOCUS, "boite");
  const banner = await screen.findByText(/Ce module n’est pas encore prêt/);
  expect(banner.textContent).toContain("Reste à configurer : Gmail.");
  await user.click(screen.getByRole("button", { name: "Terminer la configuration" }));

  // Reprise : directement à l’étape du service qui manque, avec l’aide du module.
  expect(await screen.findByRole("heading", { name: "Gmail" })).toBeTruthy();
  expect(screen.getByText(GMAIL.help as string)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Ajouter Gmail" }));

  await waitFor(() => expect(stored).toHaveLength(1));
  expect(stored[0]).toMatchObject({
    id: "gmail",
    label: "Gmail",
    baseUrl: "https://gmail.googleapis.com",
    testPath: "/gmail/v1/users/me/profile",
  });

  // Le compte attend sa clé : elle va au coffre, puis est reliée au service.
  await user.click(await screen.findByRole("button", { name: "Saisir la clé de Gmail" }));
  // La saisie de la clé s’ouvre par-dessus le panneau de l’onboarding.
  const dialog = await screen.findByRole("dialog", { name: /clé|Gmail|coffre/i });
  await user.type(within(dialog).getByLabelText("Valeur"), "jeton-secret");
  await user.click(within(dialog).getByRole("button", { name: "Créer" }));

  await waitFor(() => expect(stored[0].auth?.secret).toBeTruthy());
  // Le compte prêt est testé sans clic de plus.
  expect(await screen.findByText(/Connexion réussie/)).toBeTruthy();
  expect(calls.filter((call) => call.command === "clients.test")).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "Suivant" }));
  expect(await screen.findByRole("heading", { name: "Boîte est prêt" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Terminer" }));
  // Le panneau se ferme ; la fiche, derrière, n’a plus de bandeau : le module est prêt.
  expect(useOnboarding.getState().module).toBeNull();
  await screen.findByRole("button", { name: "Tous les modules" });
  await waitFor(() => expect(screen.queryByText(/Ce module n’est pas encore prêt/)).toBeNull());
});

it("présente le module, compte les dépendances et les services facultatifs, et ne le dit pas prêt après un test raté", async () => {
  const user = userEvent.setup();
  testOk = false;
  stored = [{ id: "crm", label: "CRM", baseUrl: "https://crm.exemple.com", auth: { type: "none" } }];
  modules = [
    summary("suivi", "Suivi", {
      requires: [{ module: "annuaire" }],
      setup: { welcome: "Suivi relie vos tickets Jira à votre CRM." },
      clients: [
        { id: "jira", label: "Jira" },
        { id: "slack", label: "Slack", optional: true },
      ],
    }),
    summary("annuaire", "Annuaire", { hidden: true, clients: [{ id: "crm", label: "CRM" }] }),
  ];
  renderModules();
  // Comme juste après l’installation : le parcours s’ouvre.
  act(() => openOnboarding("suivi"));

  // Reprise à la première étape essentielle incomplète.
  expect(await screen.findByRole("heading", { name: "Jira" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Présentation" }));
  expect(screen.getByText("Suivi relie vos tickets Jira à votre CRM.")).toBeTruthy();
  const needs = screen.getByText("Pour fonctionner, il a besoin de ces services :").nextElementSibling as HTMLElement;
  expect(needs.textContent).toContain("Slack (facultatif)");
  expect(needs.textContent).toContain("CRM — pour Annuaire, installé avec lui");

  // L’étape du service de la dépendance : son compte, sans authentification, est testé d’office et échoue.
  await user.click(screen.getByRole("button", { name: "CRM" }));
  expect(await screen.findByText(/Le test a échoué\. Le service refuse/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Réessayer CRM" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Passer pour l’instant" }));
  expect(await screen.findByRole("heading", { name: "Presque fini" })).toBeTruthy();
  const left = screen.getByText("Il reste à configurer :").nextElementSibling as HTMLElement;
  expect(left.textContent).toContain("Jira — à configurer");
  expect(left.textContent).toContain("CRM — le test a échoué");
  expect(left.textContent).not.toContain("Slack");

  // Un nouvel essai qui réussit fait passer l’étape à « Prêt ».
  testOk = true;
  await user.click(within(left).getByRole("button", { name: "CRM" }));
  await user.click(await screen.findByRole("button", { name: "Réessayer CRM" }));
  expect(await screen.findByText(/Connexion réussie/)).toBeTruthy();

  await user.click(screen.getAllByRole("button", { name: /Terminer plus tard/ })[0]);
  // Le panneau se ferme ; la fiche du module dit ce qui reste.
  expect(useOnboarding.getState().module).toBeNull();
  act(() => useShell.getState().setActiveTab(MODULE_FOCUS, "suivi"));
  expect(await screen.findByText(/Reste à configurer : Jira\./)).toBeTruthy();
});

it("reprend à la première étape essentielle incomplète et résume ce qui reste", () => {
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
  expect(resumeStep(setup([step("a", "ready"), step("b", "missing", true), step("c", "untested")]))).toBe("c");
  expect(resumeStep(setup([step("a", "ready"), step("b", "missing", true)]))).toBe("b");
  expect(resumeStep(setup([step("a", "ready")]))).toBe("fin");
  expect(remainingSummary(setup([step("a", "failed"), step("b", "missing", true)]))).toBe("Reste à configurer : A.");
});

it("le bandeau d’une page propose de vérifier un service seulement pas encore testé, puis disparaît", async () => {
  const user = userEvent.setup();
  stored = [{ id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "none" } }];
  modules = [summary("boite", "Boîte", { clients: [GMAIL] })];
  render(<SetupBanner module="boite" />);
  expect(await screen.findByText("La connexion à Gmail n’a pas encore été vérifiée.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Vérifier" }));
  await waitFor(() => expect(screen.queryByText(/pas encore été vérifiée/)).toBeNull());
  expect(calls.filter((call) => call.command === "clients.test").map((call) => call.args)).toEqual([{ id: "gmail" }]);

  // Un test raté : le bandeau renvoie vers le parcours.
  testOk = false;
  delete tests.gmail;
  render(<SetupBanner module="boite" />);
  await user.click(await screen.findByRole("button", { name: "Vérifier" }));
  expect(await screen.findAllByText(/Gmail n’est pas encore configuré/)).not.toHaveLength(0);
});

it("une page qui n’utilise que les services prêts s’affiche sans bandeau, même si le module attend un autre service", async () => {
  stored = [{ id: "gmail", label: "Gmail", baseUrl: "https://gmail.googleapis.com", auth: { type: "none" } }];
  tests.gmail = { ok: true, message: "Le service répond (200)." };
  modules = [summary("boite", "Boîte", { clients: [GMAIL, { id: "agenda", label: "Agenda" }] })];
  const { unmount } = render(<SetupBanner module="boite" uses={{ clients: ["gmail"] }} />);
  await waitFor(() => expect(calls.some((call) => call.command === "modules.setup")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/configur/)).toBeNull();
  unmount();
  // La page qui a besoin de l’agenda, elle, le dit, sans alarmer : une partie du module marche déjà.
  render(<SetupBanner module="boite" uses={{ clients: ["agenda"] }} />);
  expect(await screen.findByText(/Agenda n’est pas encore configuré/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Configurer" })).toBeTruthy();
});
