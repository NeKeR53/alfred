import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent, openExternal } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction, ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { useModulesSections } from "../modules/ModulesSettings";
import { renderSections } from "../modules/settingsHarness";
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
    // L’espace affiché, joint à chaque écriture du menu, se vérifie dans src/shell/spaceSwitch.test.tsx.
    const { space: _shown, ...rest } = args;
    calls.push({ command, args: command.startsWith("space.menu.") ? rest : args });
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
      case "space.menu.addPage":
      case "space.menu.addTab":
      case "space.menu.configure":
      case "space.menu.remove":
      case "space.menu.move":
        return { ...useShell.getState().snapshot, created: "prefect/principal@prefect-recette" };
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
  return renderSections(useModulesSections, "Modules");
}

/** Ouvre la fiche d’un module. */
async function openModule(user: ReturnType<typeof userEvent.setup>, name: string) {
  const list = await screen.findByRole("region", { name: "Modules installés" });
  await user.click(await within(list).findByRole("button", { name: `Ouvrir la fiche de ${name}` }));
}

/** Section d’un service dans la fiche : son nom en titre, une ligne par compte. */
const _serviceOf = (name: string) => screen.findByRole("region", { name });

/** Actions d’une ligne de compte : « Jira » (service à un seul compte) ou « Jira — Prod ». */
function rowActions(subject: string) {
  const [service, account] = subject.split(" — ");
  const region = screen.getAllByRole("region", { name: service }).at(-1) as HTMLElement;
  return account
    ? within(region).getByRole("group", { name: `Actions sur ${account}` })
    : (within(region).getAllByRole("group", { name: /^Actions sur / })[0] as HTMLElement);
}

/** Ouvre le menu « … » d’une ligne (service ou compte) et rend l’entrée demandée. */
async function menuItem(user: ReturnType<typeof userEvent.setup>, subject: string, item: string) {
  if (subject.startsWith("l’onglet ") || subject.startsWith("la page ")) {
    // Pages et onglets de la fiche : un menu « … » par ligne.
    await user.click(screen.getByRole("button", { name: `Actions de ${subject}` }));
  } else if (subject.startsWith("la fonction ")) {
    const actions = screen.getByRole("group", { name: `Actions sur ${subject.slice("la fonction ".length)}` });
    await user.click(within(actions).getByRole("button", { name: "Plus d'actions" }));
  } else {
    await user.click(within(rowActions(subject)).getByRole("button", { name: "Plus d'actions" }));
  }
  return screen.findByRole("menuitem", { name: item });
}

/** Choix d’un compte (`Select` de Socle) : le bouton, nommé par son libellé, qui montre la valeur choisie. */
const picker = (scope: HTMLElement, name: string) => within(scope).getByRole("button", { name: new RegExp(name) });

