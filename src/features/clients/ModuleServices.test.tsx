import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent, openExternal } from "../../lib/native";
import type { ModuleSummary, ResolvedSection, Snapshot } from "../../lib/types";
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

beforeEach(() => {
  stored = [];
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
        const saved = entry(input.id, input.label, input.kind, { meta: input.meta });
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
        const instances = owner.instances ?? [];
        owner.instances = create
          ? [...instances, instance]
          : instances.map((known) => (known.id === instance.id ? instance : known));
        delete pending[`${client}#${instance.id}`];
        return describe(owner);
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
function renderModules(sections: ResolvedSection[] = []) {
  const modules = [...new Map(needs.map((need) => [need.module, summary(need.module, need.moduleName)])).values()];
  const snapshot: Snapshot = {
    path: "/espace",
    name: "Démo",
    accent: null,
    sections,
    settingsPages: [],
    modules,
    functions: [],
    bindings: {},
    problems: [],
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
const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);

it("configure le service demandé par un module depuis sa fiche, le teste, change le service utilisé", async () => {
  const user = userEvent.setup();
  vault = [entry("jeton-jira", "Jeton Jira", "token"), entry("sso", "SSO", "oauth2", { connected: false })];
  // Un service déjà configuré, qu’aucun module n’utilise : il pourra remplacer celui du module.
  stored = [{ id: "secours", label: "Secours", baseUrl: "https://secours.exemple.com", auth: { type: "none" } }];
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

  // Le module signale qu’il attend un service ; sa fiche propose de le configurer.
  expect(await screen.findByText("À configurer")).toBeInTheDocument();
  // Un service qu’aucun module n’utilise n’a pas de place dans la liste des modules.
  expect(screen.queryByText("Autres services")).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Comptes Secours" })).not.toBeInTheDocument();
  await openModule(user, "CRM");
  await user.click(await screen.findByRole("button", { name: "Configurer Tickets" }));

  // Le formulaire reprend la demande : nom et identifiant, type de connexion.
  expect(screen.getByLabelText("Nom")).toHaveValue("Tickets");
  expect(screen.getByLabelText("Identifiant")).toHaveValue("tickets");
  expect(screen.getByLabelText("Type de connexion")).toHaveValue("apiKey");
  // Seules les entrées du bon type sont proposées.
  expect(optionLabels(screen.getByLabelText("Mot de passe ou clé"))).toEqual(["Choisir…", "Jeton Jira"]);
  expect(screen.getByLabelText("Nom de l’en-tête")).toBeInTheDocument();
  expect(screen.queryByLabelText("Adresse du serveur de jetons")).not.toBeInTheDocument();

  // Validation à la soumission, sous chaque champ.
  await user.clear(screen.getByLabelText("Nom"));
  await user.type(screen.getByLabelText("Nom"), "Jira");
  await user.type(screen.getByLabelText("Adresse du service"), "http://jira.exemple.com");
  await user.click(screen.getByRole("button", { name: "Créer" }));
  expect(screen.getByText(/Saisissez une adresse en https:\/\//)).toBeInTheDocument();
  expect(screen.getByText("Choisissez un mot de passe ou une clé.")).toBeInTheDocument();
  expect(screen.getByText("Saisissez le nom de l’en-tête.")).toBeInTheDocument();
  expect(lastCall("clients.save")).toBeUndefined();

  await user.clear(screen.getByLabelText("Adresse du service"));
  await user.type(screen.getByLabelText("Adresse du service"), "https://jira.exemple.com");
  await user.selectOptions(screen.getByLabelText("Mot de passe ou clé"), "jeton-jira");
  await user.type(screen.getByLabelText("Nom de l’en-tête"), "X-Api-Key");
  await user.type(screen.getByLabelText("En-têtes fixes (facultatif)"), "Accept: application/json");
  await user.type(screen.getByLabelText("Chemin de test (facultatif)"), "myself");
  await user.click(screen.getByRole("button", { name: "Créer" }));
  expect(await screen.findByText("Saisissez un chemin qui commence par « / », ex. /me.")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("Chemin de test (facultatif)"));
  await user.type(screen.getByLabelText("Chemin de test (facultatif)"), "/myself");
  // Le service du même nom répond d’office à la demande du module.
  needs = needs.map((need) => ({ ...need, client: "tickets" }));
  await user.click(screen.getByRole("button", { name: "Créer" }));

  // Le fichier du service ne reçoit que l’identifiant de l’entrée du coffre.
  const service = await screen.findByRole("group", { name: "Comptes Jira" });
  expect(lastCall("clients.save")).toEqual({
    create: true,
    client: {
      id: "tickets",
      label: "Jira",
      baseUrl: "https://jira.exemple.com",
      auth: { type: "apiKey", secret: "jeton-jira", header: "X-Api-Key" },
      headers: { Accept: "application/json" },
      testPath: "/myself",
    },
  });
  expect(within(service).getByText(/^https:\/\/jira\.exemple\.com · Clé d’API/)).toBeInTheDocument();
  // Prêt : aucune pastille d’état, rien à faire.
  expect(within(service).queryByText(/À connecter|manquant|À approuver/)).not.toBeInTheDocument();

  // Tester : le résultat est notifié et reste visible sur la ligne.
  await user.click(await menuItem(user, "Jira", "Tester"));
  await waitFor(() => expect(notifications()).toContain("Jira : le service répond"));
  expect(lastCall("clients.test")).toEqual({ id: "tickets" });
  expect(within(service).getByText("Dernier test : 200 · 42 ms")).toBeInTheDocument();

  // Édition : identifiant figé, champs repris du service.
  await user.click(await menuItem(user, "Jira", "Modifier le service…"));
  expect(screen.getByLabelText("Identifiant")).toBeDisabled();
  expect(screen.getByLabelText("Mot de passe ou clé")).toHaveValue("jeton-jira");
  expect(screen.getByLabelText("Nom de l’en-tête")).toHaveValue("X-Api-Key");
  expect(screen.getByLabelText("En-têtes fixes (facultatif)")).toHaveValue("Accept: application/json");
  await user.click(screen.getByRole("button", { name: "Annuler" }));

  // Avancé : faire utiliser au module un autre service déjà configuré, appliqué dès le choix.
  await user.click(await screen.findByRole("button", { name: "Service utilisé pour Tickets par le module CRM" }));
  await user.click(await screen.findByRole("menuitem", { name: "Utiliser « Secours » à la place" }));
  await waitFor(() => expect(lastCall("clients.bind")).toEqual({ need: "crm/tickets", client: "secours" }));
  // Un service utilisé par un module ne se supprime pas depuis sa fiche.
  await user.click(screen.getByRole("button", { name: "Actions de Secours" }));
  expect(screen.queryByRole("menuitem", { name: "Supprimer le service…" })).not.toBeInTheDocument();
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

  // Le formulaire OAuth 2 montre ses adresses et l’adresse de retour à déclarer chez le fournisseur.
  await user.click(await menuItem(user, "Portail", "Modifier le service…"));
  expect(screen.getByLabelText("Adresse d’autorisation")).toHaveValue("https://sso.exemple.com/authorize");
  expect(screen.getByLabelText("Adresse du serveur de jetons")).toHaveValue("https://sso.exemple.com/token");
  expect(screen.getByLabelText("Autorisations demandées (facultatif)")).toHaveValue("lire");
  expect(screen.getByText(new RegExp(REDIRECT))).toBeInTheDocument();
});

it("crée l’entrée du coffre manquante depuis le formulaire d’un client demandé par un module", async () => {
  const user = userEvent.setup();
  vault = [entry("jeton-jira", "Jeton Jira", "token")];
  needs = [
    {
      key: "rh/paie",
      module: "rh",
      moduleName: "RH",
      id: "paie",
      label: "Paie",
      baseUrl: "https://paie.exemple.com",
      auth: "basic",
      binding: null,
      client: null,
    },
  ];
  renderModules();
  await openModule(user, "RH");
  await user.click(await screen.findByRole("button", { name: "Configurer Paie" }));

  // Le formulaire reprend ce que le module demande.
  expect(screen.getByLabelText("Nom")).toHaveValue("Paie");
  expect(screen.getByLabelText("Identifiant")).toHaveValue("paie");
  expect(screen.getByLabelText("Adresse du service")).toHaveValue("https://paie.exemple.com");
  expect(screen.getByLabelText("Type de connexion")).toHaveValue("basic");
  // Aucune entrée « identifiant et mot de passe » : le raccourci la crée, avec le type imposé.
  expect(optionLabels(screen.getByLabelText("Mot de passe ou clé"))).toEqual(["Choisir…"]);
  await user.click(screen.getByRole("button", { name: "Nouveau…" }));
  const dialog = screen.getByRole("dialog", { name: "Nouveau mot de passe ou clé" });
  expect(within(dialog).getByLabelText("Type")).toHaveValue("basic");
  expect(within(dialog).getByLabelText("Type")).toBeDisabled();
  expect(within(dialog).getByLabelText("Libellé")).toHaveValue("Paie");
  await user.type(within(dialog).getByLabelText("Identifiant de connexion"), "alice");
  await user.type(within(dialog).getByLabelText("Mot de passe"), "p4ss-CCC");
  await user.click(within(dialog).getByRole("button", { name: "Créer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  // L’entrée créée est choisie d’office ; le client part sans le mot de passe.
  expect(screen.getByLabelText("Mot de passe ou clé")).toHaveValue("paie");
  expect(document.body.textContent).not.toContain("p4ss-CCC");
  needs = needs.map((need) => ({ ...need, client: "paie" }));
  await user.click(screen.getByRole("button", { name: "Créer" }));
  await screen.findByRole("group", { name: "Comptes Paie" });
  expect(lastCall("clients.save")).toEqual({
    create: true,
    client: {
      id: "paie",
      label: "Paie",
      baseUrl: "https://paie.exemple.com",
      auth: { type: "basic", secret: "paie" },
      headers: {},
    },
  });
  expect(JSON.stringify(calls.filter((call) => call.command.startsWith("clients.")))).not.toContain("p4ss-CCC");
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

it("crée un client à plusieurs instances, ajoute ses instances et les gère une à une", async () => {
  const user = userEvent.setup();
  vault = [entry("pat-acme", "PAT Acme", "token"), entry("cloud-compte", "Compte Cloud", "basic")];
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
      client: null,
    },
  ];
  // La page du module par compte : chaque compte dit quelle page il alimente.
  renderModules([
    {
      id: "suivi/tickets@acme",
      module: "suivi",
      label: "Tickets — Acme",
      icon: null,
      color: null,
      hidden: false,
      pages: [],
      instance: "acme",
    },
  ]);
  await openModule(user, "Suivi");
  await user.click(await screen.findByRole("button", { name: "Configurer Jira" }));

  // Plusieurs comptes : l’adresse devient facultative, l’entrée du coffre quitte le service pour le compte.
  needs = needs.map((need) => ({ ...need, client: "jira" }));
  await user.click(screen.getByLabelText("Plusieurs comptes"));
  expect(screen.getByLabelText("Adresse par défaut (facultative)")).toBeInTheDocument();
  expect(screen.queryByLabelText("Mot de passe ou clé")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Nom de la façon de se connecter"), "Data Center (PAT)");
  await user.selectOptions(screen.getByLabelText("Type de connexion"), "bearer");
  await user.click(screen.getByRole("button", { name: "Ajouter une façon de se connecter" }));
  await user.type(screen.getAllByLabelText("Nom de la façon de se connecter")[1], "Jira Cloud");
  await user.selectOptions(screen.getAllByLabelText("Type de connexion")[1], "basic");
  await user.click(screen.getByRole("button", { name: "Créer" }));
  expect(lastCall("clients.save")).toEqual({
    create: true,
    client: {
      id: "jira",
      label: "Jira",
      baseUrl: "",
      methods: [
        { id: "data-center-pat", label: "Data Center (PAT)", type: "bearer" },
        { id: "jira-cloud", label: "Jira Cloud", type: "basic" },
      ],
      headers: {},
    },
  });

  // Le client créé n’a rien à appeler : la première instance se saisit tout de suite, champ par champ.
  expect(await screen.findByText("Nouveau compte Jira")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  expect(screen.getByText("Saisissez le nom du compte.")).toBeInTheDocument();
  expect(screen.getByText("Saisissez l’adresse du compte.")).toBeInTheDocument();
  expect(screen.getByText("Choisissez un mot de passe ou une clé.")).toBeInTheDocument();
  expect(lastCall("clients.saveInstance")).toBeUndefined();
  await user.type(screen.getByLabelText("Nom du compte"), "Acme");
  expect(screen.getByLabelText("Identifiant du compte")).toHaveValue("acme");
  await user.type(screen.getByLabelText("Adresse du compte"), "https://jira.acme.fr");
  // Seules les entrées du type de la méthode choisie sont proposées.
  expect(optionLabels(screen.getByLabelText("Mot de passe ou clé"))).toEqual(["Choisir…", "PAT Acme"]);
  await user.selectOptions(screen.getByLabelText("Mot de passe ou clé"), "pat-acme");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  expect(lastCall("clients.saveInstance")).toEqual({
    client: "jira",
    create: true,
    instance: { id: "acme", label: "Acme", method: "data-center-pat", url: "https://jira.acme.fr", secret: "pat-acme" },
  });

  // La fiche montre directement les comptes du seul service du module, avec la page que chacun alimente.
  const instancesTable = await screen.findByRole("group", { name: "Comptes Jira" });
  expect(screen.getByRole("heading", { name: "Comptes" })).toBeInTheDocument();
  expect(within(instancesTable).getByText("Acme")).toBeInTheDocument();
  expect(within(instancesTable).getByText("Page « Tickets — Acme » dans le menu")).toBeInTheDocument();
  // Rien de technique : l’adresse du compte reste dans son formulaire.
  expect(within(instancesTable).queryByText(/jira\.acme\.fr/)).not.toBeInTheDocument();
  // Un seul compte : il n’y a pas de « par défaut » à montrer.
  expect(within(instancesTable).queryByText("Par défaut")).not.toBeInTheDocument();

  // Une deuxième instance, avec une autre méthode et donc d’autres entrées du coffre.
  await user.click(screen.getByRole("button", { name: "Ajouter un compte à Jira" }));
  await user.type(screen.getByLabelText("Nom du compte"), "Cloud");
  await user.type(screen.getByLabelText("Adresse du compte"), "https://acme.atlassian.net");
  await user.selectOptions(screen.getByLabelText("Type de connexion"), "jira-cloud");
  expect(optionLabels(screen.getByLabelText("Mot de passe ou clé"))).toEqual(["Choisir…", "Compte Cloud"]);
  await user.selectOptions(screen.getByLabelText("Mot de passe ou clé"), "cloud-compte");
  await user.click(screen.getByRole("button", { name: "Ajouter" }));
  const instances = await screen.findByRole("group", { name: "Comptes Jira" });
  expect(await within(instances).findByText("Cloud")).toBeInTheDocument();

  // Chaque instance se teste et peut devenir celle par défaut.
  await user.click(await menuItem(user, "Jira — Cloud", "Tester"));
  await waitFor(() => expect(notifications()).toContain("Jira — Cloud : le service répond"));
  expect(lastCall("clients.test")).toEqual({ id: "jira", instance: "cloud" });
  await user.click(await menuItem(user, "Jira — Cloud", "Utiliser par défaut"));
  expect(lastCall("clients.defaultInstance")).toEqual({ client: "jira", instance: "cloud" });
  await user.click(screen.getByRole("button", { name: "Actions de Jira — Cloud" }));
  expect(await screen.findByRole("menuitem", { name: "Tester" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Utiliser par défaut" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");

  // Une instance modifiée hors des Réglages : la validation du client montre l’instance concernée.
  pending["jira#cloud"] = {
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
  await user.click(await screen.findByRole("button", { name: "Approuver Jira" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("Cloud · Adresse du service")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Approuver" }));
  await waitFor(() => expect(notifications()).toContain("Jira est approuvé"));
  expect(lastCall("clients.validate")).toEqual({
    id: "jira",
    fingerprints: { cloud: { baseUrl: "https://ailleurs.fr" } },
  });

  // Supprimer une instance est confirmé, et ne touche ni au client ni aux autres instances.
  await user.click(await menuItem(user, "Jira — Acme", "Supprimer le compte…"));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(lastCall("clients.deleteInstance")).toEqual({ client: "jira", instance: "acme" }));
  await waitFor(() => expect(within(instances).queryByText("Acme")).not.toBeInTheDocument());
  expect(screen.getByRole("group", { name: "Comptes Jira" })).toBeInTheDocument();
});
