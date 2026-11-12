/** Commandes `marketplace.*` du backend (voir `src-tauri/src/marketplace.rs`) et leurs modèles. */
import { invoke } from "../../lib/native";
import type { ClientNeed } from "../../lib/types";

export interface Marketplace {
  id: string;
  url: string;
  name: string;
  addedAt: string;
  lastChecked: string | null;
  /** Dernier échec de rafraîchissement, ou clone local absent. */
  error?: string;
}

export type AccessKind = "tables" | "client" | "tool" | "webhook" | "schedule";

/** Ce qu’un module demande au-delà de ses pages : client, fonction proposée aux agents, webhook, planification. */
export interface ModuleAccess {
  kind: AccessKind;
  id: string;
  label: string;
}

export interface ModuleChanges {
  pagesAdded: string[];
  pagesRemoved: string[];
  functionsAdded: string[];
  functionsRemoved: string[];
  newAccesses: ModuleAccess[];
}

/** État d’un module installé (non détaché) vis-à-vis de son marketplace. */
export interface ModuleUpdate {
  module: string;
  name: string;
  current: string;
  /** Version proposée, ou `null` quand le module est à jour ou sans source. */
  available: string | null;
  pinned: boolean;
  /** Le marketplace d’origine n’est plus branché. */
  sourceMissing: boolean;
  /** Le marketplace est branché mais ne propose plus ce module. */
  withdrawn: boolean;
  marketplace: string | null;
  marketplaceName: string | null;
  /** Adresse git d’origine. */
  source: string;
  notes: string;
  changes: ModuleChanges;
  locallyModified: boolean;
}

export interface CatalogModule {
  id: string;
  name: string;
  /** Manifeste illisible : le module est listé mais ne peut pas être installé. */
  error?: string;
  version?: string;
  description?: string;
  pages?: Array<{ id: string; title: string; description: string }>;
  functions?: Array<{ id: string; description: string; tool: boolean }>;
  clients?: ClientNeed[];
  webhooks?: Array<{ id: string; description: string; function: string }>;
  schedules?: Array<{ id: string; description: string; function: string; everyMinutes?: number; at?: string }>;
  tools?: Array<{ id: string; description: string }>;
  /** Module dont celui-ci lit les données (`x` pour un module `x-ajouts`). */
  extends?: string | null;
  /** Version installée depuis ce marketplace, ou `null`. */
  installed?: string | null;
  /** Un module de même identifiant existe déjà dans l’espace sans venir de ce marketplace. */
  conflict?: boolean;
  notes?: string;
}

export interface PublishProblem {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export interface UpdateAllResult {
  updated: Array<{ module: string; name: string; from: string; to: string }>;
  failed: Array<{ module: string; name: string; message: string }>;
}

export const marketplaceApi = {
  list: () => invoke<Marketplace[]>("marketplace.list"),
  add: (url: string) => invoke<Marketplace>("marketplace.add", { url }),
  remove: (id: string) => invoke<null>("marketplace.remove", { id }),
  refresh: (id?: string) => invoke<Marketplace[]>("marketplace.refresh", id ? { id } : {}),
  modules: (id: string) => invoke<CatalogModule[]>("marketplace.modules", { id }),
  install: (marketplace: string, module: string) => invoke("marketplace.install", { marketplace, module }),
  updates: (refresh: boolean) => invoke<ModuleUpdate[]>("marketplace.updates", { refresh }),
  update: (module: string) => invoke<{ from: string; to: string }>("marketplace.update", { module }),
  updateAll: () => invoke<UpdateAllResult>("marketplace.updateAll"),
  pin: (module: string, pinned: boolean) => invoke("marketplace.pin", { module, pinned }),
  detach: (module: string) => invoke("marketplace.detach", { module }),
  uninstall: (module: string, deleteData: boolean) => invoke("marketplace.uninstall", { module, deleteData }),
  publish: (module: string, marketplace: string, version: string, notes: string) =>
    invoke<{ version: string; commit: string }>("marketplace.publish", { module, marketplace, version, notes }),
  suggestVersion: (module: string, marketplace: string) =>
    invoke<{ version: string; published: string | null; local: string }>("marketplace.suggestVersion", {
      module,
      marketplace,
      refresh: true,
    }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Problèmes précis (fichier, ligne) renvoyés par une publication refusée ; vide pour toute autre erreur. */
export function publishProblems(error: unknown): PublishProblem[] {
  const detail = (error as { detail?: { problems?: unknown } } | null)?.detail;
  return Array.isArray(detail?.problems) ? (detail.problems as PublishProblem[]) : [];
}

/** Accès demandés par un module du catalogue, dans l’ordre où l’écran d’installation les présente. */
export function catalogAccesses(module: CatalogModule): ModuleAccess[] {
  const label = (text: string | undefined, id: string) => (text?.trim() ? text.trim() : id);
  return [
    // Un module `x-ajouts` lit les données du module `x` : c’est un accès comme un autre.
    ...(module.extends
      ? [
          {
            kind: "tables" as const,
            id: module.extends,
            label: `lecture des données du module « ${module.extends} »`,
          },
        ]
      : []),
    ...(module.clients ?? []).map((client) => ({
      kind: "client" as const,
      id: client.id,
      label: label(client.label, client.id),
    })),
    ...(module.tools ?? []).map((tool) => ({
      kind: "tool" as const,
      id: tool.id,
      label: label(tool.description, tool.id),
    })),
    ...(module.webhooks ?? []).map((webhook) => ({
      kind: "webhook" as const,
      id: webhook.id,
      label: label(webhook.description, webhook.id),
    })),
    ...(module.schedules ?? []).map((schedule) => {
      const cadence = schedule.everyMinutes
        ? ` (toutes les ${schedule.everyMinutes} min)`
        : schedule.at
          ? ` (chaque jour à ${schedule.at})`
          : "";
      return {
        kind: "schedule" as const,
        id: schedule.id,
        label: `${label(schedule.description, schedule.id)}${cadence}`,
      };
    }),
  ];
}

export const accessKindLabel: Record<AccessKind, string> = {
  tables: "Données d’un autre module",
  client: "Client",
  tool: "Fonction proposée aux agents",
  webhook: "Webhook",
  schedule: "Planification",
};
