/**
 * Contenu d’un module dans sa fiche (Réglages → Modules), page d’abord : vos pages qui viennent du module, chacune
 * avec ses onglets et leurs comptes, et de quoi en ajouter ; puis les comptes de ses services, chacun avec les pages
 * qui s’en servent ; puis ses fonctions, rangées par service. Rien de vide ne s’affiche.
 */
import { Spinner, Text } from "@alfred/ui";
import type { ModuleSummary, ResolvedFunction, Snapshot } from "../../lib/types";
import { accountUsers, usageSentence } from "../clients/AccountPages";
import type { ClientNeedItem } from "../clients/api";
import { templateOf } from "../clients/fromTemplate";
import { ServiceBlock } from "../clients/ServiceBlock";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { FunctionGroup } from "../functions/ModuleFunctions";
import { useFunctionTests } from "../functions/tests";
import { ExampleModePart } from "./ExampleModePart";
import { listing } from "./ModulePages";
import { ModulePart } from "./ModulePart";
import { ModuleUserPages, needKey } from "./ModuleUserPages";
import { userPagesOf } from "./menuApi";

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
  const entries = snapshot ? userPagesOf(snapshot, module.id) : [];
  const templates = (snapshot?.templates ?? []).filter((template) => template.module === module.id);
  // Les services du module, puis ceux de ses dépendances dont un de ses modèles se sert.
  const dependencyNeeds = [
    ...new Set(
      templates.flatMap((template) =>
        template.needs.filter((need) => need.includes("/")).map((need) => needKey(module.id, need)),
      ),
    ),
  ];
  const shownNeeds = [
    ...needs.map((need) => need.key),
    ...dependencyNeeds.filter((key) => !needs.some((need) => need.key === key)),
  ];
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
      {(entries.length > 0 || templates.length > 0) && snapshot ? (
        <ModulePart
          part="pages"
          title="Pages"
          description="Vos pages faites à partir de ce module, chacune avec ses onglets et leurs comptes. Ajoutez-en autant que vous voulez, avec d’autres comptes."
        >
          <ModuleUserPages
            module={module}
            modules={modules}
            snapshot={snapshot}
            entries={entries}
            services={services}
            onEdit={onEditService}
            disabled={hidden}
            loading={loading}
          />
        </ModulePart>
      ) : null}
      {shownNeeds.length > 0 || (overview === undefined && module.clients.length > 0) ? (
        <ModulePart
          part="services"
          title="Comptes"
          description="Les comptes de chaque service, créés une fois et partagés par les pages qui s’en servent."
        >
          {loading ?? (
            <div className="service-list">
              {shownNeeds.map((key) => {
                const need = overview?.needs.find((candidate) => candidate.key === key);
                if (!need || !overview) return null;
                const client = overview.clients.find((candidate) => candidate.id === need.client);
                return (
                  <ServiceBlock
                    key={need.key}
                    need={need}
                    client={client}
                    template={templateOf(modules, need.module, need.id)}
                    help={
                      modules.find((item) => item.id === need.module)?.clients.find((item) => item.id === need.id)
                        ?.help || undefined
                    }
                    controller={services}
                    onEdit={onEditService}
                    titled
                    purpose={
                      need.module !== module.id ? `Service de ${need.moduleName}, installé avec ce module.` : usedBy
                    }
                    describeInstance={
                      client && !client.simple
                        ? (instance) => usageSentence(accountUsers(snapshot, client.id, instance))
                        : undefined
                    }
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
