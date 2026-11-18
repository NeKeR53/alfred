import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent, openExternal } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction, ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { ModulesSettings } from "../modules/ModulesSettings";
import type { VaultEntry } from "../vault/api";
import type {
  AuthType,
  ClientConfig,
  ClientInstanceConfig,
  ClientInstanceItem,
  ClientItem,
  ClientNeedItem,
  ClientValidation,
} from "./api";

/**
 * Les services se règlent dans l’onglet Modules, dans la fiche du module qui s’en sert : un service appartient à
 * ses modules. Ces parcours passent donc par l’écran réel.
 */
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const REDIRECT = "http://127.0.0.1:14731/oauth/callback";
const AUTHORIZE = "https://sso.exemple.com/authorize?state=abc";

/** Faux backend : clients de l’espace, coffre du poste et demandes des modules. */
let needs: ClientNeedItem[];
let vault: VaultEntry[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;
/** Clients créés ou modifiés hors des Réglages : identifiant → ce qui reste à valider. */
let pending: Record<string, ClientValidation>;
const listeners = new Map<string, (payload: unknown) => void>();

function entry(id: string, label: string, kind: VaultEntry["kind"], extra: Partial<VaultEntry> = {}): VaultEntry {
  return { id, label, kind, meta: {}, updatedAt: "2026-11-12T09:00:00Z", hasSecret: true, ...extra };
}

type Stored = ClientConfig & { instances?: ClientInstanceConfig[] };

/** État d’une instance, calculé comme le backend pour les cas du parcours. */
function instanceState(type: AuthType, secretId: string | undefined, pendingKey: string) {
  const secret = vault.find((item) => item.id === secretId);
  const oauth = type === "oauth2";
  const hasSecret = type === "none" || Boolean(secret && (secret.hasSecret || oauth));
  const connected = oauth ? Boolean(secret?.connected) : null;
  const validation: ClientValidation | null =
    type === "none"
      ? null
      : (pending[pendingKey] ?? { validated: true, everValidated: true, changes: [], fingerprint: {} });
  const status: ClientInstanceItem["status"] =
    validation?.validated === false
      ? "toValidate"
      : !hasSecret
        ? "missingSecret"
        : connected === false
          ? "toConnect"
          : "ready";
  return { hasSecret, connected, validation, status };
}

/** Reproduit le calcul d’état du backend pour les cas du parcours. */
function describe(config: Stored): ClientItem {
  const usedBy = needs
    .filter((need) => need.client === config.id)
    .map((need) => ({ key: need.key, module: need.module, moduleName: need.moduleName, label: need.label }));
  if (config.auth) {
    const { secret, ...method } = config.auth;
    const state = instanceState(config.auth.type, secret, config.id);
    const instance: ClientInstanceItem = {
      id: "default",
      label: "Principale",
      method: "default",
      secret,
      default: true,
      ...state,
      problem: null,
      effectiveUrl: config.baseUrl,
      authType: config.auth.type,
    };
    return {
      ...config,
      methods: [{ id: "default", ...method }],
      instances: [instance],
      simple: true,
      ...state,
      usedBy,
      problem: null,
    };
  }
  const methods = config.methods ?? [];
  const instances: ClientInstanceItem[] = (config.instances ?? []).map((instance, index) => {
    const type = methods.find((method) => method.id === instance.method)?.type ?? "none";
    return {
      ...instance,
      default: index === 0,
      ...instanceState(type, instance.secret, `${config.id}#${instance.id}`),
      problem: null,
      effectiveUrl: instance.url ?? config.baseUrl,
      authType: type,
    };
  });
  const order: ClientItem["status"][] = ["invalid", "toValidate", "missingSecret", "toConnect", "ready"];
  const status =
    instances.length === 0
      ? "noInstance"
      : (order.find((known) => instances.some((instance) => instance.status === known)) ?? "ready");
  const waiting = instances.filter((instance) => instance.validation?.validated === false);
  return {
    ...config,
    methods,
    instances,
    simple: false,
    status,
    hasSecret: false,
    connected: null,
    usedBy,
    problem: null,
    validation:
      waiting.length === 0
        ? null
        : {
            validated: false,
            everValidated: true,
            changes: waiting.flatMap((instance) =>
              (instance.validation?.changes ?? []).map((change) => ({
                ...change,
                instance: instance.id,
                instanceLabel: instance.label,
              })),
            ),
            fingerprint: null,
            fingerprints: Object.fromEntries(
              waiting.map((instance) => [instance.id, instance.validation?.fingerprint ?? {}]),
            ),
          },
  };
}

/** Clients enregistrés, tels que le fichier les décrit. */
let stored: Stored[];
/** Modèles de service décrits par les modules (`clients[].client`), par besoin. */
let templates: Record<string, Partial<ClientConfig>>;

beforeEach(() => {
  stored = [];
  templates = {};
  needs = [];
  vault = [];
  calls = [];
  pending = {};
  listeners.clear();
  useNotifications.getState().clear();
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "clients.list":
        return {
          clients: stored.map((client) => describe(client)),
          needs: needs.map((need) => ({ ...need })),
          redirectUri: REDIRECT,
        };
      case "marketplace.list":
      case "marketplace.updates":
      case "marketplace.modules":
        return [];
      case "vault.list":
        return vault.map((item) => ({ ...item }));
      case "vault.save": {
        const input = args as unknown as VaultEntry & { secrets: Record<string, string> };
        const saved = entry(
          input.id ?? input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          input.label,
          input.kind,
          {
            meta: input.meta,
          },
        );
        vault = [...vault.filter((item) => item.id !== saved.id), saved];
        return saved;
      }
      case "clients.save": {
        const config = (args as { client: ClientConfig }).client;
        const previous = stored.find((client) => client.id === config.id);
        // Comme le backend : la forme à plusieurs instances garde les instances du fichier.
        const next: Stored = config.methods ? { ...config, instances: previous?.instances ?? [] } : config;
        stored = [...stored.filter((client) => client.id !== config.id), next];
        return describe(next);
      }
      case "clients.saveInstance": {
        const { client, instance, create } = args as {
          client: string;
          instance: ClientInstanceConfig;
          create: boolean;
        };
        const owner = stored.find((known) => known.id === client) as Stored;
        // Le compte d’un service à une seule adresse : son entrée du coffre rejoint l’authentification.
        if (owner.auth) {
          owner.auth = { ...owner.auth, secret: instance.secret };
          delete pending[client];
          return describe(owner);
        }
        const instances = owner.instances ?? [];
        owner.instances = create
          ? [...instances, instance]
          : instances.map((known) => (known.id === instance.id ? instance : known));
        delete pending[`${client}#${instance.id}`];
        return describe(owner);
      }
      case "clients.setAccountPages": {
        const { client, instance, pages } = args as { client: string; instance: string; pages: string[] };
        return { accounts: { [`${client}/${instance}`]: pages } };
      }
      case "clients.deleteInstance": {
        const { client, instance } = args as { client: string; instance: string };
        const owner = stored.find((known) => known.id === client) as Stored;
        owner.instances = (owner.instances ?? []).filter((known) => known.id !== instance);
        return describe(owner);
      }
      case "clients.defaultInstance": {
        const { client, instance } = args as { client: string; instance: string };
        const owner = stored.find((known) => known.id === client) as Stored;
        const instances = owner.instances ?? [];
        owner.instances = [
          ...instances.filter((known) => known.id === instance),
          ...instances.filter((known) => known.id !== instance),
        ];
        return describe(owner);
      }
      case "clients.delete":
        stored = stored.filter((client) => client.id !== (args as { id: string }).id);
        return null;
      case "clients.test":
        return { ok: true, status: 200, durationMs: 42, message: "Le service répond (200)." };
      case "clients.bind": {
        const { need, client } = args as { need: string; client: string | null };
        needs = needs.map((item) => (item.key === need ? { ...item, binding: client, client } : item));
        return { bindings: {} };
      }
      case "clients.validate": {
        const { id } = args as { id: string };
        for (const key of Object.keys(pending)) if (key === id || key.startsWith(`${id}#`)) delete pending[key];
        return describe(stored.find((client) => client.id === id) as Stored);
      }
      case "clients.connect":
        return { authorizationUrl: AUTHORIZE };
      case "clients.disconnect":
        vault = vault.map((item) => (item.kind === "oauth2" ? { ...item, connected: false } : item));
        return null;
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

function summary(id: string, name: string): ModuleSummary {
  return {
    id,
    name,
    version: "0.1.0",
    description: "",
    readOnly: false,
    origin: null,
    hidden: false,
    requires: [],
    requiredBy: [],
    pages: 0,
    functions: 0,
    clients: [],
    webhooks: [],
    schedules: [],
  };
}

/** Onglet Modules d’un espace dont les modules sont ceux des demandes ; `sections` y ajoute des pages. */
function renderModules(
  sections: ResolvedSection[] = [],
  functions: ResolvedFunction[] = [],
  extra: Partial<Snapshot> = {},
) {
  const modules = [...new Map(needs.map((need) => [need.module, summary(need.module, need.moduleName)])).values()].map(
    (module) => ({
      ...module,
      clients: needs
        .filter((need) => need.module === module.id)
        .map((need) => ({ id: need.id, label: need.label, client: templates[need.id] })),
    }),
  );
  const snapshot: Snapshot = {
    path: "/espace",
    name: "Démo",
    accent: null,
    sections,
    settingsPages: [],
    modules,
    functions,
    bindings: {},
    problems: [],
    ...extra,
  };
  useShell.setState({ snapshot });
  return render(<ModulesSettings />);
}

/** Ouvre la fiche d’un module. */
async function openModule(user: ReturnType<typeof userEvent.setup>, name: string) {
  const table = await screen.findByRole("table", { name: /Modules de l.espace/ });
  await user.click(await within(table).findByText(name));
}

/** Ouvre le menu « … » d’une ligne (service ou compte) et rend l’entrée demandée. */
async function menuItem(user: ReturnType<typeof userEvent.setup>, subject: string, item: string) {
  await user.click(screen.getByRole("button", { name: `Actions de ${subject}` }));
  return screen.findByRole("menuitem", { name: item });
}

/** Fait utiliser le service `client` par un module « Outils », dont on ouvre ensuite la fiche. */
function usedByModule(client: string, label: string) {
  needs = [
    {
      key: `outils/${client}`,
      module: "outils",
      moduleName: "Outils",
      id: client,
      label,
      baseUrl: null,
      auth: null,
      binding: null,
      client,
    },
  ];
}

const lastCall = (command: string) => calls.filter((call) => call.command === command).at(-1)?.args;
const notifications = () => useNotifications.getState().items.map((item) => item.title);

it("sans modèle du module, renvoie à Alfred plutôt que de faire décrire le service à l’utilisateur", async () => {
  const user = userEvent.setup();
  needs = [
    {
      key: "crm/tickets",
      module: "crm",
      moduleName: "CRM",
      id: "tickets",
      label: "Tickets",
      baseUrl: null,
      auth: "apiKey",
      binding: null,
      client: null,
    },
  ];
  renderModules();
  expect(await screen.findByText("À configurer")).toBeInTheDocument();
  expect(screen.queryByText("Autres services")).not.toBeInTheDocument();
  await openModule(user, "CRM");
  expect(await screen.findByText(/Demandez à Alfred de le compléter/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Configurer|Ajouter votre compte/ })).not.toBeInTheDocument();
});

it("ajoute le compte d’un service décrit par le module : seulement la clé, rien sur le service", async () => {
  const user = userEvent.setup();
  templates = {
    tickets: {
      label: "Jira",
      baseUrl: "https://jira.exemple.com",
      auth: { type: "apiKey", header: "X-Api-Key" },
      testPath: "/myself",
    },
  };
  needs = [
    {
      key: "crm/tickets",
      module: "crm",
      moduleName: "CRM",
      id: "tickets",
      label: "Tickets",
      baseUrl: null,
      auth: "apiKey",
      binding: null,
      client: null,
    },
  ];
  renderModules();
  await openModule(user, "CRM");
  // Le service naît du modèle du module, puis le formulaire du compte s’ouvre.
  needs = needs.map((need) => ({ ...need, client: "tickets" }));
  await user.click(await screen.findByRole("button", { name: "Ajouter votre compte Tickets" }));
  expect(lastCall("clients.save")).toEqual({
    create: true,
    client: {
      id: "tickets",
      label: "Jira",
      baseUrl: "https://jira.exemple.com",
      auth: { type: "apiKey", header: "X-Api-Key" },
      testPath: "/myself",
    },
  });

  // Ni nom, ni adresse, ni type de connexion, ni en-tête : la clé seule.
  expect(await screen.findByRole("heading", { name: "Votre compte Jira" })).toBeInTheDocument();
  for (const label of [/Nom/, /Adresse/, /Connexion/, /Identifiant/]) {
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  }
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(screen.getByText("Saisissez la clé.")).toBeInTheDocument();
  expect(lastCall("vault.save")).toBeUndefined();

  // Options avancées : propres au compte, pour une subtilité que le module ne prévoit pas.
  await user.click(screen.getByText("Options avancées"));
  await user.type(screen.getByLabelText("En-têtes en plus (facultatif)"), "X-Tenant: acme");
  await user.click(screen.getByLabelText("Accepter un certificat non vérifié"));
  await user.type(screen.getByLabelText("Clé d’API"), "cle-secrete");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));

  // La clé va au coffre ; le compte n’en garde que le nom.
  await screen.findByRole("group", { name: "Comptes Jira" });
  expect(lastCall("vault.save")).toEqual({ label: "Jira", kind: "token", meta: {}, secrets: { value: "cle-secrete" } });
  expect(lastCall("clients.saveInstance")).toEqual({
    client: "tickets",
    create: false,
    instance: {
      id: "default",
      label: "",
      method: "default",
      secret: "jira",
      headers: { "X-Tenant": "acme" },
      insecureTls: true,
    },
  });
  expect(JSON.stringify(calls.filter((call) => call.command.startsWith("clients.")))).not.toContain("cle-secrete");

  // Tester, modifier le compte ; jamais modifier le service.
  await user.click(await menuItem(user, "Jira", "Tester"));
  await waitFor(() => expect(notifications()).toContain("Jira : le service répond"));
  expect(lastCall("clients.test")).toEqual({ id: "tickets" });
  await user.click(screen.getByRole("button", { name: "Actions de Jira" }));
  expect(await screen.findByRole("menuitem", { name: "Modifier le compte…" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /service/ })).not.toBeInTheDocument();
});

