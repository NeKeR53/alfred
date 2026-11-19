import {
  Button,
  EmptyState,
  FeedbackBanner,
  IconButton,
  LoadingSkeleton,
  Page,
  RefreshButton,
  Section,
  SettingRow,
  SettingRows,
  StatusBadge,
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
    <StatusBadge tone="pending" size="compact">
      Secret manquant
    </StatusBadge>
  );
}

/** « Mots de passe et clés » : inventaire des secrets du poste, sans jamais en afficher la valeur. */
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
      title: `Supprimer « ${entry.label} » ?`,
      message: "Son secret sera effacé du trousseau de ce poste. Cette suppression est définitive.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteVaultEntry(entry.id);
      notify({ title: "Mot de passe ou clé supprimé", tone: "success" });
      await load();
    } catch (failure) {
      notify({
        title: "Le mot de passe ou la clé n’a pas été supprimé",
        description: errorMessage(failure),
        tone: "error",
      });
    }
  };

  const create = (
    <Button variant="primary" onClick={() => setEditing({})}>
      Ajouter
    </Button>
  );

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
            Les mots de passe et clés n’ont pas pu être lus. {error}
          </FeedbackBanner>
        ) : (
          <LoadingSkeleton variant="page" label="Chargement des mots de passe et clés…" />
        )}
      </Page>
    );
  }

  if (entries.length === 0) {
    return (
      <Page>
        <EmptyState
          title="Aucun mot de passe ni clé"
          description="Ici sont rangés les mots de passe, clés et jetons dont vos services ont besoin pour se connecter. Ils restent dans le trousseau de ce poste et ne sont jamais affichés."
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
          Les mots de passe et clés n’ont pas pu être relus. {error}
        </FeedbackBanner>
      ) : null}
      <Section
        title="Mots de passe et clés"
        description="Ils restent dans le trousseau de ce poste. Alfred ne les affiche jamais."
        actions={
          <>
            <RefreshButton loading={loading} onClick={() => void load()} />
            {create}
          </>
        }
      >
        <SettingRows label="Mots de passe et clés">
          {entries.map((entry) => (
            <SettingRow
              key={entry.id}
              title={entry.label}
              badge={<EntryState entry={entry} />}
              description={`${vaultKindLabel(entry.kind)} · mis à jour le ${formatDate(entry.updatedAt)}`}
            >
              <IconButton label={`Modifier ${entry.label}`} size="small" onClick={() => setEditing({ entry })}>
                <Pencil size={14} aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`Supprimer ${entry.label}`}
                size="small"
                tone="danger"
                onClick={() => void remove(entry)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </IconButton>
            </SettingRow>
          ))}
        </SettingRows>
      </Section>
      {dialogs}
    </Page>
  );
}
