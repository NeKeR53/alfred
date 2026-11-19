/**
 * État et actions des services (clients) de l’espace : lecture, test, connexion OAuth, validation, comptes
 * (instances). Partagé par la liste complète des services et par la fiche de chaque module.
 */
import { Button, KeyValueList, Stack, StatusBadge, Text, useConfirm } from "@alfred/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { onNativeEvent, openExternal } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage } from "../vault/api";
import {
  authTypeLabel,
  bindNeed,
  type ClientInstanceItem,
  type ClientItem,
  type ClientNeedItem,
  type ClientsOverview,
  type ClientTestResult,
  connectClient,
  deleteClient,
  deleteInstance,
  disconnectClient,
  listClients,
  makeDefaultInstance,
  testClient,
  validateClient,
} from "./api";

/** États d’un service ou d’un compte, en mots simples. */
export const STATUS: Record<ClientItem["status"], { label: string; tone: "success" | "warning" | "danger" }> = {
  ready: { label: "Prêt", tone: "success" },
  toValidate: { label: "À approuver", tone: "warning" },
  noInstance: { label: "Aucun compte", tone: "warning" },
  missingSecret: { label: "Mot de passe ou clé manquant", tone: "warning" },
  toConnect: { label: "À connecter", tone: "warning" },
  invalid: { label: "Mal configuré", tone: "danger" },
};

/** Changement annoncé par le backend : retour d’une connexion OAuth, ou simple modification d’un client. */
interface ClientsChange {
  client?: string;
  instance?: string;
  connected?: boolean;
  error?: string;
}

/** Ce qu’on teste, connecte ou déconnecte : un service à une seule adresse, ou un compte d’un service. */
export interface Target {
  client: ClientItem;
  /** Absente pour un service à une seule adresse : son compte par défaut. */
  instance?: ClientInstanceItem;
}

export const targetKey = (client: string, instance?: string) => (instance ? `${client}#${instance}` : client);
export const targetLabel = ({ client, instance }: Target) =>
  instance ? `${client.label} — ${instance.label}` : client.label;

/** L’instance `default` d’un client à une seule adresse se suit sous le seul identifiant du client. */
function connectingKey(change: ClientsChange, clients: ClientItem[] | undefined) {
  const client = clients?.find((known) => known.id === change.client);
  return client?.simple || !change.instance ? (change.client ?? "") : targetKey(change.client ?? "", change.instance);
}

