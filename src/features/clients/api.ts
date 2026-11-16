/** Commandes `clients.*` du backend (voir `src-tauri/src/clients.rs`) et leurs modèles. */
import { invoke } from "../../lib/native";
import type { VaultKind } from "../vault/api";

export type AuthType = "none" | "bearer" | "apiKey" | "basic" | "oauth2" | "clientCredentials";

export interface ClientAuth {
  type: AuthType;
  /** Identifiant de l’entrée du coffre, jamais la valeur. */
  secret?: string;
  header?: string;
  prefix?: string;
  queryParam?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

/** Façon de s’authentifier proposée par un client à plusieurs instances ; chaque instance en choisit une. */
export interface ClientMethod extends Omit<ClientAuth, "secret"> {
  id: string;
  label?: string;
}

/**
 * Contenu du fichier `clients/<id>.json` de l’espace, sous l’une de ses deux formes : une seule adresse (`baseUrl`
 * et `auth`, avec son entrée du coffre), ou plusieurs instances (`methods`, les instances se gérant à part).
 */
export interface ClientConfig {
  id: string;
  label: string;
  /** Adresse du client ; avec `methods`, adresse proposée par défaut aux instances (peut être vide). */
  baseUrl: string;
  auth?: ClientAuth;
  methods?: ClientMethod[];
  headers?: Record<string, string>;
  /** Chemin lu par le bouton Tester, pour chaque instance ; sans lui, la racine de l’adresse. */
  testPath?: string;
}

/** Instance d’un client : un compte ou une installation, avec son adresse, sa méthode et son entrée du coffre. */
export interface ClientInstanceConfig {
  id: string;
  label: string;
  /** Adresse de l’instance ; absente, celle du client. */
  url?: string;
  method: string;
  secret?: string;
}

export type ClientStatus = "ready" | "toValidate" | "noInstance" | "missingSecret" | "toConnect" | "invalid";

/** Écart entre ce que l’utilisateur a validé et ce que dit le fichier du client aujourd’hui. */
export interface ClientChange {
  /** `authType`, `secret`, `baseUrl`, `authorizationUrl`, `tokenUrl`, `scopes`, `header`, `queryParam`, `prefix`, `headers`. */
  field: string;
  label: string;
  before: string | null;
  after: string | null;
  /** Client à plusieurs instances : instance concernée. */
  instance?: string;
  instanceLabel?: string;
}

/** Validation d’un client qui utilise un secret : Alfred n’envoie rien tant que `validated` est faux. */
export interface ClientValidation {
  validated: boolean;
  /** Faux pour un client jamais validé (créé par l’agent ou venu avec l’espace). */
  everValidated: boolean;
  changes: ClientChange[];
  /** Valeurs à approuver, renvoyées telles quelles à `clients.validate` (client à une seule instance). */
  fingerprint: Record<string, string | null> | null;
  /** Valeurs à approuver, instance par instance. */
  fingerprints?: Record<string, Record<string, string | null>>;
}

export interface ClientUse {
  /** `module/demande`. */
  key: string;
  module: string;
  moduleName: string;
  label: string;
}

export interface ClientInstanceItem extends ClientInstanceConfig {
  /** Instance utilisée quand une page n’en nomme pas : la première. */
  default: boolean;
  status: Exclude<ClientStatus, "noInstance">;
  hasSecret: boolean;
  connected: boolean | null;
  problem: string | null;
  validation: Omit<ClientValidation, "fingerprints"> | null;
  /** Adresse réellement appelée ; `null` si l’instance est invalide. */
  effectiveUrl: string | null;
  authType: AuthType | null;
  /** Dernier test du compte dans son état actuel ; `null` s’il n’a pas été testé depuis sa modification. */
  lastTest?: { ok: boolean; message: string; testedAt: string } | null;
}

export interface ClientItem extends ClientConfig {
  methods: ClientMethod[];
  instances: ClientInstanceItem[];
  /** Vrai pour un client à une seule adresse, écrit sous la forme simple. */
  simple: boolean;
  status: ClientStatus;
  hasSecret: boolean;
  /** OAuth 2 seulement ; `null` pour les autres authentifications. */
  connected: boolean | null;
  /** Demandes de modules auxquelles ce client répond. */
  usedBy: ClientUse[];
  problem: string | null;
  /** `null` pour un client sans authentification. */
  validation: ClientValidation | null;
}

/** Client qu’un module déclare vouloir, et le client de l’espace qui y répond aujourd’hui. */
export interface ClientNeedItem {
  key: string;
  module: string;
  moduleName: string;
  id: string;
  label: string;
  baseUrl: string | null;
  auth: string | null;
  /** Liaison faite par l’utilisateur ; peut désigner un client disparu. */
  binding: string | null;
  /** Client effectivement utilisé : la liaison, sinon le client du même nom ; `null` si la demande reste à relier. */
  client: string | null;
}

export interface ClientsOverview {
  clients: ClientItem[];
  needs: ClientNeedItem[];
  /** Adresse de retour OAuth à déclarer chez le fournisseur d’identité. */
  redirectUri: string | null;
}

export interface ClientTestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  message: string;
}