async function choose(user: ReturnType<typeof userEvent.setup>, button: HTMLElement, option: string | RegExp) {
  await user.click(button);
  await user.click(await screen.findByRole("option", { name: option }));
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
  await user.type(screen.getByLabelText(/^En-têtes en plus/), "X-Tenant: acme");
  await user.click(screen.getByLabelText("Accepter un certificat non vérifié"));
  await user.type(screen.getByLabelText("Clé d’API"), "cle-secrete");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));

  // La clé va au coffre ; le compte n’en garde que le nom.
  await screen.findByRole("region", { name: "Jira" });
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
  // Un compte prêt se teste d’un bouton visible, pas d’une entrée de menu.
  await user.click(screen.getByRole("button", { name: "Tester Jira" }));
  await waitFor(() => expect(notifications()).toContain("Jira : le service répond"));
  expect(lastCall("clients.test")).toEqual({ id: "tickets" });
  await user.click(within(rowActions("Jira")).getByRole("button", { name: "Plus d'actions" }));
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
  const table = await screen.findByRole("region", { name: "Portail" });
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
  const table = await screen.findByRole("region", { name: "Jira" });
  expect(within(table).getByText("À approuver")).toBeInTheDocument();
  expect(within(table).getByText(/Modifié hors des Réglages/)).toBeInTheDocument();
  // Une seule action reste sur la ligne (approuver) ; le test, dans « … », est désactivé.
  expect(await menuItem(user, "Jira", "Tester Jira")).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");

  // Valider montre l’avant et l’après avant de confirmer ; annuler ne valide rien.
  await user.click(screen.getByRole("button", { name: "Approuver Jira" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Approuver le service « Jira » ?")).toBeInTheDocument();
  expect(within(dialog).getByText("Avant : https://jira.exemple.com")).toBeInTheDocument();
  expect(within(dialog).getByText("Maintenant : https://ailleurs.exemple.com")).toBeInTheDocument();
  expect(within(dialog).getByText("Avant : Clé d’API")).toBeInTheDocument();
  expect(within(dialog).getByText("Maintenant : Jeton d’accès")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
  expect(lastCall("clients.validate")).toBeUndefined();

  // Confirmer renvoie au backend exactement les valeurs affichées.
  await user.click(screen.getByRole("button", { name: "Approuver Jira" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approuver" }));
  await waitFor(() => expect(within(table).queryByText("À approuver")).not.toBeInTheDocument());
  expect(lastCall("clients.validate")).toEqual({ id: "jira", fingerprint });
  expect(notifications()).toContain("Jira est approuvé");
  expect(screen.queryByRole("button", { name: "Approuver Jira" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Tester Jira" })).toBeEnabled();
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
  renderModules(
    [
      {
        id: "suivi/tickets@compte",
        module: "suivi",
        label: "Tickets — Acme",
        icon: null,
        color: null,
        hidden: false,
        pages: [
          {
            reference: "suivi/liste@compte",
            module: "suivi",
            id: "liste",
            title: "Liste",
            icon: null,
            description: "",
            hidden: false,
            readOnly: false,
            missing: false,
            errors: [],
            uses: { clients: ["jira"] },
            panel: null,
            instance: "compte",
            perInstance: "jira",
          },
        ],
        perInstance: "jira",
        instance: "compte",
        instanceOf: "suivi/tickets",
      },
    ],
    [],
    { accountUsage: { "jira/compte": ["suivi/liste@compte"] } },
  );
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
  await screen.findByRole("region", { name: "Jira" });
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
  const accounts = await screen.findByRole("region", { name: "Jira" });
  expect(screen.getByRole("heading", { name: "Pages" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Comptes" })).toBeInTheDocument();
  expect(within(accounts).getByText("Utilisé par « Tickets — Acme ».")).toBeInTheDocument();

  // Un deuxième compte, par l’autre façon de se connecter : identifiant et mot de passe.
  await user.click(screen.getByRole("button", { name: "Ajouter un compte à Jira" }));
  await user.type(await screen.findByLabelText("Adresse de votre compte"), "https://acme.atlassian.net");
  await choose(user, screen.getByRole("button", { name: /Connexion/ }), /Jira Cloud/);
  await user.type(screen.getByLabelText("Identifiant"), "cloud");
  await user.type(screen.getByLabelText("Mot de passe"), "p4ss");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  expect(await within(await screen.findByRole("region", { name: "Jira" })).findByText("cloud")).toBeInTheDocument();
  expect(lastCall("vault.save")).toEqual({
    label: "Jira — cloud",
    kind: "basic",
    meta: { username: "cloud" },
    secrets: { password: "p4ss" },
  });

  // Chaque compte se teste et peut devenir celui par défaut.
  await user.click(screen.getByRole("button", { name: "Tester Jira — cloud" }));
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
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("cloud · Adresse du service")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Approuver" }));
  await waitFor(() => expect(notifications()).toContain("Jira est approuvé"));
  expect(lastCall("clients.validate")).toEqual({
    id: "jira",
    fingerprints: { "compte-2": { baseUrl: "https://ailleurs.fr" } },
  });

  // Supprimer un compte est confirmé et ne touche pas aux autres.
  await user.click(await menuItem(user, "Jira — jira.acme.fr", "Supprimer le compte…"));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(lastCall("clients.deleteInstance")).toEqual({ client: "jira", instance: "compte" }));
  expect(screen.getByRole("region", { name: "Jira" })).toBeInTheDocument();
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
  expect(within(screen.getByRole("region", { name: "Bitbucket" })).getByText("Votre compte")).toBeInTheDocument();
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
    ["Pages", /Vos pages faites à partir de ce module/],
    ["Comptes", /partagés par les pages qui s’en servent/],
    ["Fonctions", /rangé par service/],
  ] as const) {
    const heading = screen.getByRole("heading", { name: title, level: 3 });
    expect(within(heading.closest("section") as HTMLElement).getByText(explanation)).toBeInTheDocument();
  }

  // La page d’abord : l’entrée avec son icône dans sa couleur, comme dans le menu de gauche, ses onglets en retrait,
  // et le panneau de l’onglet qui en a un.
  const menu = screen.getByRole("region", { name: "Page Développement" });
  const menuEntry = within(menu).getByText("Développement");
  expect(menuEntry.parentElement?.querySelector("svg")).not.toBeNull();
  expect(within(menu).getByText("Tickets")).toBeInTheDocument();
  expect(within(menu).getByText("2 onglets.")).toBeInTheDocument();
  expect(within(menu).getByText("Avec le panneau « Ticket » à droite.")).toBeInTheDocument();
  // Puis les comptes, un bloc par service, partagés par les pages.
  expect(await screen.findByRole("region", { name: "Jira" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Bitbucket" })).toBeInTheDocument();
  // Les fonctions sont rangées par service, à part des pages.
  const jira = screen.getByRole("region", { name: "Ce que le module fait avec Jira (2)" });
  expect(within(jira).getByText("lister-tickets")).toBeInTheDocument();
  expect(within(jira).getByText("commenter")).toBeInTheDocument();
  expect(within(jira).queryByText("lister-revues")).not.toBeInTheDocument();
  const bitbucket = screen.getByRole("region", { name: "Ce que le module fait avec Bitbucket (1)" });
  expect(within(bitbucket).getByText("lister-revues")).toBeInTheDocument();
  // La fonction qui ne passe par aucun service est rangée à part.
  const others = screen.getByRole("region", { name: "Sans service (1)" });
  expect(within(others).getByText("resumer")).toBeInTheDocument();
  // Les actions restent là : tester un compte d’un bouton visible, agir sur une fonction.
  expect(screen.getByRole("button", { name: "Tester Jira" })).toBeVisible();
  expect(await menuItem(user, "la fonction commenter", "Essayer…")).toBeInTheDocument();
});

/** Un module Prefect : un modèle « Déploiements » qui montre un compte, et deux comptes. */
function prefectSpace(extra: Partial<Snapshot> = {}) {
  stored = [
    {
      id: "prefect",
      label: "Prefect",
      baseUrl: "",
      methods: [{ id: "web", label: "Web", type: "none" }],
      instances: [
        { id: "prod", label: "Prod", url: "https://prefect.acme.fr", method: "web" },
        { id: "recette", label: "Recette", url: "https://recette.acme.fr", method: "web" },
      ],
    },
  ];
  needs = [
    {
      key: "prefect/prefect",
      module: "prefect",
      moduleName: "Prefect",
      id: "prefect",
      label: "Prefect",
      baseUrl: null,
      auth: null,
      binding: null,
      client: "prefect",
    },
  ];
  const tab = (reference: string, title: string, instance: string): ResolvedPage => ({
    reference,
    module: "prefect",
    id: "deploiements",
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: false,
    errors: [],
    uses: { clients: ["prefect"] },
    panel: null,
    instance,
    perInstance: "prefect",
    template: "prefect/deploiements",
    accounts: { prefect: instance },
  });
  return renderModules(
    [
      {
        id: "prefect/principal",
        module: "prefect",
        label: "Prefect",
        icon: null,
        color: null,
        hidden: false,
        pages: [
          tab("prefect/deploiements", "Déploiements", "prod"),
          tab("prefect/deploiements@recette", "Recette", "recette"),
        ],
      },
    ],
    [],
    {
      templates: [
        {
          reference: "prefect/deploiements",
          module: "prefect",
          title: "Déploiements",
          icon: null,
          description: "",
          section: "prefect/principal",
          needs: ["prefect"],
          perInstance: "prefect",
        },
      ],
      sectionTemplates: [
        {
          id: "prefect/principal",
          module: "prefect",
          label: "Prefect",
          icon: null,
          iconUrl: null,
          color: null,
          pages: ["prefect/deploiements"],
        },
      ],
      accountUsage: { "prefect/prod": ["prefect/deploiements"], "prefect/recette": ["prefect/deploiements@recette"] },
      ...extra,
    },
  );
}

it("montre chaque page du module avec ses onglets et le compte de chacun, et les comptes avec les pages qui s’en servent", async () => {
  const user = userEvent.setup();
  prefectSpace();
  await openModule(user, "Prefect");
  const page = await screen.findByRole("region", { name: "Page Prefect" });
  expect(within(page).getByText("2 onglets.")).toBeInTheDocument();
  expect(picker(page, "Compte Prefect de Déploiements")).toHaveTextContent(/^Prod/);
  expect(picker(page, "Compte Prefect de Recette")).toHaveTextContent(/^Recette/);
  const accounts = (await screen.findAllByRole("region", { name: "Prefect" })).at(-1) as HTMLElement;
  expect(within(accounts).getByText("Utilisé par « Prefect › Déploiements ».")).toBeInTheDocument();
  expect(within(accounts).getByText("Utilisé par « Prefect › Recette ».")).toBeInTheDocument();

  // Changer le compte d’un onglet.
  await choose(user, picker(page, "Compte Prefect de Recette"), /^Prod ·/);
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({
      target: "prefect/deploiements@recette",
      accounts: { prefect: "prod" },
    }),
  );

  // Renommer, ranger et retirer un onglet ; retirer la page.
  await user.click(await menuItem(user, "l’onglet Recette", "Renommer…"));
  const rename = await screen.findByRole("dialog", { name: "Renommer l’onglet « Recette »" });
  const field = within(rename).getByLabelText("Nom");
  await user.clear(field);
  await user.type(field, "Rec");
  await user.click(within(rename).getByRole("button", { name: "Renommer" }));
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({ target: "prefect/deploiements@recette", label: "Rec" }),
  );
  await user.click(await menuItem(user, "l’onglet Recette", "Monter"));
  await waitFor(() =>
    expect(lastCall("space.menu.move")).toEqual({ target: "prefect/deploiements@recette", delta: -1 }),
  );
  await user.click(await menuItem(user, "l’onglet Recette", "Retirer l’onglet"));
  await waitFor(() => expect(lastCall("space.menu.remove")).toEqual({ target: "prefect/deploiements@recette" }));
  await user.click(await menuItem(user, "la page Prefect", "Retirer du menu"));
  await waitFor(() => expect(lastCall("space.menu.remove")).toEqual({ target: "prefect/principal" }));
  expect(calls.some((call) => call.command === "clients.deleteInstance")).toBe(false);
});

it("ajoute une deuxième page Prefect pour un autre compte, puis un onglet à une page", async () => {
  const user = userEvent.setup();
  prefectSpace();
  await openModule(user, "Prefect");
  await user.click(await screen.findByRole("button", { name: "Ajouter une page" }));
  const dialog = await screen.findByRole("dialog", { name: "Ajouter une page Prefect" });
  expect(within(dialog).getByRole("radio", { name: "Prefect" })).toBeChecked();
  await choose(user, picker(dialog, "Compte Prefect"), /^Recette ·/);
  // Une page Prefect existe déjà : le nom proposé dit le compte.
  expect(within(dialog).getByLabelText(/^Nom/)).toHaveValue("Prefect Recette");
  await user.click(within(dialog).getByRole("radio", { name: "flask-conical" }));
  await user.click(within(dialog).getByRole("button", { name: "Ajouter la page" }));
  await waitFor(() =>
    expect(lastCall("space.menu.addPage")).toEqual({
      section: "prefect/principal",
      label: "Prefect Recette",
      icon: "flask-conical",
      tabs: [{ page: "prefect/deploiements", accounts: { prefect: "recette" } }],
    }),
  );
  expect(notifications()).toContain("Page « Prefect Recette » ajoutée au menu");

  await user.click(await menuItem(user, "la page Prefect", "Ajouter un onglet…"));
  const tab = await screen.findByRole("dialog", { name: "Ajouter un onglet à « Prefect »" });
  expect(within(tab).getByRole("radio", { name: "Déploiements" })).toBeChecked();
  await choose(user, picker(tab, "Compte Prefect"), /^Prod ·/);
  await user.click(within(tab).getByRole("button", { name: "Ajouter l’onglet" }));
  await waitFor(() =>
    expect(lastCall("space.menu.addTab")).toEqual({
      page: "prefect/principal",
      tab: { page: "prefect/deploiements", label: "Déploiements Prod", accounts: { prefect: "prod" } },
    }),
  );
});

it("crée un compte sur place depuis un onglet, qui en devient le compte", async () => {
  const user = userEvent.setup();
  prefectSpace();
  await openModule(user, "Prefect");
  const page = await screen.findByRole("region", { name: "Page Prefect" });
  await choose(user, picker(page, "Compte Prefect de Recette"), "Ajouter un compte…");
  await user.type(await screen.findByLabelText("Adresse de votre compte"), "https://dev.acme.fr");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({
      target: "prefect/deploiements@recette",
      accounts: { prefect: "compte" },
    }),
  );
});

it("ne devine aucun compte : « Ajouter la page » attend qu’on en choisisse un", async () => {
  const user = userEvent.setup();
  prefectSpace();
  await openModule(user, "Prefect");
  await user.click(await screen.findByRole("button", { name: "Ajouter une page" }));
  const dialog = await screen.findByRole("dialog", { name: "Ajouter une page Prefect" });
  const account = picker(dialog, "Compte Prefect");
  expect(account).toHaveTextContent("Choisir un compte…");
  expect(within(dialog).getByRole("button", { name: "Ajouter la page" })).toBeDisabled();
  // Chaque compte dit son service et son état ; « Ajouter un compte… » reste en bas.
  await user.click(account);
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(options).toEqual(["Prod · Prefect · connecté", "Recette · Prefect · connecté", "Ajouter un compte…"]);
  await user.click(screen.getByRole("option", { name: "Prod · Prefect · connecté" }));
  expect(within(dialog).getByRole("button", { name: "Ajouter la page" })).toBeEnabled();
});

it("propose le compte d’un autre module du même type, et l’enregistre avec son service", async () => {
  const user = userEvent.setup();
  prefectSpace({ compatibleClients: { "prefect/prefect": ["prefect", "prefect-equipe"] } });
  // Un compte créé pour un autre module, sur un service du même type.
  stored.push({
    id: "prefect-equipe",
    label: "Prefect (équipe)",
    baseUrl: "",
    methods: [{ id: "web", label: "Web", type: "none" }],
    instances: [{ id: "partage", label: "Partagé", url: "https://prefect.equipe.fr", method: "web" }],
  });
  listeners.get("clients:changed")?.({ client: "prefect-equipe" });
  await openModule(user, "Prefect");
  const page = await screen.findByRole("region", { name: "Page Prefect" });
  await user.click(picker(page, "Compte Prefect de Recette"));
  await user.click(await screen.findByRole("option", { name: "Partagé · Prefect (équipe) · connecté" }));
  await waitFor(() =>
    expect(lastCall("space.menu.configure")).toEqual({
      target: "prefect/deploiements@recette",
      accounts: { prefect: "prefect-equipe/partage" },
    }),
  );
});