export function useClients() {
  const [overview, setOverview] = useState<ClientsOverview>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string>();
  const [tests, setTests] = useState<Record<string, ClientTestResult>>({});
  /** Cible dont la connexion OAuth attend le retour du navigateur. */
  const [connecting, setConnecting] = useState<string>();
  const connectingRef = useRef<string | undefined>(undefined);
  const overviewRef = useRef<ClientsOverview | undefined>(undefined);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listClients();
      overviewRef.current = next;
      setOverview(next);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const stopClients = onNativeEvent("clients:changed", (payload) => {
      const change = (payload ?? {}) as ClientsChange;
      const key = change.client ? connectingKey(change, overviewRef.current?.clients) : undefined;
      if (key && key === connectingRef.current && typeof change.connected === "boolean") {
        const label =
          overviewRef.current?.clients.find((client) => client.id === change.client)?.label ?? change.client;
        connectingRef.current = undefined;
        setConnecting(undefined);
        if (change.connected) notify({ title: `${label} est connecté`, tone: "success" });
        else if (change.error)
          notify({ title: `La connexion de ${label} a échoué`, description: change.error, tone: "error" });
      }
      void load();
    });
    // Un secret saisi dans le coffre change l’état « Mot de passe ou clé manquant » d’un service.
    const stopVault = onNativeEvent("vault:changed", () => void load());
    return () => {
      stopClients();
      stopVault();
    };
  }, [load]);

  const test = async (target: Target) => {
    const key = targetKey(target.client.id, target.instance?.id);
    const label = targetLabel(target);
    setTesting(key);
    try {
      const result = await testClient(target.client.id, target.instance?.id);
      setTests((current) => ({ ...current, [key]: result }));
      notify({
        title: result.ok ? `${label} : le service répond` : `${label} : le test a échoué`,
        description: `${result.message} ${result.durationMs} ms.`,
        tone: result.ok ? "success" : "error",
      });
    } catch (failure) {
      notify({ title: `${label} : le test a échoué`, description: errorMessage(failure), tone: "error" });
    } finally {
      setTesting(undefined);
    }
  };

  const connect = async (target: Target) => {
    const key = targetKey(target.client.id, target.instance?.id);
    try {
      const { authorizationUrl } = await connectClient(target.client.id, target.instance?.id);
      connectingRef.current = key;
      setConnecting(key);
      await openExternal(authorizationUrl);
    } catch (failure) {
      connectingRef.current = undefined;
      setConnecting(undefined);
      notify({
        title: `La connexion de ${targetLabel(target)} n’a pas pu démarrer`,
        description: errorMessage(failure),
        tone: "error",
      });
    }
  };

  const disconnect = async (target: Target) => {
    const label = targetLabel(target);
    try {
      await disconnectClient(target.client.id, target.instance?.id);
      notify({ title: `${label} est déconnecté`, tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: `${label} n’a pas été déconnecté`, description: errorMessage(failure), tone: "error" });
    }
  };

  const validate = async (client: ClientItem) => {
    const validation = client.validation;
    if (!validation) return;
    const shown = (change: { field: string }, value: string | null) =>
      value === null ? "aucune valeur" : change.field === "authType" ? authTypeLabel(value) : value;
    // L’utilisateur approuve des valeurs qu’il a sous les yeux : ce sont elles qui décident où part le secret.
    const confirmed = await confirm({
      title: `Approuver le service « ${client.label} » ?`,
      message: (
        <Stack gap="md">
          <Text tone="muted">
            {validation.everValidated
              ? "Ce service a été modifié hors des Réglages. Une fois approuvé, Alfred enverra son mot de passe ou sa clé selon ces nouvelles valeurs."
              : "Ce service a été créé hors des Réglages. Une fois approuvé, Alfred enverra son mot de passe ou sa clé aux adresses ci-dessous."}
          </Text>
          <KeyValueList
            items={validation.changes.map((change) => ({
              label: change.instanceLabel ? `${change.instanceLabel} · ${change.label}` : change.label,
              value: validation.everValidated ? (
                <Stack gap="none">
                  <Text size="meta" tone="muted">
                    Avant : {shown(change, change.before)}
                  </Text>
                  <Text weight="medium">Maintenant : {shown(change, change.after)}</Text>
                </Stack>
              ) : (
                shown(change, change.after)
              ),
            }))}
          />
        </Stack>
      ),
      confirmLabel: "Approuver",
    });
    if (!confirmed) return;
    try {
      await validateClient(client);
      notify({ title: `${client.label} est approuvé`, tone: "success" });
    } catch (failure) {
      notify({ title: `${client.label} n’a pas été approuvé`, description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const remove = async (client: ClientItem) => {
    const confirmed = await confirm({
      title: `Supprimer le service « ${client.label} » ?`,
      message:
        client.usedBy.length > 0
          ? "Les modules qui l’utilisent devront être reliés à un autre service. Le mot de passe ou la clé est conservé."
          : "Les pages qui l’appellent ne pourront plus joindre ce service. Le mot de passe ou la clé est conservé.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteClient(client.id);
      notify({ title: "Service supprimé", tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: "Le service n’a pas été supprimé", description: errorMessage(failure), tone: "error" });
    }
  };

  const removeInstance = async (client: ClientItem, instance: ClientInstanceItem) => {
    const confirmed = await confirm({
      title: `Supprimer le compte « ${instance.label} » de ${client.label} ?`,
      message: instance.default
        ? "C’est le compte par défaut : les pages qui ne nomment pas de compte utiliseront le suivant. Le mot de passe ou la clé est conservé."
        : "Les pages qui le nomment ne pourront plus le joindre. Le mot de passe ou la clé est conservé.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteInstance(client.id, instance.id);
      notify({ title: "Compte supprimé", tone: "success" });
    } catch (failure) {
      notify({ title: "Le compte n’a pas été supprimé", description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const makeDefault = async (client: ClientItem, instance: ClientInstanceItem) => {
    try {
      await makeDefaultInstance(client.id, instance.id);
      notify({ title: `${instance.label} est le compte par défaut de ${client.label}`, tone: "success" });
    } catch (failure) {
      notify({ title: "Le compte par défaut n’a pas changé", description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const bind = async (need: ClientNeedItem, client: string) => {
    try {
      await bindNeed(need.key, client || null);
      await load();
    } catch (failure) {
      notify({ title: "Le service n’a pas été relié", description: errorMessage(failure), tone: "error" });
      // La liste est relue : le choix affiché revient à ce qui est réellement enregistré.
      await load();
    }
  };

  /** Pastille d’état d’un service ou d’un compte, à côté de son nom. */
  const statusBadge = (item: Pick<ClientItem, "status" | "problem">) => {
    const status = STATUS[item.status];
    return (
      <StatusBadge tone={status.tone} size="compact" title={item.problem ?? undefined}>
        {status.label}
      </StatusBadge>
    );
  };

  /** Ce qui explique l’état (problème, accord attendu, navigateur, dernier test), en lignes grises. */
  const statusDetails = (item: Pick<ClientItem, "status" | "problem" | "validation">, key: string) => {
    const tested = tests[key];
    const lines: Array<{ text: string; tone?: "danger" | "warning" | "success" }> = [];
    if (item.problem) lines.push({ text: item.problem, tone: "danger" });
    if (item.status === "toValidate")
      lines.push({
        text: `${item.validation?.everValidated ? "Modifié" : "Créé"} hors des Réglages : rien n’est envoyé avant votre accord.`,
        tone: "warning",
      });
    if (connecting === key) lines.push({ text: "En attente du navigateur…" });
    if (tested)
      lines.push({
        text: `Dernier test : ${tested.status ?? "sans réponse"} · ${tested.durationMs} ms`,
        tone: tested.ok ? "success" : "danger",
      });
    return lines.map((line) => (
      <span key={line.text} className={`service-detail${line.tone ? ` service-detail--${line.tone}` : ""}`}>
        {line.text}
      </span>
    ));
  };

  /** État d’un service ou d’un compte, avec ce qui l’explique et le dernier test. */
  const statusCell = (item: Pick<ClientItem, "status" | "problem" | "validation">, key: string, showsTest: boolean) => {
    const status = STATUS[item.status];
    const tested = showsTest ? tests[key] : undefined;
    return (
      <Stack gap="xs">
        <span>
          <StatusBadge tone={status.tone} size="compact" title={item.problem ?? undefined}>
            {status.label}
          </StatusBadge>
        </span>
        {item.problem ? (
          <Text size="meta" tone="danger">
            {item.problem}
          </Text>
        ) : null}
        {item.status === "toValidate" ? (
          <Text size="meta" tone="warning">
            {item.validation?.everValidated ? "Modifié" : "Créé"} hors des Réglages : rien n’est envoyé avant votre
            accord.
          </Text>
        ) : null}
        {connecting === key ? (
          <Text size="meta" tone="muted">
            En attente du navigateur…
          </Text>
        ) : null}
        {tested ? (
          <Text size="meta" tone={tested.ok ? "success" : "danger"}>
            Dernier test : {tested.status ?? "sans réponse"} · {tested.durationMs} ms
          </Text>
        ) : null}
      </Stack>
    );
  };

  /** Connexion et test d’un service à une seule adresse, ou d’un compte. */
  const targetActions = (target: Target, state: Pick<ClientItem, "status" | "connected">, oauth: boolean) => {
    const key = targetKey(target.client.id, target.instance?.id);
    const label = targetLabel(target);
    return (
      <>
        {oauth && state.status === "toConnect" ? (
          <Button variant="primary" aria-label={`Se connecter à ${label}`} onClick={() => void connect(target)}>
            Se connecter
          </Button>
        ) : null}
        {oauth && state.connected ? (
          <Button variant="secondary" aria-label={`Se déconnecter de ${label}`} onClick={() => void disconnect(target)}>
            Se déconnecter
          </Button>
        ) : null}
        <Button
          variant="secondary"
          aria-label={`Tester ${label}`}
          loading={testing === key}
          loadingLabel="Test…"
          disabled={
            state.status === "invalid" || state.status === "toValidate" || (testing !== undefined && testing !== key)
          }
          onClick={() => void test(target)}
        >
          Tester
        </Button>
      </>
    );
  };

  return {
    overview,
    error,
    loading,
    load,
    test,
    connect,
    disconnect,
    testing,
    validate,
    remove,
    removeInstance,
    makeDefault,
    bind,
    statusCell,
    statusBadge,
    statusDetails,
    targetActions,
    confirmDialog,
  };
}

export type ClientsController = ReturnType<typeof useClients>;
