/** Formulaire d’un compte, ouvert depuis la fiche d’un module ou son parcours de configuration. */

import { useState } from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage } from "../vault/api";
import { AccountEditor } from "./AccountEditor";
import { type ClientInstanceItem, type ClientItem, setAccountPages } from "./api";

/**
 * Compte à ajouter (sans `instance`) ou à modifier. `page` : le compte s’ajoute depuis une page par compte
 * (`module/page`), qu’il reçoit dès sa création, sans autre choix à faire.
 */
export type ServiceEditing = {
  kind: "account";
  client: ClientItem;
  instance?: ClientInstanceItem;
  help?: string;
  page?: string;
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
  // Un compte tout juste ajouté reste ouvert, pour lui ajouter des pages, quand le module en a pour ses comptes.
  const [created, setCreated] = useState<{ client: ClientItem; instance: ClientInstanceItem }>();
  const hasAccountPages = useShell((state) =>
    Boolean(state.snapshot?.accountPages?.some((page) => page.client === editing.client.id)),
  );
  const client = created?.client ?? editing.client;
  const instance = created?.instance ?? editing.instance;
  return (
    <AccountEditor
      // Une clé par compte : le formulaire repart de zéro à chaque ouverture.
      key={`${client.id}:${instance?.id ?? "nouveau"}`}
      client={client}
      initial={instance}
      help={editing.help}
      redirectUri={redirectUri}
      created={Boolean(created)}
      onCancel={onDone}
      onSaved={({ saved, instance: id, created: isNew }) => {
        const added = saved.instances.find((candidate) => candidate.id === id);
        if (isNew && added && editing.page) {
          // Ajouté depuis une page : il la reçoit tout de suite, la page s’affiche pour lui dans le menu.
          const page = editing.page;
          // Alfred relit l’espace de lui-même (space:changed) : le menu montre la page pour le compte.
          void setAccountPages(saved.id, id, [page])
            .catch((failure: unknown) =>
              notify({
                title: "La page n’a pas été ajoutée au compte",
                description: errorMessage(failure),
                tone: "error",
              }),
            )
            .finally(onDone);
        } else if (isNew && added && hasAccountPages) setCreated({ client: saved, instance: added });
        else onDone();
      }}
    />
  );
}
