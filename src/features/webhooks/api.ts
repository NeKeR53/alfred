/** Commandes `webhooks.*` du backend (voir `src-tauri/src/webhooks.rs`). */
import { invoke } from "../../lib/native";

export interface WebhookItem {
  module: string;
  id: string;
  description: string;
  /** Fonction du module déclenchée à chaque réception. */
  function: string;
  /** Adresse locale ; `null` si le serveur local n’a pas démarré. */
  url: string | null;
  lastReceivedAt: string | null;
  functionExists: boolean;
}

export const hookKey = (hook: Pick<WebhookItem, "module" | "id">) => `${hook.module}/${hook.id}`;

export const listWebhooks = () => invoke<WebhookItem[]>("webhooks.list");
export const getWebhookSecret = (hook: string) => invoke<{ secret: string }>("webhooks.secret", { hook });
export const rotateWebhookSecret = (hook: string) => invoke<{ secret: string }>("webhooks.rotate", { hook });
