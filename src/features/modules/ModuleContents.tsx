/**
 * Contenu d’un module dans sa fiche (Réglages → Modules), page d’abord : ses pages, chacune avec les comptes dont
 * elle se sert ; puis les comptes qu’aucune page n’utilise (fonctions, automatismes) ; puis ses fonctions, rangées
 * par service. Rien de vide ne s’affiche.
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
import { ExampleModePart } from "./ExampleModePart";
import { ModulePageGroups } from "./ModulePageGroups";
import { listing } from "./ModulePages";
import { ModulePart } from "./ModulePart";
import { needsWithoutPage, pageGroups } from "./pageGroups";

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
  const groups = snapshot ? pageGroups(snapshot, module.id) : [];
  // Les besoins du module qu’aucune page n’utilise, et ceux de ses dépendances dont une page se sert.
  const withoutPage = needsWithoutPage(
    groups,
    needs.map((need) => need.key),
  );
  const loading =
    overview === undefined ? (
      services.error ? (
        <Text size="meta" tone="danger">
          Les comptes n’ont pas pu être lus. {services.error}
        </Text>
      ) : (
        <Spinner label="Chargement des comptes" />
      )
    ) : null;
  const usedBy =
    module.requiredBy.length > 0
      ? `${listing(module.requiredBy.map(nameOf))} ${module.requiredBy.length > 1 ? "s’en servent" : "s’en sert"} aussi, par ce module.`
      : undefined;
  const serviceNames = needs.filter((need) => (byService.get(need.id) ?? []).length > 0);

  return (
    <>
      {groups.length > 0 && snapshot ? (
        <ModulePart
          part="pages"
          title="Pages"
          description="Les pages que ce module ajoute au menu, et sous chacune les comptes dont elle se sert. Décochez une page pour la retirer du menu."
        >
          <ModulePageGroups
            module={module}
            modules={modules}
            snapshot={snapshot}
            groups={groups}
            services={services}
            onEdit={onEditService}
            disabled={hidden}
            loading={loading}
          />
        </ModulePart>
      ) : null}
      {(overview === undefined && groups.length === 0 && module.clients.length > 0) || withoutPage.length > 0 ? (
        <ModulePart
          part="services"
          title={groups.length > 0 ? "Autres comptes" : "Comptes"}
          description={
            groups.length > 0
              ? "Les comptes dont se servent les fonctions et les automatismes du module, sans page à eux."
              : "Les comptes dont ce module se sert, et de quoi les ajouter et les tester."
          }
        >
          {loading ?? (
            <div className="service-list">
              {withoutPage.map((key) => {
                const need = needs.find((candidate) => candidate.key === key);
                if (!need || !overview) return null;
                return (
                  <ServiceBlock
                    key={need.key}
                    need={need}
                    client={overview.clients.find((client) => client.id === need.client)}
                    template={templateOf(modules, need.module, need.id)}
                    help={module.clients.find((item) => item.id === need.id)?.help || undefined}
                    controller={services}
                    onEdit={onEditService}
                    titled
                    purpose={usedBy}
                  />
                );
              })}
            </div>
          )}
        </ModulePart>
      ) : null}
      {snapshot ? <ExampleModePart module={module} snapshot={snapshot} /> : null}
      {functions.length > 0 ? (
        <ModulePart
          part="functions"
          title="Fonctions"
          description="Ce que le module fait, rangé par service : lire, écrire, et les traitements qui ne passent par aucun service."
        >
          <div className="module-functions">
            {serviceNames.map((need) => (
              <FunctionGroup
                key={need.key}
                module={module}
                functions={byService.get(need.id) ?? []}
                tests={tests}
                label={`Ce que le module fait avec ${need.label}`}
              />
            ))}
            {others.length > 0 ? (
              <div data-part="other-functions">
                <FunctionGroup
                  module={module}
                  functions={others}
                  tests={tests}
                  label={serviceNames.length > 0 ? "Sans service" : "Fonctions"}
                  open={false}
                />
              </div>
            ) : null}
          </div>
        </ModulePart>
      ) : null}
    </>
  );
}
