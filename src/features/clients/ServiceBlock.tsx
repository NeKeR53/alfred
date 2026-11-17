/**
 * Un service vu depuis la fiche d’un module : vos comptes chez lui, et de quoi les ajouter, les connecter et les
 * tester. La façon de s’y connecter appartient au module (l’agent la décrit) : elle ne se règle pas ici.
 */
import { Button, MenuItem, OverflowMenu, SettingRow, SettingRows, StatusBadge } from "@alfred/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { notify } from "../../shell/notifications";
import { errorMessage } from "../vault/api";
import type { ClientConfig, ClientInstanceItem, ClientItem, ClientNeedItem } from "./api";
import { createFromTemplate, templateNeedsAccount } from "./fromTemplate";
import type { ServiceEditing } from "./ServiceEditor";
import { type ClientsController, targetKey } from "./useClients";
import "./services.css";

/** Le service (ou l’un de ses comptes) demande-t-il quelque chose à l’utilisateur ? */
export function serviceNeedsAttention(client: ClientItem | undefined): boolean {
  if (!client) return true;
  if (client.status !== "ready") return true;
  return !client.simple && client.instances.some((instance) => instance.status !== "ready");
}

/** Message quand le module ne dit pas comment se connecter : c’est à l’agent de le compléter, pas à l’utilisateur. */
export const UNDESCRIBED =
  "Le module ne dit pas encore comment se connecter à ce service. Demandez à Alfred de le compléter.";

/** Nom d’un compte dans la liste : celui d’un service à un seul compte n’en a pas besoin. */
export function accountTitle(client: ClientItem, instance: ClientInstanceItem): string {
  if (client.simple) return instance.authType === "none" ? "Connexion" : "Votre compte";
  return instance.label;
}

