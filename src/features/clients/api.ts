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

/** Contenu du fichier `clients/<id>.json` de l’espace. */
export interface ClientConfig {
  id: string;
  label: string;
  baseUrl: string;
  auth: ClientAuth;
  headers?: Record<string, string>;
}

export type ClientStatus = "ready" | "toValidate" | "missingSecret" | "toConnect" | "invalid";

/** Écart entre ce que l’utilisateur a validé et ce que dit le fichier du client aujourd’hui. */
export interface ClientChange {
  /** `authType`, `secret`, `baseUrl`, `authorizationUrl`, `tokenUrl`, `scopes`, `header`, `queryParam`, `prefix`, `headers`. */
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

/** Validation d’un client qui utilise un secret : Alfred n’envoie rien tant que `validated` est faux. */
export interface ClientValidation {
  validated: boolean;
  /** Faux pour un client jamais validé (créé par l’agent ou venu avec l’espace). */
  everValidated: boolean;
  changes: ClientChange[];
  /** Valeurs à approuver, renvoyées telles quelles à `clients.validate`. */
  fingerprint: Record<string, string | null>;
}

export interface ClientUse {
  /** `module/demande`. */
  key: string;
  module: string;
  moduleName: string;
  label: string;
}

export interface ClientItem extends ClientConfig {
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
  { type: "bearer", label: "Jeton porteur (Bearer)", vaultKind: "token" },
  { type: "apiKey", label: "Clé d’API", vaultKind: "token" },
  { type: "basic", label: "Identifiant et mot de passe (Basic)", vaultKind: "basic" },
  { type: "oauth2", label: "OAuth 2, connexion de l’utilisateur", vaultKind: "oauth2" },
  { type: "clientCredentials", label: "OAuth 2, identifiants d’application", vaultKind: "clientCredentials" },
];

export function authTypeLabel(type: string): string {
  return AUTH_TYPES.find((item) => item.type === type)?.label ?? type;
}

export const listClients = () => invoke<ClientsOverview>("clients.list");
export const saveClient = (client: ClientConfig, create: boolean) =>
  invoke<ClientItem>("clients.save", { client, create });
export const deleteClient = (id: string) => invoke<null>("clients.delete", { id });
/** Approuve les valeurs affichées ; refusé si le fichier a changé depuis. */
export const validateClient = (id: string, fingerprint: ClientValidation["fingerprint"]) =>
  invoke<ClientItem>("clients.validate", { id, fingerprint });
export const testClient = (id: string) => invoke<ClientTestResult>("clients.test", { id });
export const bindNeed = (need: string, client: string | null) =>
  invoke<{ bindings: Record<string, string> }>("clients.bind", { need, client });
export const connectClient = (id: string) => invoke<{ authorizationUrl: string }>("clients.connect", { id });
export const disconnectClient = (id: string) => invoke<null>("clients.disconnect", { id });
