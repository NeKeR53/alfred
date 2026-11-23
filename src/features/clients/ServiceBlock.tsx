/**
 * Un service vu depuis la fiche d’un module, en une section des Réglages : vos comptes chez lui (une ligne chacun),
 * et de quoi les ajouter, les connecter et les tester. La façon de s’y connecter appartient au module (l’agent la décrit) : elle ne se règle pas ici.
 */
import { CheckCircle2, FlaskConical, KeyRound, LogIn, Plus } from "lucide-react";
import type { Action, SettingsSection } from "socle-ui";
import { notify } from "../../shell/notifications";
import { errorMessage } from "../vault/api";
import type { ClientConfig, ClientInstanceItem, ClientItem, ClientNeedItem } from "./api";
import { createFromTemplate, templateNeedsAccount } from "./fromTemplate";
import type { ServiceEditing } from "./ServiceEditor";
import { type ClientsController, targetKey } from "./useClients";

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

export interface ServiceSectionOptions {
  /** Besoin du module auquel ce service répond. */
  need: ClientNeedItem;
  client: ClientItem | undefined;
  /** Modèle du service décrit par le module, pour le créer sans rien demander. */
  template?: Partial<ClientConfig>;
  /** Aide du module : où trouver la clé, quel compte utiliser. */
  help?: string;
  controller: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Ce que sert un compte, en mots simples (la page qui l’affiche). */
  describeInstance?: (instance: string) => string | undefined;
  /** À quoi sert le service dans le module, sous son nom. */
  purpose?: string;
}

const icon16 = { size: 16, "aria-hidden": true } as const;

/** Section d’un service dans la fiche d’un module : son nom en titre, une ligne par compte. */
export function serviceSection({
  need,
  client,
  template,
  help,
  controller,
  onEdit,
  describeInstance,
  purpose,
}: ServiceSectionOptions): SettingsSection {
  const { statusTag, statusDetails, validate, removeInstance, makeDefault, test, connect, disconnect, testing } =
    controller;
  const label = client?.label ?? need.label;
  const id = `service:${need.key}`;

  /** Ajoute un compte ; crée d’abord le service d’après le modèle du module s’il n’existe pas encore. */
  const addAccount = async () => {
    if (client) {
      onEdit({ kind: "account", client, help });
      return;
    }
    if (!template) return;
    try {
      const saved = await createFromTemplate(template, need, controller);
      if (templateNeedsAccount(template)) onEdit({ kind: "account", client: saved, help });
    } catch (failure) {
      notify({ title: `${need.label} n’a pas pu être ajouté`, description: errorMessage(failure), tone: "error" });
    }
  };

  if (!client) {
    return {
      id,
      title: label,
      description: purpose,
      actions: template
        ? [
            {
              id: "add",
              label: templateNeedsAccount(template) ? `Ajouter votre compte ${need.label}` : `Activer ${need.label}`,
              primary: true,
              onPress: addAccount,
            },
          ]
        : undefined,
      settings: [
        {
          type: "item",
          id: "missing",
          label: need.label,
          description: template ? (help ?? "Ajoutez votre compte pour que le module s’y connecte.") : UNDESCRIBED,
          tags: [{ label: "À configurer", tone: "pending" }],
        },
      ],
    };
  }

  const blocked = (state: Pick<ClientItem, "status">) => state.status === "invalid" || state.status === "toValidate";
  const count = client.simple
    ? undefined
    : client.instances.length === 0
      ? "Aucun compte"
      : `${client.instances.length} compte${client.instances.length > 1 ? "s" : ""}`;

  return {
    id,
    title: label,
    description: [count, purpose].filter(Boolean).join(" · ") || undefined,
    actions: client.simple
      ? undefined
      : [
          {
            id: "add",
            label: `Ajouter un compte à ${label}`,
            // Sans compte, l’action principale ; ensuite, un bouton-icône de la section.
            primary: client.instances.length === 0,
            icon: client.instances.length === 0 ? undefined : <Plus {...icon16} />,
            isDisabled: client.methods.length === 0,
            onPress: addAccount,
          },
        ],
    emptyMessage:
      client.status === "invalid" && client.instances.length === 0 ? (client.problem ?? UNDESCRIBED) : undefined,
    settings: client.instances.map((instance) => {
      const name = client.simple ? label : `${label} — ${instance.label}`;
      const key = client.simple ? client.id : targetKey(client.id, instance.id);
      const target = { client, instance: client.simple ? undefined : instance };
      const page = describeInstance?.(instance.id);
      const actions: Action[] = [];
      if (instance.status === "toValidate")
        actions.push({
          id: "approve",
          label: `Approuver ${name}`,
          icon: <CheckCircle2 {...icon16} />,
          onPress: () => validate(client),
        });
      if (instance.status === "missingSecret")
        actions.push({
          id: "secret",
          label: `Saisir les identifiants de ${name}`,
          icon: <KeyRound {...icon16} />,
          onPress: () => onEdit({ kind: "account", client, instance, help }),
        });
      if (instance.authType === "oauth2" && instance.status === "toConnect")
        actions.push({
          id: "connect",
          label: `Se connecter à ${name}`,
          icon: <LogIn {...icon16} />,
          onPress: () => connect(target),
        });
      actions.push({
        id: "test",
        label: `Tester ${name}`,
        icon: <FlaskConical {...icon16} />,
        isDisabled: blocked(instance) || testing !== undefined,
        onPress: () => test(target),
      });
      if (instance.authType === "oauth2" && instance.connected)
        actions.push({ id: "disconnect", label: "Se déconnecter", onPress: () => disconnect(target) });
      if (!client.simple && !instance.default)
        actions.push({ id: "default", label: "Utiliser par défaut", onPress: () => makeDefault(client, instance) });
      if (!(instance.authType === "none" && (client.simple || Boolean(client.baseUrl))))
        actions.push({
          id: "edit",
          label: "Modifier le compte…",
          onPress: () => onEdit({ kind: "account", client, instance, help }),
        });
      if (!client.simple)
        actions.push({ id: "remove", label: "Supprimer le compte…", onPress: () => removeInstance(client, instance) });
      return {
        type: "item" as const,
        id: instance.id,
        label: accountTitle(client, instance),
        description:
          [page, instance.status === "ready" && !page ? "Prêt" : null, ...statusDetails(instance, key)]
            .filter(Boolean)
            .join(" · ") || undefined,
        tags: instance.status === "ready" ? undefined : [statusTag(instance)],
        actions,
      };
    }),
  };
}