export function ServiceBlock({
  need,
  client,
  template,
  help,
  controller,
  onEdit,
  note,
  describeInstance,
  titled = false,
}: {
  /** Besoin du module auquel ce service répond. */
  need: ClientNeedItem;
  client: ClientItem | undefined;
  /** Modèle du service décrit par le module, pour le créer sans rien demander. */
  template?: Partial<ClientConfig>;
  /** Aide du module : où trouver la clé, quel compte utiliser. */
  help?: string;
  controller: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Ligne ajoutée sous l’en-tête. */
  note?: ReactNode;
  /** Ce que sert un compte, en mots simples (la page qui l’affiche). */
  describeInstance?: (instance: string) => string | undefined;
  /** Le module a plusieurs services : chacun porte son nom au-dessus de ses comptes. */
  titled?: boolean;
}) {
  const { statusBadge, statusDetails, validate, removeInstance, makeDefault, test, connect, disconnect, testing } =
    controller;
  const [creating, setCreating] = useState(false);
  const label = client?.label ?? need.label;

  /** Ajoute un compte ; crée d’abord le service d’après le modèle du module s’il n’existe pas encore. */
  const addAccount = async () => {
    if (client) {
      onEdit({ kind: "account", client, help });
      return;
    }
    if (!template) return;
    setCreating(true);
    try {
      const saved = await createFromTemplate(template, need, controller);
      if (templateNeedsAccount(template)) onEdit({ kind: "account", client: saved, help });
    } catch (failure) {
      notify({ title: `${need.label} n’a pas pu être ajouté`, description: errorMessage(failure), tone: "error" });
    } finally {
      setCreating(false);
    }
  };

  const head = titled ? (
    <div className="service-block__head">
      <h4 className="service-block__title">{label}</h4>
      {client && !client.simple ? (
        <span className="service-block__note">
          {client.instances.length === 0
            ? "Aucun compte"
            : `${client.instances.length} compte${client.instances.length > 1 ? "s" : ""}`}
        </span>
      ) : null}
    </div>
  ) : null;

  if (!client) {
    return (
      <div className="service-block">
        {head}
        <SettingRows label={`Comptes ${label}`}>
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
                <span>
                  {template ? (help ?? "Ajoutez votre compte pour que le module s’y connecte.") : UNDESCRIBED}
                </span>
              </>
            }
          >
            {template ? (
              <Button
                variant="primary"
                loading={creating}
                aria-label={`Ajouter votre compte ${need.label}`}
                onClick={() => void addAccount()}
              >
                {templateNeedsAccount(template) ? "Ajouter votre compte" : "Activer"}
              </Button>
            ) : null}
          </SettingRow>
        </SettingRows>
      </div>
    );
  }

  const blocked = (state: Pick<ClientItem, "status">) => state.status === "invalid" || state.status === "toValidate";
  const busyTesting = (key: string) =>
    testing === key ? <span className="service-detail">Test en cours…</span> : null;

  return (
    <div className="service-block">
      {head}
      <SettingRows label={`Comptes ${label}`}>
        {client.instances.map((instance) => {
          const title = accountTitle(client, instance);
          const name = client.simple ? label : `${label} — ${instance.label}`;
          const key = client.simple ? client.id : targetKey(client.id, instance.id);
          const target = { client, instance: client.simple ? undefined : instance };
          const page = describeInstance?.(instance.id);
          return (
            <SettingRow
              key={instance.id}
              title={client.simple && !titled ? `${label} — ${title}` : title}
              badge={instance.status === "ready" ? null : statusBadge(instance)}
              description={
                <>
                  {note && client.simple ? <span>{note}</span> : null}
                  {page ? <span>{page}</span> : null}
                  {instance.status === "ready" && !page ? <span>Prêt</span> : null}
                  {statusDetails(instance, key)}
                  {busyTesting(key)}
                </>
              }
            >
              {instance.status === "toValidate" ? (
                <Button variant="primary" aria-label={`Approuver ${name}`} onClick={() => void validate(client)}>
                  Approuver
                </Button>
              ) : null}
              {instance.status === "missingSecret" ? (
                <Button
                  variant="primary"
                  aria-label={`Saisir les identifiants de ${name}`}
                  onClick={() => onEdit({ kind: "account", client, instance, help })}
                >
                  Saisir vos identifiants…
                </Button>
              ) : null}
              {instance.authType === "oauth2" && instance.status === "toConnect" ? (
                <Button aria-label={`Se connecter à ${name}`} onClick={() => void connect(target)}>
                  Se connecter
                </Button>
              ) : null}
              <OverflowMenu label={`Actions de ${name}`} size="small">
                {[
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
                    hidden: client.simple || instance.default,
                    run: () => void makeDefault(client, instance),
                  },
                  {
                    label: "Modifier le compte…",
                    hidden: instance.authType === "none" && (client.simple || Boolean(client.baseUrl)),
                    run: () => onEdit({ kind: "account", client, instance, help }),
                  },
                  {
                    label: "Supprimer le compte…",
                    hidden: client.simple,
                    run: () => void removeInstance(client, instance),
                  },
                ]
                  .filter((item) => !item.hidden)
                  .map((item) => (
                    // L’action part dès la capture : le menu se ferme avant la remontée du clic (voir `ModulesSettings`).
                    <MenuItem key={item.label} disabled={item.disabled} onClickCapture={item.run}>
                      {item.label}
                    </MenuItem>
                  ))}
              </OverflowMenu>
            </SettingRow>
          );
        })}
      </SettingRows>
      {client.status === "invalid" && client.instances.length === 0 ? (
        <p className="service-block__note service-detail--warning">{client.problem ?? UNDESCRIBED}</p>
      ) : null}
      {client.simple ? null : (
        <div className="service-block__footer">
          <Button
            variant={client.instances.length === 0 ? "primary" : "secondary"}
            aria-label={`Ajouter un compte à ${label}`}
            disabled={client.methods.length === 0}
            onClick={() => void addAccount()}
          >
            <Plus size={14} aria-hidden="true" />
            {client.instances.length === 0 ? "Ajouter votre compte" : "Ajouter un compte"}
          </Button>
        </div>
      )}
    </div>
  );
}
