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
  authTypeLabel,
  bindNeed,
  type ClientConfig,
  type ClientItem,
  type ClientNeedItem,
  type ClientsOverview,
  type ClientTestResult,
  connectClient,
  deleteClient,
  disconnectClient,
  listClients,
  testClient,
  validateClient,
} from "./api";
import { ClientEditor } from "./ClientEditor";

const STATUS: Record<ClientItem["status"], { label: string; tone: "success" | "warning" | "danger" }> = {
  ready: { label: "Prêt", tone: "success" },
  toValidate: { label: "À valider", tone: "warning" },
  missingSecret: { label: "Secret manquant", tone: "warning" },
  toConnect: { label: "À connecter", tone: "warning" },
  invalid: { label: "Invalide", tone: "danger" },
};

type Editing = { client?: ClientItem; preset?: Partial<ClientConfig> };

/** Changement annoncé par le backend : retour d’une connexion OAuth, ou simple modification d’un client. */
interface ClientsChange {
  client?: string;
  connected?: boolean;
  error?: string;
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
      if (change.client && change.client === connectingRef.current && typeof change.connected === "boolean") {
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

  const test = async (client: ClientItem) => {
    setTesting(client.id);
    try {
      const result = await testClient(client.id);
      setTests((current) => ({ ...current, [client.id]: result }));
      notify({
        title: result.ok ? `${client.label} : le service répond` : `${client.label} : le test a échoué`,
        description: `${result.message} ${result.durationMs} ms.`,
        tone: result.ok ? "success" : "error",
      });
    } catch (failure) {
      notify({ title: `${client.label} : le test a échoué`, description: errorMessage(failure), tone: "error" });
    } finally {
      setTesting(undefined);
    }
  };

  const connect = async (client: ClientItem) => {
    try {
      const { authorizationUrl } = await connectClient(client.id);
      connectingRef.current = client.id;
      setConnecting(client.id);
      await openExternal(authorizationUrl);
    } catch (failure) {
      connectingRef.current = undefined;
      setConnecting(undefined);
      notify({
        title: `La connexion de ${client.label} n’a pas pu démarrer`,
        description: errorMessage(failure),
        tone: "error",
      });
    }
  };

  const disconnect = async (client: ClientItem) => {
    try {
      await disconnectClient(client.id);
      notify({ title: `${client.label} est déconnecté`, tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: `${client.label} n’a pas été déconnecté`, description: errorMessage(failure), tone: "error" });
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
              label: change.label,
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
      await validateClient(client.id, validation.fingerprint);
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

  if (editing) {
    return (
      <ClientEditor
        // Une clé par client : le formulaire repart de zéro à chaque ouverture.
        key={editing.client?.id ?? `new:${editing.preset?.id ?? ""}`}
        initial={editing.client}
        preset={editing.preset}
        redirectUri={overview?.redirectUri ?? null}
        onCancel={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
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
    <Button variant="primary" onClick={() => setEditing({})}>
      Nouveau client
    </Button>
  );

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
    { key: "baseUrl", header: "Adresse" },
    {
      key: "auth",
      header: "Authentification",
      sortValue: (client) => authTypeLabel(client.auth.type),
      render: (client) => authTypeLabel(client.auth.type),
    },
    {
      key: "status",
      header: "État",
      width: "200px",
      render: (client) => {
        const status = STATUS[client.status];
        const tested = tests[client.id];
        return (
          <Stack gap="xs">
            <Row gap="xs">
              <StatusBadge tone={status.tone} size="compact" title={client.problem ?? undefined}>
                {status.label}
              </StatusBadge>
            </Row>
            {client.problem ? (
              <Text size="meta" tone="danger">
                {client.problem}
              </Text>
            ) : null}
            {client.status === "toValidate" ? (
              <Text size="meta" tone="warning">
                {client.validation?.everValidated ? "Modifié" : "Créé"} hors des Réglages : rien n’est envoyé avant
                validation.
              </Text>
            ) : null}
            {connecting === client.id ? (
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
      },
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
          {client.auth.type === "oauth2" && client.status === "toConnect" ? (
            <Button aria-label={`Se connecter à ${client.label}`} onClick={() => void connect(client)}>
              Se connecter
            </Button>
          ) : null}
          {client.auth.type === "oauth2" && client.connected ? (
            <Button aria-label={`Se déconnecter de ${client.label}`} onClick={() => void disconnect(client)}>
              Se déconnecter
            </Button>
          ) : null}
          <Button
            aria-label={`Tester ${client.label}`}
            loading={testing === client.id}
            loadingLabel="Test…"
            disabled={
              client.status === "invalid" ||
              client.status === "toValidate" ||
              (testing !== undefined && testing !== client.id)
            }
            onClick={() => void test(client)}
          >
            Tester
          </Button>
          <IconButton
            label={`Modifier ${client.label}`}
            size="small"
            disabled={client.status === "invalid" && !client.baseUrl}
            onClick={() => setEditing({ client })}
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
                preset: {
                  id: clients.some((client) => client.id === need.id) ? undefined : need.id,
                  label: need.label,
                  baseUrl: need.baseUrl ?? "",
                  auth: { type: (need.auth ?? "none") as ClientConfig["auth"]["type"] },
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
      {needsSection}
      {confirmDialog}
    </Page>
  );
}
