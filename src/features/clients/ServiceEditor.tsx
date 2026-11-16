/** Formulaire d’un service ou de l’un de ses comptes, ouvert depuis les Réglages (fiche d’un module). */
import type { ClientConfig, ClientInstanceItem, ClientItem } from "./api";
import { ClientEditor } from "./ClientEditor";
import { InstanceEditor } from "./InstanceEditor";

/** Formulaire ouvert : un service (création, modification) ou l’un de ses comptes. */
export type ServiceEditing =
  | { kind: "client"; client?: ClientItem; preset?: Partial<ClientConfig> }
  | { kind: "instance"; client: ClientItem; instance?: ClientInstanceItem };

/** Formulaire d’un service ou d’un compte ; un nouveau service à plusieurs comptes enchaîne sur son premier compte. */
export function ServiceEditor({
  editing,
  redirectUri,
  onEdit,
  onDone,
}: {
  editing: ServiceEditing;
  redirectUri: string | null;
  onEdit: (next: ServiceEditing) => void;
  onDone: () => void;
}) {
  if (editing.kind === "instance") {
    return (
      <InstanceEditor
        key={`${editing.client.id}:${editing.instance?.id ?? "nouvelle"}`}
        client={editing.client}
        initial={editing.instance}
        redirectUri={redirectUri}
        onCancel={onDone}
        onSaved={onDone}
      />
    );
  }
  return (
    <ClientEditor
      // Une clé par service : le formulaire repart de zéro à chaque ouverture.
      key={editing.client?.id ?? `new:${editing.preset?.id ?? ""}`}
      initial={editing.client}
      preset={editing.preset}
      redirectUri={redirectUri}
      onCancel={onDone}
      onSaved={(saved) => {
        // Un nouveau service à plusieurs comptes n’a encore rien à appeler : on enchaîne sur son premier compte.
        if (!editing.client && !saved.simple) onEdit({ kind: "instance", client: saved, instance: saved.instances[0] });
        else onDone();
      }}
    />
  );
}
