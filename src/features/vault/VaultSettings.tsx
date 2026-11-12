import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  IconButton,
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
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { deleteVaultEntry, errorMessage, listVault, type VaultEntry, vaultKindLabel } from "./api";
import { VaultEntryDialog } from "./VaultEntryDialog";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

function EntryState({ entry }: { entry: VaultEntry }) {
  if (entry.problem) {
    return (
      <StatusBadge tone="danger" size="compact" title={entry.problem}>
        Trousseau illisible
      </StatusBadge>
    );
  }
  if (entry.kind === "oauth2") {
    return entry.connected ? (
      <StatusBadge tone="success" size="compact">
        Connecté
      </StatusBadge>
    ) : (
      <StatusBadge size="compact">Non connecté</StatusBadge>
    );
  }
  return entry.hasSecret ? (
    <StatusBadge tone="success" size="compact">
      Secret enregistré
    </StatusBadge>
  ) : (
    <StatusBadge tone="warning" size="compact">
      Secret manquant
    </StatusBadge>
  );
}

/** Onglet « Coffre » des Réglages : inventaire des secrets du poste, sans jamais en afficher la valeur. */
export function VaultSettings() {
  const [entries, setEntries] = useState<VaultEntry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  /** `{}` pour une création, `{ entry }` pour une édition. */
  const [editing, setEditing] = useState<{ entry?: VaultEntry }>();
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listVault());
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Une connexion OAuth ou une saisie faite depuis l’écran des clients change l’état affiché ici.
    const stopVault = onNativeEvent("vault:changed", () => void load());
    const stopClients = onNativeEvent("clients:changed", () => void load());
    return () => {
      stopVault();
      stopClients();
    };
  }, [load]);

  const remove = async (entry: VaultEntry) => {
    const confirmed = await confirm({
      title: `Supprimer l’entrée « ${entry.label} » ?`,
      message: "Son secret sera effacé du trousseau de ce poste. Cette suppression est définitive.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteVaultEntry(entry.id);
      notify({ title: "Entrée du coffre supprimée", tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: "L’entrée du coffre n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
  };

  const create = (
    <Button variant="primary" onClick={() => setEditing({})}>
      Nouvelle entrée
    </Button>
  );

  const columns: DataTableColumn<VaultEntry>[] = [
    {
      key: "label",
      header: "Libellé",
      render: (entry) => (
        <Stack gap="none">
          <Text weight="medium">{entry.label}</Text>
          <Text size="meta" tone="muted">
            {entry.id}
          </Text>
        </Stack>
      ),
    },
    {
      key: "kind",
      header: "Type",
      sortValue: (entry) => vaultKindLabel(entry.kind),
      render: (entry) => vaultKindLabel(entry.kind),
    },
    {
      key: "state",
      header: "État",
      width: "160px",
      sortValue: (entry) => Number(entry.hasSecret) + Number(entry.connected ?? false),
      render: (entry) => <EntryState entry={entry} />,
    },
    {
      key: "updatedAt",
      header: "Mise à jour",
      width: "170px",
      align: "end",
      render: (entry) => formatDate(entry.updatedAt),
    },
    {
      key: "actions",
      header: "Actions",
      width: "88px",
      align: "end",
      sortable: false,
      render: (entry) => (
        <Row gap="xs" justify="end">
          <IconButton label={`Modifier ${entry.label}`} size="small" onClick={() => setEditing({ entry })}>
            <Pencil size={14} aria-hidden="true" />
          </IconButton>
          <IconButton label={`Supprimer ${entry.label}`} size="small" tone="danger" onClick={() => void remove(entry)}>
            <Trash2 size={14} aria-hidden="true" />
          </IconButton>
        </Row>
      ),
    },
  ];

  const dialogs = (
    <>
      {editing ? (
        <VaultEntryDialog
          // Une clé par entrée : la modale repart de zéro à chaque ouverture.
          key={editing.entry?.id ?? "new"}
          entry={editing.entry}
          onClose={() => setEditing(undefined)}
          onSaved={() => void load()}
        />
      ) : null}
      {confirmDialog}
    </>
  );

  if (entries === undefined) {
    return (
      <Page>
        {error ? (
          <FeedbackBanner
            tone="error"
            appearance="contained"
            action={<Button onClick={() => void load()}>Réessayer</Button>}
          >
            Le coffre n’a pas pu être lu. {error}
          </FeedbackBanner>
        ) : (
          <LoadingSkeleton variant="page" label="Chargement du coffre…" />
        )}
      </Page>
    );
  }

  if (entries.length === 0) {
    return (
      <Page>
        <EmptyState
          title="Aucune entrée dans le coffre"
          description="Le coffre garde les jetons, mots de passe et secrets dont les clients ont besoin pour s’authentifier. Ils restent dans le trousseau de ce poste et ne sont jamais affichés."
        >
          {create}
        </EmptyState>
        {dialogs}
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
          Le coffre n’a pas pu être relu. {error}
        </FeedbackBanner>
      ) : null}
      <Section
        title="Coffre"
        description="Les secrets restent dans le trousseau de ce poste. Alfred ne les affiche jamais."
        actions={
          <>
            <RefreshButton loading={loading} onClick={() => void load()} />
            {create}
          </>
        }
      >
        <DataTable
          label="Entrées du coffre"
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          loading={loading}
        />
      </Section>
      {dialogs}
    </Page>
  );
}
