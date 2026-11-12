/** Commandes `vault.*` du backend (voir `src-tauri/src/vault.rs`). Aucune ne renvoie de valeur secrète. */
import { invoke } from "../../lib/native";

export type VaultKind = "token" | "basic" | "oauth2" | "clientCredentials";

export interface VaultEntry {
  id: string;
  label: string;
  kind: VaultKind;
  /** Champs non secrets : `username` (basic), `clientId` (oauth2, clientCredentials). */
  meta: Record<string, string>;
  updatedAt: string;
  /** Le secret saisi par l’utilisateur est présent dans le trousseau. */
  hasSecret: boolean;
  /** OAuth 2 seulement : des jetons ont été obtenus. */
  connected?: boolean;
  /** Le trousseau n’a pas pu être lu pour cette entrée. */
  problem?: string;
}

export const VAULT_KINDS: ReadonlyArray<{ kind: VaultKind; label: string }> = [
  { kind: "token", label: "Jeton ou clé d’API" },
  { kind: "basic", label: "Identifiant et mot de passe" },
  { kind: "oauth2", label: "OAuth 2, connexion de l’utilisateur" },
  { kind: "clientCredentials", label: "OAuth 2, identifiants d’application" },
];

export function vaultKindLabel(kind: VaultKind): string {
  return VAULT_KINDS.find((item) => item.kind === kind)?.label ?? kind;
}

export interface VaultSaveInput {
  /** Absent à la création pour laisser le backend le déduire du libellé. */
  id?: string;
  label: string;
  kind: VaultKind;
  meta: Record<string, string>;
  /** Un champ absent ou vide conserve la valeur enregistrée. */
  secrets: Record<string, string>;
}

export const listVault = () => invoke<VaultEntry[]>("vault.list");
export const saveVaultEntry = (input: VaultSaveInput) => invoke<VaultEntry>("vault.save", { ...input });
export const deleteVaultEntry = (id: string) => invoke<null>("vault.delete", { id });

/** Même règle que le backend : minuscules, chiffres et tirets, 64 caractères au plus, sans tiret initial. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Identifiant proposé à partir d’un libellé (« Jeton Jira » → « jeton-jira »). */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
