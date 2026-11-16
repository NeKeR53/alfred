/**
 * Un service vu depuis la fiche d’un module : son état, ses comptes et de quoi les connecter, les tester et les
 * modifier, au même endroit.
 */
import { Button, MenuItem, OverflowMenu, SelectControl, SettingRow, SettingRows, StatusBadge } from "@alfred/ui";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { type AuthType, authTypeLabel, type ClientItem, type ClientNeedItem } from "./api";
import type { ServiceEditing } from "./ServiceEditor";
import { type ClientsController, STATUS, targetKey } from "./useClients";
import "./services.css";

/** Le service (ou l’un de ses comptes) demande-t-il quelque chose à l’utilisateur ? */
export function serviceNeedsAttention(client: ClientItem | undefined): boolean {
  if (!client) return true;
  if (client.status !== "ready") return true;
  return !client.simple && client.instances.some((instance) => instance.status !== "ready");
}

/** État d’un service en mots simples, pour la note sous ses comptes. */
function statusText(client: ClientItem) {
  return STATUS[client.status].label.toLowerCase();
}

export function ServiceBlock({
  need,
  client,
  clients,
  controller,
  onEdit,
  note,
  flat = false,
  describeInstance,
}: {
  /** Besoin du module auquel ce service répond ; absent pour un service qu’aucun module n’utilise. */
  need?: ClientNeedItem;
  client: ClientItem | undefined;
  clients: ClientItem[];
  controller: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Ligne ajoutée sous l’en-tête, par exemple les modules qui utilisent le service. */
  note?: ReactNode;
  /**
   * Fiche d’un module qui n’utilise que ce service : ses comptes s’affichent directement, sans la ligne du service
   * au-dessus ; le service ne garde qu’une ligne « Réglages du service » à la fin.
   */
  flat?: boolean;
  /** Ce que sert un compte, en mots simples (la page qui l’affiche) ; sans elle, rien de technique n’est montré. */
  describeInstance?: (instance: string) => string | undefined;
}) {
  const {
    statusBadge,
    statusDetails,
    validate,
    removeInstance,
    makeDefault,
    bind,
    remove,
    test,
    connect,
    disconnect,
    testing,
  } = controller;
  const title = client?.label ?? need?.label ?? "";

  if (!client) {
    if (!need) return null;
    return (
      <div className="service-block">
        <SettingRow
          title={need.label}
          badge={
            <StatusBadge tone="warning" size="compact">
              À configurer
            </StatusBadge>
          }
          description={
            <>
              {note ? <span>{note}</span> : null}
              <span>Ce module a besoin de ce service. Indiquez son adresse et comment s’y connecter.</span>
            </>
          }
        >
          {clients.length > 0 ? (
            <SelectControl
              aria-label={`Utiliser un service existant pour ${need.label}`}
              value=""
              onChange={(event) => void bind(need, event.target.value)}
            >
              <option value="">Utiliser un service existant…</option>
              {clients.map((known) => (
                <option key={known.id} value={known.id}>
                  {known.label}
                </option>
              ))}
            </SelectControl>
          ) : null}
          <Button
            variant="primary"
            aria-label={`Configurer ${need.label}`}
            onClick={() =>
              onEdit({
                kind: "client",
                preset: {
                  id: clients.some((known) => known.id === need.id) ? undefined : need.id,
                  label: need.label,
                  baseUrl: need.baseUrl ?? "",
                  auth: { type: (need.auth ?? "none") as AuthType },
                },
              })
            }
          >
            Configurer
          </Button>
        </SettingRow>
      </div>
    );
  }

  const usedNote = note ? <span>{note}</span> : null;
  /** Menu « … » d’une ligne : les actions occasionnelles, pour garder un seul contrôle par ligne. */
  const menu = (
    label: string,
    items: Array<{ label: string; run: () => void; hidden?: boolean; disabled?: boolean }>,
  ) => (
    <OverflowMenu label={`Actions de ${label}`} size="small">
      {items
        .filter((item) => !item.hidden)
        .map((item) => (
          // L’action part dès la capture : le menu se ferme avant la remontée du clic (voir `ModulesSettings`).
          <MenuItem key={item.label} disabled={item.disabled} onClickCapture={item.run}>
            {item.label}
          </MenuItem>
        ))}
    </OverflowMenu>
  );
  const busyTesting = (key: string) =>
    testing === key ? <span className="service-detail">Test en cours…</span> : null;
  const blocked = (state: Pick<ClientItem, "status">) => state.status === "invalid" || state.status === "toValidate";

  const serviceRow = (
    <SettingRow
      title={title}
      badge={client.status === "ready" ? null : statusBadge(client)}
      description={
        <>
          {usedNote}
          {client.simple ? (
            <span>
              {client.baseUrl} · {authTypeLabel(client.auth?.type ?? "none")}
            </span>
          ) : (
            <span>
              {client.instances.length === 0
                ? "Aucun compte"
                : `${client.instances.length} compte${client.instances.length > 1 ? "s" : ""}`}
            </span>
          )}
          {client.simple ? statusDetails(client, client.id) : client.status === "invalid" ? client.problem : null}
          {client.simple ? busyTesting(client.id) : null}
        </>
      }
    >
      {client.status === "toValidate" ? (
        <Button variant="primary" aria-label={`Approuver ${client.label}`} onClick={() => void validate(client)}>
          Approuver
        </Button>
      ) : null}
      {client.simple && client.auth?.type === "oauth2" && client.status === "toConnect" ? (
        <Button aria-label={`Se connecter à ${client.label}`} onClick={() => void connect({ client })}>
          Se connecter
        </Button>
      ) : null}
      {menu(client.label, [
        {
          label: "Tester",
          hidden: !client.simple,
          disabled: blocked(client) || testing !== undefined,
          run: () => void test({ client }),
        },
        {
          label: "Se déconnecter",
          hidden: !client.simple || !client.connected,
          run: () => void disconnect({ client }),
        },
        { label: "Modifier le service…", run: () => onEdit({ kind: "client", client }) },
        { label: "Supprimer le service…", hidden: Boolean(need), run: () => void remove(client) },
      ])}
    </SettingRow>
  );

  const list = (
    <SettingRows label={`Comptes ${client.label}`}>
      {flat && !client.simple ? null : serviceRow}
      {client.simple
        ? null
        : client.instances.map((instance) => {
            const label = `${client.label} — ${instance.label}`;
            const key = targetKey(client.id, instance.id);
            const target = { client, instance };
            return (
              <div key={instance.id} className={flat ? undefined : "setting-row--nested"}>
                <SettingRow
                  title={instance.label}
                  badge={instance.status === "ready" ? null : statusBadge(instance)}
                  description={
                    <>
                      {describeInstance?.(instance.id) ? <span>{describeInstance(instance.id)}</span> : null}
                      {instance.status === "ready" && !describeInstance?.(instance.id) ? <span>Prêt</span> : null}
                      {statusDetails(instance, key)}
                      {busyTesting(key)}
                    </>
                  }
                >
                  {instance.authType === "oauth2" && instance.status === "toConnect" ? (
                    <Button aria-label={`Se connecter à ${label}`} onClick={() => void connect(target)}>
                      Se connecter
                    </Button>
                  ) : null}
                  {menu(label, [
                    {
                      label: "Tester",
                      disabled: blocked(instance) || testing !== undefined,
                      run: () => void test(target),
                    },
                    {
                      label: "Se déconnecter",
                      hidden: instance.authType !== "oauth2" || !instance.connected,
                      run: () => void disconnect(target),
                    },
                    {
                      label: "Utiliser par défaut",
                      hidden: instance.default,
                      run: () => void makeDefault(client, instance),
                    },
                    { label: "Modifier le compte…", run: () => onEdit({ kind: "instance", client, instance }) },
                    { label: "Supprimer le compte…", run: () => void removeInstance(client, instance) },
                  ])}
                </SettingRow>
              </div>
            );
          })}
    </SettingRows>
  );

  const others = need ? clients.filter((known) => known.id !== client.id) : [];
  return (
    <div className="service-block">
      {list}
      {/* Les actions sous la liste : un autre niveau que les comptes, pour ne pas s’y confondre. */}
      <div className="service-block__footer">
        {client.simple ? null : (
          <Button
            aria-label={`Ajouter un compte à ${client.label}`}
            disabled={client.status === "invalid" && client.methods.length === 0}
            onClick={() => onEdit({ kind: "instance", client })}
          >
            <Plus size={14} aria-hidden="true" />
            Ajouter un compte
          </Button>
        )}
        <span className="service-block__spacer" />
        {flat && !client.simple ? (
          <>
            {client.status === "toValidate" ? (
              <Button variant="primary" aria-label={`Approuver ${client.label}`} onClick={() => void validate(client)}>
                Approuver
              </Button>
            ) : null}
            <Button aria-label={`Modifier ${client.label}`} onClick={() => onEdit({ kind: "client", client })}>
              Paramètres du service…
            </Button>
          </>
        ) : null}
        {need && others.length > 0 ? (
          <OverflowMenu label={`Service utilisé pour ${need.label} par le module ${need.moduleName}`} size="small">
            {others.map((known) => (
              <MenuItem key={known.id} onClickCapture={() => void bind(need, known.id)}>
                Utiliser « {known.label} » à la place
              </MenuItem>
            ))}
            {need.binding ? (
              <MenuItem onClickCapture={() => void bind(need, "")}>Revenir au service du même nom</MenuItem>
            ) : null}
          </OverflowMenu>
        ) : null}
      </div>
      {flat && client.status !== "ready" ? (
        <p className="service-block__note service-detail--warning">
          {client.status === "invalid" && client.problem ? client.problem : `Service : ${statusText(client)}`}
        </p>
      ) : null}
    </div>
  );
}