export const AUTH_TYPES: ReadonlyArray<{ type: AuthType; label: string; vaultKind?: VaultKind }> = [
  { type: "none", label: "Aucune" },
  { type: "bearer", label: "Jeton d’accès", vaultKind: "token" },
  { type: "apiKey", label: "Clé d’API", vaultKind: "token" },
  { type: "basic", label: "Identifiant et mot de passe", vaultKind: "basic" },
  { type: "oauth2", label: "Connexion par le navigateur (OAuth)", vaultKind: "oauth2" },
  { type: "clientCredentials", label: "Identifiants d’application (OAuth)", vaultKind: "clientCredentials" },
];

export function authTypeLabel(type: string): string {
  return AUTH_TYPES.find((item) => item.type === type)?.label ?? type;
}

export function methodLabel(method: ClientMethod): string {
  return method.label || authTypeLabel(method.type);
}

export const listClients = () => invoke<ClientsOverview>("clients.list");
export const saveClient = (client: ClientConfig, create: boolean) =>
  invoke<ClientItem>("clients.save", { client, create });
export const deleteClient = (id: string) => invoke<null>("clients.delete", { id });
/** Approuve les valeurs affichées ; refusé si le fichier a changé depuis. */
export const validateClient = (client: ClientItem) =>
  invoke<ClientItem>(
    "clients.validate",
    client.simple
      ? { id: client.id, fingerprint: client.validation?.fingerprint }
      : { id: client.id, fingerprints: client.validation?.fingerprints ?? {} },
  );
/** `instance` absente : l’instance par défaut. */
const target = (id: string, instance?: string) => (instance ? { id, instance } : { id });
export const testClient = (id: string, instance?: string) =>
  invoke<ClientTestResult>("clients.test", target(id, instance));
export const bindNeed = (need: string, client: string | null) =>
  invoke<{ bindings: Record<string, string> }>("clients.bind", { need, client });
export const connectClient = (id: string, instance?: string) =>
  invoke<{ authorizationUrl: string }>("clients.connect", target(id, instance));
export const disconnectClient = (id: string, instance?: string) =>
  invoke<null>("clients.disconnect", target(id, instance));
export const saveInstance = (client: string, instance: ClientInstanceConfig, create: boolean) =>
  invoke<ClientItem>("clients.saveInstance", { client, instance, create });
export const deleteInstance = (client: string, instance: string) =>
  invoke<ClientItem>("clients.deleteInstance", { client, instance });
export const makeDefaultInstance = (client: string, instance: string) =>
  invoke<ClientItem>("clients.defaultInstance", { client, instance });
