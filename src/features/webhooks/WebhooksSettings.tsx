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
  Stack,
  StatusBadge,
  Text,
  useConfirm,
} from "@alfred/ui";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage } from "../vault/api";
import { getWebhookSecret, hookKey, listWebhooks, rotateWebhookSecret, type WebhookItem } from "./api";

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export const MASK = "••••••••••••••••••••••••";

async function copy(text: string, done: string, failed: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify({ title: done, tone: "success" });
  } catch (failure) {
    notify({ title: failed, description: errorMessage(failure), tone: "error" });
  }
}

/** Secret du webhook choisi : masqué par défaut, copiable, régénérable après confirmation. */
function SecretSection({ hook, onClose }: { hook: WebhookItem; onClose: () => void }) {
  const key = hookKey(hook);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setSecret((await getWebhookSecret(key)).secret);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async () => {
    const confirmed = await confirm({
      title: `Régénérer le secret du webhook « ${hook.description || key} » ?`,
      message: "L’ancien secret cesse aussitôt de fonctionner : l’émetteur sera refusé tant qu’il n’a pas le nouveau.",
      confirmLabel: "Régénérer",
      tone: "danger",
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      setSecret((await rotateWebhookSecret(key)).secret);
      notify({ title: "Secret régénéré", description: "Copiez-le chez l’émetteur du webhook.", tone: "success" });
    } catch (failure) {
      notify({ title: "Le secret n’a pas été régénéré", description: errorMessage(failure), tone: "error" });
    } finally {
      setRotating(false);
    }
  };

  return (
    <Section
      title={`Secret de « ${hook.description || key} »`}
      description="À copier chez l’émetteur. Il se transmet dans l’en-tête X-Alfred-Secret, en Authorization: Bearer, dans le paramètre ?secret=, ou sert de clé à une signature HMAC-SHA256 du corps (X-Hub-Signature-256, format GitHub)."
      actions={<Button onClick={onClose}>Fermer</Button>}
    >
      {error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          Le secret n’a pas pu être lu. {error}
        </FeedbackBanner>
      ) : secret === undefined ? (
        <LoadingSkeleton rows={1} label="Chargement du secret…" />
      ) : (
        <Stack gap="sm">
          <Row gap="xs" wrap>
            <Text as="span" weight="medium">
              {revealed ? secret : MASK}
            </Text>
            <IconButton
              label="Copier le secret"
              tooltip="Copier"
              size="small"
              onClick={() => void copy(secret, "Secret copié", "Le secret n’a pas été copié")}
            >
              <Copy size={16} aria-hidden="true" />
            </IconButton>
          </Row>
          <Row gap="sm">
            <Button aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
              {revealed ? "Masquer le secret" : "Révéler le secret"}
            </Button>
            <Button variant="danger" loading={rotating} loadingLabel="Régénération…" onClick={() => void rotate()}>
              Régénérer
            </Button>
          </Row>
          <KeyValueList
            items={[
              { label: "Méthodes", value: "POST, et GET pour les services qui vérifient l’adresse" },
              { label: "Réponse", value: "200 avec la sortie de la fonction, ou 202 si elle dure plus de 25 secondes" },
            ]}
          />
        </Stack>
      )}
      {confirmDialog}
    </Section>
  );
}

