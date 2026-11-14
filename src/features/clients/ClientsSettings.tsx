import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  IconButton,
  KeyValueList,
  LoadingSkeleton,
  Page,
  RefreshButton,
  Row,
  Section,
  SelectControl,
  Stack,
  StatusBadge,
  Text,
  useConfirm,
} from "@alfred/ui";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { onNativeEvent, openExternal } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage } from "../vault/api";
import {
  type AuthType,
  authTypeLabel,
  bindNeed,
  type ClientConfig,
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
  methodLabel,
  testClient,
  validateClient,
} from "./api";
import { ClientEditor } from "./ClientEditor";
import { InstanceEditor } from "./InstanceEditor";

const STATUS: Record<ClientItem["status"], { label: string; tone: "success" | "warning" | "danger" }> = {
  ready: { label: "Prêt", tone: "success" },
  toValidate: { label: "À valider", tone: "warning" },
  noInstance: { label: "Aucune instance", tone: "warning" },
  missingSecret: { label: "Secret manquant", tone: "warning" },
  toConnect: { label: "À connecter", tone: "warning" },
  invalid: { label: "Invalide", tone: "danger" },
};

type Editing =
  | { kind: "client"; client?: ClientItem; preset?: Partial<ClientConfig> }
  | { kind: "instance"; client: ClientItem; instance?: ClientInstanceItem };

/** Changement annoncé par le backend : retour d’une connexion OAuth, ou simple modification d’un client. */
interface ClientsChange {
  client?: string;
  instance?: string;
  connected?: boolean;
  error?: string;
}

/** Ce qu’on teste, connecte ou déconnecte : un client à une seule adresse, ou une instance d’un client. */
interface Target {
  client: ClientItem;
  /** Absente pour un client à une seule adresse : son instance par défaut. */
  instance?: ClientInstanceItem;
}

const targetKey = (client: string, instance?: string) => (instance ? `${client}#${instance}` : client);
const targetLabel = ({ client, instance }: Target) => (instance ? `${client.label} — ${instance.label}` : client.label);

/** L’instance `default` d’un client à une seule adresse se suit sous le seul identifiant du client. */
function connectingKey(change: ClientsChange, clients: ClientItem[] | undefined) {
  const client = clients?.find((known) => known.id === change.client);
  return client?.simple || !change.instance ? (change.client ?? "") : targetKey(change.client ?? "", change.instance);
}

/** Une instance par ligne, pour les clients à plusieurs instances. */
interface InstanceRow {
  key: string;
  client: ClientItem;
  instance: ClientInstanceItem;
}

/**
 * Onglet « Clients » des Réglages : les adresses que les pages peuvent appeler, leur authentification, et les
 * demandes des modules à relier à ces clients.
 */
