/**
 * Contenu d’un module dans sa fiche (Réglages → Modules), rangé par la hiérarchie : ce qu’il ajoute au menu, puis
 * un bloc par service (à quoi il sert, vos comptes chez lui, ce que le module fait avec), puis ses autres fonctions.
 * Rien de vide ne s’affiche.
 */
import { Spinner, Text } from "@alfred/ui";
import type { ModuleSummary, ResolvedFunction, Snapshot } from "../../lib/types";
import type { ClientNeedItem } from "../clients/api";
import { templateOf } from "../clients/fromTemplate";
import { ServiceBlock } from "../clients/ServiceBlock";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { FunctionGroup } from "../functions/ModuleFunctions";
import { useFunctionTests } from "../functions/tests";
import { listing, ModulePages, moduleGroups, pagesUsing } from "./ModulePages";
import { ModulePart } from "./ModulePart";

/**
 * Range les fonctions du module sous ses services : chacune sous ceux qu’elle déclare (`uses.clients`) ; sans
 * déclaration, sous le service du module s’il n’en a qu’un (comme `check`, qui tient alors la fonction pour un
 * relais vers ce service). Le reste est « autres ».
 */
export function groupFunctions(
  functions: ResolvedFunction[],
  services: string[],
): { byService: Map<string, ResolvedFunction[]>; others: ResolvedFunction[] } {
  const byService = new Map(services.map((id) => [id, [] as ResolvedFunction[]]));
  const others: ResolvedFunction[] = [];
  for (const fn of functions) {
    const declared = (fn.uses.clients ?? []).filter((id) => byService.has(id));
    const targets =
      declared.length > 0 ? declared : (fn.uses.clients ?? []).length === 0 && services.length === 1 ? services : [];
    if (targets.length === 0) others.push(fn);
    for (const id of targets) byService.get(id)?.push(fn);
  }
  return { byService, others };
}

export function ModuleContents({
  module,
  modules,
  snapshot,
  services,
  onEditService,
  hidden,
  nameOf,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  snapshot: Snapshot | null;
  services: ClientsController;
  onEditService: (editing: ServiceEditing) => void;
  /** Module désactivé : ses pages n’apparaissent pas dans le menu. */
  hidden: boolean;
  nameOf: (module: string) => string;
}) {
  const { tests } = useFunctionTests(module.id);
  const functions = snapshot?.functions.filter((fn) => fn.module === module.id) ?? [];
  const overview = services.overview;
  const needs: ClientNeedItem[] = overview?.needs.filter((need) => need.module === module.id) ?? [];
  const { byService, others } = groupFunctions(
    functions,
    overview ? needs.map((need) => need.id) : module.clients.map((need) => need.id),
  );
  const hasPages = snapshot ? moduleGroups(snapshot, module.id).length > 0 : false;
  const perInstance = (need: string) =>
    Boolean(snapshot?.sections.some((section) => section.module === module.id && section.perInstance === need));

  /** À quoi sert le service : les pages qui l’utilisent, et les modules qui passent par ce module. */
  const purposeOf = (need: ClientNeedItem) => {
    const pages = snapshot ? pagesUsing(snapshot, module.id, need.id) : [];
    return [
      pages.length === 1 ? `Sert à la page « ${pages[0]} ».` : null,
      pages.length > 1 ? `Sert aux pages ${listing(pages.map((page) => `« ${page} »`))}.` : null,
      perInstance(need.id) ? "Le module ajoute une entrée au menu par compte." : null,
      module.requiredBy.length > 0
        ? `${listing(module.requiredBy.map(nameOf))} ${module.requiredBy.length > 1 ? "s’en servent" : "s’en sert"} aussi, par ce module.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
  };

  return (
    <>
      {hasPages && snapshot ? (
        <ModulePart
          part="pages"
          title="Dans le menu"
          description="Les entrées que ce module ajoute au menu de gauche, et leurs onglets. Décochez ce que vous ne voulez pas voir."
        >
          <ModulePages snapshot={snapshot} module={module.id} disabled={hidden} />
        </ModulePart>
      ) : null}
      {module.clients.length > 0 || needs.length > 0 ? (
        <ModulePart
          part="services"
          title="Services"
          description="Les services en ligne auxquels ce module se connecte : vos comptes chez chacun, et ce que le module en fait."
        >
          {overview === undefined ? (
            services.error ? (
              <Text size="meta" tone="danger">
                Les services n’ont pas pu être lus. {services.error}
              </Text>
            ) : (
              <Spinner label="Chargement des services" />
            )
          ) : (
            <div className="service-list">
              {needs.map((need) => (
                <ServiceBlock
                  key={need.key}
                  need={need}
                  client={overview.clients.find((client) => client.id === need.client)}
                  template={templateOf(modules, need.module, need.id)}
                  help={module.clients.find((item) => item.id === need.id)?.help || undefined}
                  controller={services}
                  onEdit={onEditService}
                  titled
                  purpose={purposeOf(need) || undefined}
                  describeInstance={(instance) => {
                    const page = snapshot?.sections.find(
                      (section) => section.module === module.id && section.instance === instance,
                    );
                    return page ? `Entrée « ${page.label} » dans le menu` : undefined;
                  }}
                >
                  <FunctionGroup
                    module={module}
                    functions={byService.get(need.id) ?? []}
                    tests={tests}
                    label={`Ce que le module fait avec ${need.label}`}
                  />
                </ServiceBlock>
              ))}
            </div>
          )}
        </ModulePart>
      ) : null}
      {others.length > 0 ? (
        <ModulePart
          part="other-functions"
          title={needs.length > 0 || module.clients.length > 0 ? "Autres fonctions" : "Fonctions"}
          description="Les traitements propres au module, qui ne passent par aucun service."
        >
          <FunctionGroup
            module={module}
            functions={others}
            tests={tests}
            label="Fonctions"
            open={false}
          />
        </ModulePart>
      ) : null}
    </>
  );
}