/** Onglet « Webhooks » des Réglages : adresses locales qui déclenchent les fonctions des modules. */
export function WebhooksSettings() {
  const [hooks, setHooks] = useState<WebhookItem[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setHooks(await listWebhooks());
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const stopSpace = onNativeEvent("space:changed", () => void load());
    // Une réception écrit au journal : la date de dernière réception change.
    const stopJournal = onNativeEvent("journal:changed", () => void load());
    return () => {
      stopSpace();
      stopJournal();
    };
  }, [load]);

  if (hooks === undefined) {
    return (
      <Page width="text">
        {error ? (
          <FeedbackBanner
            tone="error"
            appearance="contained"
            action={<Button onClick={() => void load()}>Réessayer</Button>}
          >
            Les webhooks n’ont pas pu être lus. {error}
          </FeedbackBanner>
        ) : (
          <LoadingSkeleton rows={4} label="Chargement des webhooks…" />
        )}
      </Page>
    );
  }

  const tunnel =
    "Alfred n’écoute que sur cet ordinateur (127.0.0.1) et seulement tant qu’il est ouvert : pour un service sur Internet, exposez l’adresse locale par le tunnel de votre choix (Cloudflare Tunnel, Tailscale Funnel, ngrok).";

  if (hooks.length === 0) {
    return (
      <Page width="text">
        <EmptyState
          title="Aucun webhook"
          description="Un webhook est une adresse qu’un service extérieur appelle pour déclencher une fonction d’un module. Pour en créer un, demandez-le à l’agent : « crée un webhook qui reçoit les paiements de Stripe »."
        />
        <Text size="meta" tone="muted">
          {tunnel}
        </Text>
      </Page>
    );
  }

  const current = hooks.find((hook) => hookKey(hook) === selected);

  const columns: DataTableColumn<WebhookItem>[] = [
    {
      key: "description",
      header: "Webhook",
      sortValue: (hook) => hook.description || hook.id,
      render: (hook) => (
        <Stack gap="none">
          <Text weight="medium">{hook.description || hook.id}</Text>
          <Text size="meta" tone="muted">
            Module {hook.module}
          </Text>
        </Stack>
      ),
    },
    {
      key: "function",
      header: "Fonction",
      render: (hook) => (
        <Stack gap="xs">
          <Text>{hook.function}</Text>
          {hook.functionExists ? null : (
            <Row>
              <StatusBadge tone="danger" size="compact">
                Fonction introuvable
              </StatusBadge>
            </Row>
          )}
        </Stack>
      ),
    },
    {
      key: "url",
      header: "Adresse locale",
      render: (hook) =>
        hook.url ? (
          <Row gap="xs">
            <Text as="span" size="meta">
              {hook.url}
            </Text>
            <IconButton
              label={`Copier l’adresse du webhook ${hook.description || hook.id}`}
              tooltip="Copier"
              size="small"
              onClick={() => void copy(hook.url ?? "", "Adresse copiée", "L’adresse n’a pas été copiée")}
            >
              <Copy size={16} aria-hidden="true" />
            </IconButton>
          </Row>
        ) : (
          <Text tone="muted">Serveur local arrêté</Text>
        ),
    },
    {
      key: "lastReceivedAt",
      header: "Dernière réception",
      width: "150px",
      align: "end",
      render: (hook) => (hook.lastReceivedAt ? dateTime.format(new Date(hook.lastReceivedAt)) : "Jamais"),
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      width: "160px",
      sortable: false,
      render: (hook) => (
        <Button
          aria-label={`Afficher le secret du webhook ${hook.description || hook.id}`}
          onClick={() => setSelected(hookKey(hook))}
        >
          Afficher le secret
        </Button>
      ),
    },
  ];

  return (
    <Page>
      {error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          Les webhooks n’ont pas pu être relus. {error}
        </FeedbackBanner>
      ) : null}
      {hooks.some((hook) => !hook.functionExists) ? (
        <FeedbackBanner tone="warning" appearance="contained">
          Un webhook déclenche une fonction qui n’existe pas : ses appels échoueront. Demandez à l’agent d’écrire la
          fonction ou de corriger le webhook.
        </FeedbackBanner>
      ) : null}
      <Section
        title="Webhooks"
        description={tunnel}
        actions={<RefreshButton loading={loading} onClick={() => void load()} />}
      >
        <DataTable label="Webhooks" columns={columns} rows={hooks} rowKey={hookKey} loading={loading} />
      </Section>
      {current ? <SecretSection key={hookKey(current)} hook={current} onClose={() => setSelected(undefined)} /> : null}
    </Page>
  );
}