export function ClientsSettings() {
  const [overview, setOverview] = useState<ClientsOverview>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Editing>();
  const [testing, setTesting] = useState<string>();
  const [tests, setTests] = useState<Record<string, ClientTestResult>>({});
  /** Client dont la connexion OAuth attend le retour du navigateur. */
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
    // Un secret saisi dans le coffre change l’état « Secret manquant » d’un client.
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
      title: `Valider le client « ${client.label} » ?`,
      message: (
        <Stack gap="md">
          <Text tone="muted">
            {validation.everValidated
              ? "Ce client a été modifié hors des Réglages. Une fois validé, Alfred enverra son secret selon ces nouvelles valeurs."
              : "Ce client a été créé hors des Réglages. Une fois validé, Alfred enverra le secret de l’entrée du coffre aux adresses ci-dessous."}
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
      confirmLabel: "Valider",
    });
    if (!confirmed) return;
    try {
      await validateClient(client);
      notify({ title: `${client.label} est validé`, tone: "success" });
    } catch (failure) {
      notify({ title: `${client.label} n’a pas été validé`, description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const remove = async (client: ClientItem) => {
    const confirmed = await confirm({
      title: `Supprimer le client « ${client.label} » ?`,
      message:
        client.usedBy.length > 0
          ? "Les demandes de modules qui y sont reliées devront être reliées à un autre client. L’entrée du coffre est conservée."
          : "Les pages qui l’appellent ne pourront plus joindre ce service. L’entrée du coffre est conservée.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteClient(client.id);
      notify({ title: "Client supprimé", tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: "Le client n’a pas été supprimé", description: errorMessage(failure), tone: "error" });
    }
  };

  const removeInstance = async ({ client, instance }: InstanceRow) => {
    const confirmed = await confirm({
      title: `Supprimer l’instance « ${instance.label} » de ${client.label} ?`,
      message: instance.default
        ? "C’est l’instance par défaut : les pages qui ne nomment pas d’instance utiliseront la suivante. L’entrée du coffre est conservée."
        : "Les pages qui la nomment ne pourront plus la joindre. L’entrée du coffre est conservée.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteInstance(client.id, instance.id);
      notify({ title: "Instance supprimée", tone: "success" });
    } catch (failure) {
      notify({ title: "L’instance n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const makeDefault = async ({ client, instance }: InstanceRow) => {
    try {
      await makeDefaultInstance(client.id, instance.id);
      notify({ title: `${instance.label} est l’instance par défaut de ${client.label}`, tone: "success" });
    } catch (failure) {
      notify({ title: "L’instance par défaut n’a pas changé", description: errorMessage(failure), tone: "error" });
    }
    await load();
  };

  const bind = async (need: ClientNeedItem, client: string) => {
    try {
      await bindNeed(need.key, client || null);
      await load();
    } catch (failure) {
      notify({ title: "La demande n’a pas été reliée", description: errorMessage(failure), tone: "error" });
      // La liste est relue : le choix affiché revient à ce qui est réellement enregistré.
      await load();
    }
  };

  if (editing?.kind === "instance") {
    return (
      <InstanceEditor
        key={`${editing.client.id}:${editing.instance?.id ?? "nouvelle"}`}
        client={editing.client}
        initial={editing.instance}
        redirectUri={overview?.redirectUri ?? null}
        onCancel={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void load();
        }}
      />
    );
  }

  if (editing) {
    return (
      <ClientEditor
        // Une clé par client : le formulaire repart de zéro à chaque ouverture.
        key={editing.client?.id ?? `new:${editing.preset?.id ?? ""}`}
        initial={editing.client}
        preset={editing.preset}
        redirectUri={overview?.redirectUri ?? null}
        onCancel={() => setEditing(undefined)}
        onSaved={(saved) => {
          // Un nouveau client à plusieurs instances n’a encore rien à appeler : on enchaîne sur sa première instance.
          if (!editing.client && !saved.simple) {
            const first = saved.instances[0];
            setEditing({ kind: "instance", client: saved, instance: first });
          } else {
            setEditing(undefined);
          }
          void load();
        }}
      />
    );
  }

  if (overview === undefined) {
    return (
      <Page>
        {error ? (
          <FeedbackBanner
            tone="error"
            appearance="contained"
            action={<Button onClick={() => void load()}>Réessayer</Button>}
          >
            Les clients n’ont pas pu être lus. {error}
          </FeedbackBanner>
        ) : (
          <LoadingSkeleton variant="page" label="Chargement des clients…" />
        )}
      </Page>
    );
  }

  const { clients, needs } = overview;
  const create = (
    <Button variant="primary" onClick={() => setEditing({ kind: "client" })}>
      Nouveau client
    </Button>
  );

  /** État d’un client ou d’une instance, avec ce qui l’explique et le dernier test. */
  const statusCell = (item: Pick<ClientItem, "status" | "problem" | "validation">, key: string, showsTest: boolean) => {
    const status = STATUS[item.status];
    const tested = showsTest ? tests[key] : undefined;
    return (
      <Stack gap="xs">
        <Row gap="xs">
          <StatusBadge tone={status.tone} size="compact" title={item.problem ?? undefined}>
            {status.label}
          </StatusBadge>
        </Row>
        {item.problem ? (
          <Text size="meta" tone="danger">
            {item.problem}
          </Text>
        ) : null}
        {item.status === "toValidate" ? (
          <Text size="meta" tone="warning">
            {item.validation?.everValidated ? "Modifié" : "Créé"} hors des Réglages : rien n’est envoyé avant
            validation.
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

  /** Connexion et test d’un client à une seule adresse, ou d’une instance. */
  const targetActions = (target: Target, state: Pick<ClientItem, "status" | "connected">, oauth: boolean) => {
    const key = targetKey(target.client.id, target.instance?.id);
    const label = targetLabel(target);
    return (
      <>
        {oauth && state.status === "toConnect" ? (
          <Button aria-label={`Se connecter à ${label}`} onClick={() => void connect(target)}>
            Se connecter
          </Button>
        ) : null}
        {oauth && state.connected ? (
          <Button aria-label={`Se déconnecter de ${label}`} onClick={() => void disconnect(target)}>
            Se déconnecter
          </Button>
        ) : null}
        <Button
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

  const clientColumns: DataTableColumn<ClientItem>[] = [
    {
      key: "label",
      header: "Libellé",
      render: (client) => (
        <Stack gap="none">
          <Text weight="medium">{client.label}</Text>
          <Text size="meta" tone="muted">
            {client.id}
          </Text>
        </Stack>
      ),
    },
    {
      key: "baseUrl",
      header: "Adresse",
      sortValue: (client) => (client.simple ? client.baseUrl : `${client.instances.length}`),
      render: (client) =>
        client.simple ? (
          client.baseUrl
        ) : (
          <Stack gap="none">
            <Text>
              {client.instances.length === 0
                ? "Aucune instance"
                : `${client.instances.length} instance${client.instances.length > 1 ? "s" : ""}`}
            </Text>
            {client.baseUrl ? (
              <Text size="meta" tone="muted">
                Par défaut : {client.baseUrl}
              </Text>
            ) : null}
          </Stack>
        ),
    },
    {
      key: "auth",
      header: "Authentification",
      sortValue: (client) => (client.simple ? authTypeLabel(client.auth?.type ?? "none") : "~"),
      render: (client) =>
        client.simple
          ? authTypeLabel(client.auth?.type ?? "none")
          : client.methods.map((method) => methodLabel(method)).join(", "),
    },
    {
      key: "status",
      header: "État",
      width: "200px",
      render: (client) => statusCell(client, client.id, client.simple),
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      sortable: false,
      render: (client) => (
        <Row gap="xs" justify="end">
          {client.status === "toValidate" ? (
            <Button aria-label={`Valider ${client.label}`} onClick={() => void validate(client)}>
              Valider
            </Button>
          ) : null}
          {client.simple ? (
            targetActions({ client }, client, client.auth?.type === "oauth2")
          ) : (
            <Button
              aria-label={`Ajouter une instance à ${client.label}`}
              disabled={client.status === "invalid" && client.methods.length === 0}
              onClick={() => setEditing({ kind: "instance", client })}
            >
              Ajouter une instance
            </Button>
          )}
          <IconButton
            label={`Modifier ${client.label}`}
            size="small"
            disabled={client.status === "invalid" && !client.baseUrl && client.methods.length === 0}
            onClick={() => setEditing({ kind: "client", client })}
          >
            <Pencil size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={`Supprimer ${client.label}`}
            size="small"
            tone="danger"
            onClick={() => void remove(client)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </IconButton>
        </Row>
      ),
    },
  ];

  const instanceRows: InstanceRow[] = clients
    .filter((client) => !client.simple)
    .flatMap((client) =>
      client.instances.map((instance) => ({ key: targetKey(client.id, instance.id), client, instance })),
    );

  const instanceColumns: DataTableColumn<InstanceRow>[] = [
    {
      key: "instance",
      header: "Instance",
      sortValue: (row) => `${row.client.label} ${row.instance.label}`,
      render: ({ client, instance }) => (
        <Stack gap="none">
          <Row gap="xs">
            <Text weight="medium">{instance.label}</Text>
            {instance.default ? (
              <StatusBadge tone="neutral" size="compact">
                Par défaut
              </StatusBadge>
            ) : null}
          </Row>
          <Text size="meta" tone="muted">
            {client.label} · {instance.id}
          </Text>
        </Stack>
      ),
    },
    {
      key: "url",
      header: "Adresse",
      sortValue: (row) => row.instance.effectiveUrl,
      render: ({ instance }) => instance.effectiveUrl ?? instance.url ?? "—",
    },
    {
      key: "method",
      header: "Authentification",
      sortValue: (row) => row.instance.method,
      render: ({ client, instance }) => {
        const method = client.methods.find((known) => known.id === instance.method);
        return method ? methodLabel(method) : `${instance.method} (introuvable)`;
      },
    },
    {
      key: "status",
      header: "État",
      width: "200px",
      sortValue: (row) => row.instance.status,
      render: ({ key, instance }) => statusCell(instance, key, true),
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      sortable: false,
      render: (row) => {
        const { client, instance } = row;
        const label = `${client.label} — ${instance.label}`;
        return (
          <Row gap="xs" justify="end">
            {targetActions({ client, instance }, instance, instance.authType === "oauth2")}
            {instance.default ? null : (
              <Button aria-label={`Utiliser ${label} par défaut`} onClick={() => void makeDefault(row)}>
                Par défaut
              </Button>
            )}
            <IconButton
              label={`Modifier ${label}`}
              size="small"
              onClick={() => setEditing({ kind: "instance", client, instance })}
            >
              <Pencil size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={`Supprimer ${label}`}
              size="small"
              tone="danger"
              onClick={() => void removeInstance(row)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </Row>
        );
      },
    },
  ];

  const needColumns: DataTableColumn<ClientNeedItem>[] = [
    { key: "moduleName", header: "Module" },
    {
      key: "label",
      header: "Demande",
      render: (need) => (
        <Stack gap="none">
          <Text weight="medium">{need.label}</Text>
          <Text size="meta" tone="muted">
            {[need.auth ? authTypeLabel(need.auth) : null, need.baseUrl].filter(Boolean).join(" · ") || need.key}
          </Text>
        </Stack>
      ),
    },
    {
      key: "client",
      header: "Client relié",
      sortValue: (need) => need.client,
      render: (need) => {
        const sameName = clients.find((client) => client.id === need.id);
        const dangling = need.binding && !clients.some((client) => client.id === need.binding);
        return (
          <SelectControl
            aria-label={`Client relié à la demande ${need.label} du module ${need.moduleName}`}
            value={need.binding ?? ""}
            onChange={(event) => void bind(need, event.target.value)}
          >
            <option value="">{sameName ? `Automatique : ${sameName.label} (même nom)` : "Aucun"}</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.label}
              </option>
            ))}
            {dangling && need.binding ? <option value={need.binding}>{need.binding} (introuvable)</option> : null}
          </SelectControl>
        );
      },
    },
    {
      key: "state",
      header: "État",
      width: "110px",
      sortValue: (need) => (need.client ? 1 : 0),
      render: (need) =>
        need.client ? (
          <StatusBadge tone="success" size="compact">
            Reliée
          </StatusBadge>
        ) : (
          <StatusBadge tone="warning" size="compact">
            À relier
          </StatusBadge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      width: "150px",
      sortable: false,
      render: (need) =>
        need.client ? null : (
          <Button
            aria-label={`Créer le client demandé par ${need.moduleName} : ${need.label}`}
            onClick={() =>
              setEditing({
                kind: "client",
                preset: {
                  id: clients.some((client) => client.id === need.id) ? undefined : need.id,
                  label: need.label,
                  baseUrl: need.baseUrl ?? "",
                  auth: { type: (need.auth ?? "none") as AuthType },
                },
              })
            }
          >
            Créer le client
          </Button>
        ),
    },
  ];

  const needsSection =
    needs.length > 0 ? (
      <Section
        title="Demandes des modules"
        description="Chaque module nomme les clients dont il a besoin. Une demande utilise le client du même nom, ou celui que vous choisissez ici."
      >
        <DataTable label="Demandes des modules" columns={needColumns} rows={needs} rowKey={(need) => need.key} />
      </Section>
    ) : null;

  if (clients.length === 0) {
    return (
      <Page>
        <EmptyState
          title="Aucun client"
          description="Un client déclare une adresse que les pages et les fonctions de l’espace peuvent appeler. Alfred y ajoute l’authentification depuis le coffre : les pages ne voient jamais le secret."
        >
          {create}
        </EmptyState>
        {needsSection}
        {confirmDialog}
      </Page>
    );
  }

  return (
    <Page>
      {error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          Les clients n’ont pas pu être relus. {error}
        </FeedbackBanner>
      ) : null}
      <Section
        title="Clients"
        description="Adresses que l’espace peut appeler. Les pages n’ont pas de réseau : elles passent par ces clients, authentifiés depuis le coffre."
        actions={
          <>
            <RefreshButton loading={loading} onClick={() => void load()} />
            {create}
          </>
        }
      >
        <DataTable
          label="Clients"
          columns={clientColumns}
          rows={clients}
          rowKey={(client) => client.id}
          loading={loading}
        />
      </Section>
      {instanceRows.length > 0 ? (
        <Section
          title="Instances"
          description="Comptes ou installations des clients à plusieurs instances. Une page qui ne nomme pas d’instance utilise celle par défaut."
        >
          <DataTable label="Instances" columns={instanceColumns} rows={instanceRows} rowKey={(row) => row.key} />
        </Section>
      ) : null}
      {needsSection}
      {confirmDialog}
    </Page>
  );
}
