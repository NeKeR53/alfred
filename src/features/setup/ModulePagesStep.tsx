/**
 * Étape « Vos pages » de l’onboarding : chaque modèle du module y est déjà ajouté une fois comme page du menu. Comme
 * dans la fiche du module, l’utilisateur en retire, en ajoute (le même modèle plusieurs fois, avec d’autres comptes),
 * les renomme et choisit, page par page, le compte de chacune.
 */
import { Text } from "@alfred/ui";
import type { ModuleSummary, ResolvedSection, Snapshot } from "../../lib/types";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { ModuleUserPages } from "../modules/ModuleUserPages";

export function ModulePagesStep({
  module,
  modules,
  snapshot,
  entries,
  services,
  onEdit,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  snapshot: Snapshot;
  entries: ResolvedSection[];
  services: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
}) {
  return (
    <div className="setup-flow__body">
      <h3>Vos pages</h3>
      <Text>
        {entries.length > 1
          ? `${module.name} a ajouté ${entries.length} pages à votre menu. Gardez celles qui vous servent, renommez-les et choisissez le compte de chacune ; ajoutez-en d’autres avec d’autres comptes.`
          : `${module.name} a ajouté une page à votre menu. Renommez-la et choisissez son compte ; ajoutez-en d’autres avec d’autres comptes.`}
      </Text>
      <ModuleUserPages
        module={module}
        modules={modules}
        snapshot={snapshot}
        entries={entries}
        services={services}
        onEdit={onEdit}
        disabled={false}
      />
    </div>
  );
}
