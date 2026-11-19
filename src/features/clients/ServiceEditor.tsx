/** Formulaire d’un compte, ouvert depuis la fiche d’un module ou son parcours de configuration. */

import { notify } from "../../shell/notifications";
import { userPages } from "../modules/menuApi";
import { errorMessage } from "../vault/api";
import { AccountEditor } from "./AccountEditor";
import type { ClientInstanceItem, ClientItem } from "./api";

/**
 * Compte à ajouter (sans `instance`) ou à modifier. `assign` : le compte s’ajoute depuis un onglet (« Nouveau
 * compte… ») ; il devient, dès sa création, le compte de cet onglet pour ce besoin.
 */
export type ServiceEditing = {
  kind: "account";
  client: ClientItem;
  instance?: ClientInstanceItem;
  help?: string;
  assign?: { tab: string; need: string; accounts: Record<string, string> };
};

export function ServiceEditor({
  editing,
  redirectUri,
  onDone,
}: {
  editing: ServiceEditing;
  redirectUri: string | null;
  onDone: () => void;
}) {
  const { client, instance } = editing;
  return (
    <AccountEditor
      // Une clé par compte : le formulaire repart de zéro à chaque ouverture.
      key={`${client.id}:${instance?.id ?? "nouveau"}`}
      client={client}
      initial={instance}
      help={editing.help}
      redirectUri={redirectUri}
      created={false}
      onCancel={onDone}
      onSaved={({ saved, instance: id, created: isNew }) => {
        const added = saved.instances.find((candidate) => candidate.id === id);
        const assign = editing.assign;
        if (isNew && added && assign) {
          // Ajouté depuis un onglet : il en devient le compte, et l’onglet le montre aussitôt.
          void userPages
            .configure(assign.tab, { accounts: { ...assign.accounts, [assign.need]: id } })
            .catch((failure: unknown) =>
              notify({
                title: "Le compte n’a pas été choisi pour la page",
                description: errorMessage(failure),
                tone: "error",
              }),
            )
            .finally(onDone);
        } else onDone();
      }}
    />
  );
}
