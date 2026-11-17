/**
 * Création d’un service d’après le modèle que son module décrit (`clients[].client` de `module.json`) : l’adresse
 * et la façon de se connecter viennent du module, l’utilisateur n’ajoute que son compte.
 */
import type { ModuleSummary } from "../../lib/types";
import { slugify } from "../vault/api";
import { type ClientConfig, type ClientItem, type ClientNeedItem, saveClient } from "./api";
import type { ClientsController } from "./useClients";

/** Modèle du service que le besoin `need` du module `module` décrit, s’il en a un. */
export function templateOf(modules: ModuleSummary[], module: string, need: string): Partial<ClientConfig> | undefined {
  const template = modules.find((candidate) => candidate.id === module)?.clients.find((item) => item.id === need)
    ?.client as Partial<ClientConfig> | undefined;
  return template && typeof template === "object" ? template : undefined;
}

/** Le modèle demande-t-il un compte (une authentification) ? */
export function templateNeedsAccount(template: Partial<ClientConfig>): boolean {
  if (template.methods?.length) return template.methods.some((method) => method.type !== "none");
  return (template.auth?.type ?? "none") !== "none";
}

/** Identifiant libre pour un nouveau service : celui du besoin, sinon suffixé. */
function freeId(wanted: string, clients: ClientItem[]) {
  const base = slugify(wanted) || "service";
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!clients.some((client) => client.id === id)) return id;
  }
}

/** Crée le service d’un besoin d’après son modèle et l’y relie ; rend le service créé. */
export async function createFromTemplate(
  template: Partial<ClientConfig>,
  need: Pick<ClientNeedItem, "key" | "id" | "label">,
  services: ClientsController,
): Promise<ClientItem> {
  const clients = services.overview?.clients ?? [];
  const taken = clients.some((known) => known.id === need.id);
  const id = taken ? freeId(need.id, clients) : need.id;
  const saved = await saveClient(
    { ...template, id, label: template.label || need.label, baseUrl: template.baseUrl ?? "" } as ClientConfig,
    true,
  );
  // Un service créé sous un autre nom que le besoin doit lui être relié.
  const needItem = services.overview?.needs.find((candidate) => candidate.key === need.key);
  if (id !== need.id && needItem) await services.bind(needItem, id);
  await services.load();
  return saved;
}