it("connecte un client OAuth 2 dans le navigateur et se met à jour au retour", async () => {
  const user = userEvent.setup();
  vault = [entry("sso", "SSO", "oauth2", { meta: { clientId: "alfred-app" }, hasSecret: false, connected: false })];
  stored = [
    {
      id: "portail",
      label: "Portail",
      baseUrl: "https://portail.exemple.com",
      auth: {
        type: "oauth2",
        secret: "sso",
        authorizationUrl: "https://sso.exemple.com/authorize",
        tokenUrl: "https://sso.exemple.com/token",
        scopes: ["lire"],
      },
    },
  ];
  usedByModule("portail", "Portail");
  renderModules();
  await openModule(user, "Outils");
  const table = await screen.findByRole("group", { name: "Comptes Portail" });
  expect(within(table).getByText("À connecter")).toBeInTheDocument();

  // Se connecter ouvre l’adresse d’autorisation dans le navigateur du système.
  await user.click(screen.getByRole("button", { name: "Se connecter à Portail" }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTHORIZE));
  expect(lastCall("clients.connect")).toEqual({ id: "portail" });
  expect(within(table).getByText("En attente du navigateur…")).toBeInTheDocument();

  // Retour du navigateur : le backend annonce la connexion, l’écran se relit.
  vault = [{ ...vault[0], connected: true }];
  listeners.get("clients:changed")?.({ client: "portail", connected: true });
  await waitFor(() => expect(within(table).queryByText("À connecter")).not.toBeInTheDocument());
  expect(within(table).queryByText("En attente du navigateur…")).not.toBeInTheDocument();
  expect(notifications()).toContain("Portail est connecté");
  expect(screen.queryByRole("button", { name: "Se connecter à Portail" })).not.toBeInTheDocument();

  // Un échec au retour est rapporté avec sa cause.
  await user.click(await menuItem(user, "Portail", "Se déconnecter"));
  expect(await within(table).findByText("À connecter")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Se connecter à Portail" }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
  listeners.get("clients:changed")?.({
    client: "portail",
    connected: false,
    error: "La connexion a été refusée ou annulée.",
  });
  await waitFor(() => expect(notifications()).toContain("La connexion de Portail a échoué"));

  // Le compte OAuth 2 ne montre que l’application et l’adresse de retour à déclarer chez le fournisseur.
  await user.click(await menuItem(user, "Portail", "Modifier le compte…"));
  expect(await screen.findByLabelText("Identifiant client")).toHaveValue("alfred-app");
  expect(screen.queryByLabelText("Adresse d’autorisation")).not.toBeInTheDocument();
  expect(screen.getByText(new RegExp(REDIRECT))).toBeInTheDocument();
});

it("montre un client modifié hors des Réglages et ne le valide qu’après relecture de ses valeurs", async () => {
  const user = userEvent.setup();
  vault = [entry("jeton-jira", "Jeton Jira", "token")];
  const fingerprint = { authType: "bearer", secret: "jeton-jira", baseUrl: "https://ailleurs.exemple.com" };
  pending = {
    jira: {
      validated: false,
      everValidated: true,
      changes: [
        {
          field: "baseUrl",
          label: "Adresse du service",
          before: "https://jira.exemple.com",
          after: "https://ailleurs.exemple.com",
        },
        { field: "authType", label: "Authentification", before: "apiKey", after: "bearer" },
      ],
      fingerprint,
    },
  };
  stored = [
    {
      id: "jira",
      label: "Jira",
      baseUrl: "https://ailleurs.exemple.com",
      auth: { type: "bearer", secret: "jeton-jira" },
    },
  ];
  usedByModule("jira", "Jira");
  renderModules();
  await openModule(user, "Outils");

  // À valider : l’état le dit, et le test est impossible tant que rien n’est approuvé.
  const table = await screen.findByRole("group", { name: "Comptes Jira" });
  expect(within(table).getByText("À approuver")).toBeInTheDocument();
  expect(within(table).getByText(/Modifié hors des Réglages/)).toBeInTheDocument();
  expect(await menuItem(user, "Jira", "Tester")).toBeDisabled();
  await user.keyboard("{Escape}");

  // Valider montre l’avant et l’après avant de confirmer ; annuler ne valide rien.
  await user.click(screen.getByRole("button", { name: "Approuver Jira" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("Approuver le service « Jira » ?")).toBeInTheDocument();
  expect(within(dialog).getByText("Avant : https://jira.exemple.com")).toBeInTheDocument();
  expect(within(dialog).getByText("Maintenant : https://ailleurs.exemple.com")).toBeInTheDocument();
  expect(within(dialog).getByText("Avant : Clé d’API")).toBeInTheDocument();
  expect(within(dialog).getByText("Maintenant : Jeton d’accès")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
  expect(lastCall("clients.validate")).toBeUndefined();

  // Confirmer renvoie au backend exactement les valeurs affichées.
  await user.click(screen.getByRole("button", { name: "Approuver Jira" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approuver" }));
  await waitFor(() => expect(within(table).queryByText("À approuver")).not.toBeInTheDocument());
  expect(lastCall("clients.validate")).toEqual({ id: "jira", fingerprint });
  expect(notifications()).toContain("Jira est approuvé");
  expect(screen.queryByRole("button", { name: "Approuver Jira" })).not.toBeInTheDocument();
  expect(await menuItem(user, "Jira", "Tester")).toBeEnabled();
});

it("ajoute plusieurs comptes à un service qui en accepte plusieurs, et les gère un à un", async () => {
  const user = userEvent.setup();
  // Le service, décrit par l’agent : deux façons de se connecter, sans adresse fixe.
  stored = [
    {
      id: "jira",
      label: "Jira",
      baseUrl: "",
      methods: [
        { id: "data-center-pat", label: "Data Center (PAT)", type: "bearer" },
        { id: "jira-cloud", label: "Jira Cloud", type: "basic" },
      ],
      instances: [],
    },
  ];
  needs = [
    {
      key: "suivi/jira",
      module: "suivi",
      moduleName: "Suivi",
      id: "jira",
      label: "Jira",
      baseUrl: null,
      auth: null,
      binding: null,
      client: "jira",
    },
  ];
  // La page du module par compte : chaque compte dit quelle page il alimente.
  renderModules([
    {
      id: "suivi/tickets@compte",
      module: "suivi",
      label: "Tickets — Acme",
      icon: null,
      color: null,
      hidden: false,
      pages: [],
      instance: "compte",
    },
  ]);
  await openModule(user, "Suivi");
  await user.click(await screen.findByRole("button", { name: "Ajouter un compte à Jira" }));

  // L’adresse du compte (le service n’en fixe pas), la façon de se connecter, le jeton. Pas de nom à inventer.
  expect(await screen.findByRole("heading", { name: "Ajouter un compte Jira" })).toBeInTheDocument();
  expect(screen.queryByLabelText(/Nom du compte|Identifiant du compte/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  expect(screen.getByText("Saisissez l’adresse de votre compte.")).toBeInTheDocument();
  expect(screen.getByText("Saisissez le jeton.")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Adresse de votre compte"), "https://jira.acme.fr");
  await user.type(screen.getByLabelText("Jeton d’accès"), "pat-123");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  await screen.findByRole("group", { name: "Comptes Jira" });
  expect(lastCall("clients.saveInstance")).toEqual({
    client: "jira",
    create: true,
    instance: {
      id: "compte",
      label: "jira.acme.fr",
      method: "data-center-pat",
      url: "https://jira.acme.fr",
      secret: "jira-jira-acme-fr",
    },
  });

  // La fiche montre les comptes du seul service du module, avec l’entrée du menu que chacun alimente.
  const accounts = await screen.findByRole("group", { name: "Comptes Jira" });
  expect(screen.getByRole("heading", { name: "Services" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Jira" })).toBeInTheDocument();
  expect(within(accounts).getByText("Entrée « Tickets — Acme » dans le menu")).toBeInTheDocument();

  // Un deuxième compte, par l’autre façon de se connecter : identifiant et mot de passe.
  await user.click(screen.getByRole("button", { name: "Ajouter un compte à Jira" }));
  await user.type(await screen.findByLabelText("Adresse de votre compte"), "https://acme.atlassian.net");
  await user.selectOptions(screen.getByLabelText("Connexion"), "jira-cloud");
  await user.type(screen.getByLabelText("Identifiant"), "cloud");
  await user.type(screen.getByLabelText("Mot de passe"), "p4ss");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  expect(
    await within(await screen.findByRole("group", { name: "Comptes Jira" })).findByText("cloud"),
  ).toBeInTheDocument();
  expect(lastCall("vault.save")).toEqual({
    label: "Jira — cloud",
    kind: "basic",
    meta: { username: "cloud" },
    secrets: { password: "p4ss" },
  });

  // Chaque compte se teste et peut devenir celui par défaut.
  await user.click(await menuItem(user, "Jira — cloud", "Tester"));
  await waitFor(() => expect(notifications()).toContain("Jira — cloud : le service répond"));
  expect(lastCall("clients.test")).toEqual({ id: "jira", instance: "compte-2" });
  await user.click(await menuItem(user, "Jira — cloud", "Utiliser par défaut"));
  expect(lastCall("clients.defaultInstance")).toEqual({ client: "jira", instance: "compte-2" });

  // Un compte modifié hors des Réglages : l’approbation montre le compte concerné.
  pending["jira#compte-2"] = {
    validated: false,
    everValidated: true,
    changes: [
      {
        field: "baseUrl",
        label: "Adresse du service",
        before: "https://acme.atlassian.net",
        after: "https://ailleurs.fr",
      },
    ],
    fingerprint: { baseUrl: "https://ailleurs.fr" },
  };
  listeners.get("clients:changed")?.({ client: "jira" });
  await user.click(await screen.findByRole("button", { name: "Approuver Jira — cloud" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("cloud · Adresse du service")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Approuver" }));
  await waitFor(() => expect(notifications()).toContain("Jira est approuvé"));
  expect(lastCall("clients.validate")).toEqual({
    id: "jira",
    fingerprints: { "compte-2": { baseUrl: "https://ailleurs.fr" } },
  });

  // Supprimer un compte est confirmé et ne touche pas aux autres.
  await user.click(await menuItem(user, "Jira — jira.acme.fr", "Supprimer le compte…"));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(lastCall("clients.deleteInstance")).toEqual({ client: "jira", instance: "compte" }));
  expect(screen.getByRole("group", { name: "Comptes Jira" })).toBeInTheDocument();
});

it("fait ajouter et retirer, compte par compte, les pages du module qui sont pour ses comptes", async () => {
  const user = userEvent.setup();
  stored = [
    {
      id: "jira",
      label: "Jira",
      baseUrl: "",
      methods: [{ id: "pat", label: "PAT", type: "bearer" }],
      instances: [],
    },
  ];
  needs = [
    {
      key: "suivi/jira",
      module: "suivi",
      moduleName: "Suivi",
      id: "jira",
      label: "Jira",
      baseUrl: null,
      auth: null,
      binding: null,
      client: "jira",
    },
  ];
  // Deux pages sont pour chaque compte Jira : Tickets (X) et Sprints (Y).
  const accountPages = [
    { reference: "suivi/tickets", module: "suivi", title: "Tickets", section: "Suivi", need: "jira", client: "jira" },
    { reference: "suivi/sprints", module: "suivi", title: "Sprints", section: "Suivi", need: "jira", client: "jira" },
  ];
  renderModules([], [], { accountPages, accounts: {} });
  await openModule(user, "Suivi");

  /** Ajoute un compte : sa fiche reste ouverte, sans page, et invite à en ajouter. */
  const addAccount = async (url: string) => {
    await user.click(await screen.findByRole("button", { name: "Ajouter un compte à Jira" }));
    expect(screen.queryByRole("heading", { name: "Pages de ce compte" })).not.toBeInTheDocument();
    await user.type(await screen.findByLabelText("Adresse de votre compte"), url);
    await user.type(screen.getByLabelText("Jeton d’accès"), "pat-123");
    await user.click(screen.getByRole("button", { name: "Ajouter" }));
    expect(await screen.findByRole("heading", { name: "Pages de ce compte" })).toBeInTheDocument();
    expect(
      screen.getByText("Votre compte est ajouté. Choisissez les pages à montrer pour lui dans le menu."),
    ).toBeInTheDocument();
    expect(screen.getByText("Aucune page pour ce compte pour l’instant.")).toBeInTheDocument();
  };
  const addPage = async (title: string) => {
    await user.click(screen.getByRole("button", { name: "Ajouter une page" }));
    await user.click(await screen.findByRole("menuitem", { name: title }));
    await screen.findByRole("button", { name: `Retirer la page ${title}` });
  };

  // Le compte « Jira » reçoit X et Y : rien d’office, puis une page après l’autre.
  await addAccount("https://jira.acme.fr");
  expect(lastCall("clients.saveInstance")).not.toHaveProperty("pages");
  await addPage("Tickets");
  expect(lastCall("clients.setAccountPages")).toEqual({ client: "jira", instance: "compte", pages: ["suivi/tickets"] });
  await addPage("Sprints");
  expect(lastCall("clients.setAccountPages")).toEqual({
    client: "jira",
    instance: "compte",
    pages: ["suivi/tickets", "suivi/sprints"],
  });
  // Toutes les pages sont là : plus rien à ajouter.
  expect(screen.queryByRole("button", { name: "Ajouter une page" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Terminer" }));

  // Le compte « Jira Desk » ne reçoit que X ; le premier compte n’est pas touché.
  await addAccount("https://desk.acme.fr");
  await addPage("Tickets");
  expect(lastCall("clients.setAccountPages")).toEqual({
    client: "jira",
    instance: "compte-2",
    pages: ["suivi/tickets"],
  });
  const chosen = calls.filter((call) => call.command === "clients.setAccountPages");
  expect(chosen.filter((call) => call.args.instance === "compte")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Terminer" }));

  // La fiche d’un compte existant liste ses pages, et chacune se retire.
  useShell.setState((state) => ({
    snapshot: state.snapshot && { ...state.snapshot, accounts: { "jira/compte": ["suivi/tickets", "suivi/sprints"] } },
  }));
  await user.click(await menuItem(user, "Jira — jira.acme.fr", "Modifier le compte…"));
  const pages = await screen.findByRole("group", { name: "Pages de Jira — jira.acme.fr" });
  expect(within(pages).getByText("Tickets")).toBeInTheDocument();
  expect(within(pages).getByText("Sprints")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retirer la page Sprints" }));
  await waitFor(() =>
    expect(lastCall("clients.setAccountPages")).toEqual({
      client: "jira",
      instance: "compte",
      pages: ["suivi/tickets"],
    }),
  );
  expect(await screen.findByRole("button", { name: "Ajouter une page" })).toBeInTheDocument();
});

it("nomme chaque service au-dessus de ses comptes quand le module en a plusieurs", async () => {
  const user = userEvent.setup();
  vault = [entry("jeton-jira", "Jeton Jira", "token"), entry("jeton-bb", "Jeton Bitbucket", "token")];
  stored = [
    { id: "jira", label: "Jira", baseUrl: "https://jira.exemple.com", auth: { type: "bearer", secret: "jeton-jira" } },
    {
      id: "bitbucket",
      label: "Bitbucket",
      baseUrl: "https://bb.exemple.com",
      auth: { type: "bearer", secret: "jeton-bb" },
    },
  ];
  const need = (id: string, label: string): ClientNeedItem => ({
    key: `dev/${id}`,
    module: "dev",
    moduleName: "Dev",
    id,
    label,
    baseUrl: null,
    auth: null,
    binding: null,
    client: id,
  });
  needs = [need("jira", "Jira"), need("bitbucket", "Bitbucket")];
  renderModules();
  await openModule(user, "Dev");
  expect(await screen.findByRole("heading", { name: "Jira" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Bitbucket" })).toBeInTheDocument();
  // Sous chaque nom, le compte de ce service.
  expect(
    within(screen.getByRole("group", { name: "Comptes Bitbucket" })).getByText("Votre compte"),
  ).toBeInTheDocument();
});

it("range la fiche par la hiérarchie : menu, puis chaque service avec ses comptes et ses fonctions, puis le reste", async () => {
  const user = userEvent.setup();
  vault = [entry("jeton-jira", "Jeton Jira", "token"), entry("jeton-bb", "Jeton Bitbucket", "token")];
  stored = [
    { id: "jira", label: "Jira", baseUrl: "https://jira.exemple.com", auth: { type: "bearer", secret: "jeton-jira" } },
    {
      id: "bitbucket",
      label: "Bitbucket",
      baseUrl: "https://bb.exemple.com",
      auth: { type: "bearer", secret: "jeton-bb" },
    },
  ];
  const need = (id: string, label: string): ClientNeedItem => ({
    key: `dev/${id}`,
    module: "dev",
    moduleName: "Dev",
    id,
    label,
    baseUrl: null,
    auth: null,
    binding: null,
    client: id,
  });
  needs = [need("jira", "Jira"), need("bitbucket", "Bitbucket")];
  const page = (id: string, title: string, clients: string[], panel: ResolvedPage | null = null): ResolvedPage => ({
    reference: `dev/${id}`,
    module: "dev",
    id,
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: false,
    errors: [],
    uses: { clients },
    panel,
  });
  const fn = (
    id: string,
    description: string,
    clients?: string[],
    effect: "read" | "write" = "read",
  ): ResolvedFunction => ({
    reference: `dev/${id}`,
    module: "dev",
    id,
    description,
    input: null,
    output: null,
    tool: true,
    missing: false,
    errors: [],
    uses: clients ? { clients } : {},
    runtime: "ts",
    effect,
  });
  renderModules(
    [
      {
        id: "dev/principal",
        module: "dev",
        label: "Développement",
        icon: "code",
        color: "violet",
        hidden: false,
        pages: [
          page("tickets", "Tickets", ["jira"], page("ticket", "Ticket", ["jira"])),
          page("revues", "Revues", ["bitbucket"]),
        ],
      },
    ],
    [
      fn("lister-tickets", "Tickets ouverts du projet.", ["jira"]),
      fn("commenter", "Commente un ticket.", ["jira"], "write"),
      fn("lister-revues", "Revues en attente.", ["bitbucket"]),
      fn("resumer", "Résume un texte."),
    ],
  );
  await openModule(user, "Dev");

  // Chaque groupe est un titre de section, avec sa phrase d’explication, au-dessus de ses éléments.
  for (const [title, explanation] of [
    ["Dans le menu", /Les entrées que ce module ajoute au menu de gauche/],
    ["Services", /Les services en ligne auxquels ce module se connecte/],
    ["Autres fonctions", /ne passent par aucun service/],
  ] as const) {
    const heading = screen.getByRole("heading", { name: title, level: 2 });
    expect(within(heading.closest("section") as HTMLElement).getByText(explanation)).toBeInTheDocument();
  }

  // Dans le menu : l’entrée avec son icône dans sa couleur, comme dans le menu de gauche, ses onglets en retrait,
  // et le panneau de l’onglet qui en a un.
  const menu = screen.getByRole("group", { name: "Pages du module" });
  const menuEntry = within(menu).getByText("Développement");
  expect(menuEntry).toHaveClass("module-entry", "product-color--violet");
  expect(menuEntry.querySelector(".module-entry__icon svg")).not.toBeNull();
  expect(within(menu).getByText("Tickets").closest(".setting-row--nested")).not.toBeNull();
  expect(within(menu).getByText("Développement")).toBeInTheDocument();
  expect(within(menu).getByText("2 onglets")).toBeInTheDocument();
  expect(within(menu).getByText("Avec le panneau « Ticket » à droite.")).toBeInTheDocument();

  // Un bloc par service : à quoi il sert, ses comptes, puis ce que le module fait avec lui.
  const jira = (await screen.findByRole("heading", { name: "Jira" })).closest(".service-block") as HTMLElement;
  expect(within(jira).getByText("Sert aux pages « Tickets » et « Ticket ».")).toBeInTheDocument();
  expect(within(jira).getByRole("group", { name: "Comptes Jira" })).toBeInTheDocument();
  expect(within(jira).getByText("Ce que le module fait avec Jira")).toBeInTheDocument();
  expect(within(jira).getByText("lister-tickets")).toBeInTheDocument();
  expect(within(jira).getByText("commenter")).toBeInTheDocument();
  expect(within(jira).queryByText("lister-revues")).not.toBeInTheDocument();
  const bitbucket = screen.getByRole("heading", { name: "Bitbucket" }).closest(".service-block") as HTMLElement;
  expect(within(bitbucket).getByText("Sert à la page « Revues ».")).toBeInTheDocument();
  expect(within(bitbucket).getByText("lister-revues")).toBeInTheDocument();

  // La fonction qui ne passe par aucun service est rangée à part, repliée.
  const others = document.querySelector('[data-part="other-functions"]') as HTMLElement;
  expect(within(others).getByRole("heading", { name: "Autres fonctions" })).toBeInTheDocument();
  expect(others.querySelector("details")).not.toHaveAttribute("open");
  expect(within(others).getByText("resumer")).toBeInTheDocument();

  // Les actions restent là, rangées sous leur service : tester un compte, agir sur une fonction.
  expect(await menuItem(user, "Jira", "Tester")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(await menuItem(user, "la fonction commenter", "Essayer…")).toBeInTheDocument();
});
