import { Pencil, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SettingsSection, SettingTag } from "socle-ui";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { deleteVaultEntry, errorMessage, listVault, type VaultEntry, vaultKindLabel } from "./api";
import { VaultEntryDialog } from "./VaultEntryDialog";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/** État d’une entrée, sans jamais en montrer la valeur. */
export function entryTag(entry: VaultEntry): SettingTag {
  if (entry.problem) return { label: "Trousseau illisible", tone: "danger" };
  if (entry.kind === "oauth2")
    return entry.connected ? { label: "Connecté", tone: "success" } : { label: "Non connecté", tone: "neutral" };
  return entry.hasSecret
    ? { label: "Secret enregistré", tone: "success" }
    : { label: "Secret manquant", tone: "pending" };
}

/** Rubrique « Mots de passe et clés » : inventaire des secrets du poste, sans jamais en afficher la valeur. */
export function useVaultSections(): SettingsSection[] {
  const [entries, setEntries] = useState<VaultEntry[]>();
  const [error, setError] = useState<string>();
  /** `{}` pour une création, `{ entry }` pour une édition. */
  const [editing, setEditing] = useState<{ entry?: VaultEntry }>();

  const load = useCallback(async () => {
    try {
      setEntries(await listVault());
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
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

  const dialog = editing ? (
    <VaultEntryDialog
      // Une clé par entrée : la modale repart de zéro à chaque ouverture.
      key={editing.entry?.id ?? "new"}
      entry={editing.entry}
      onClose={() => setEditing(undefined)}
      onSaved={() => void load()}
    />
  ) : undefined;

  return [
    {
      id: "vault",
      title: "Mots de passe et clés",
      description: "Ils restent dans le trousseau de ce poste. Alfred ne les affiche jamais.",
      actions: [
        { id: "refresh", label: "Actualiser", icon: <RefreshCw size={16} aria-hidden="true" />, onPress: load },
        { id: "add", label: "Ajouter", primary: true, onPress: () => setEditing({}) },
      ],
      emptyMessage:
        entries === undefined
          ? error
            ? `Les mots de passe et clés n’ont pas pu être lus. ${error}`
            : "Chargement des mots de passe et clés…"
          : "Aucun mot de passe ni clé. Ici sont rangés les mots de passe, clés et jetons dont vos services ont besoin pour se connecter. Ils restent dans le trousseau de ce poste et ne sont jamais affichés.",
      settings: (entries ?? []).map((entry) => ({
        type: "item" as const,
        id: entry.id,
        label: entry.label,
        code: entry.id,
        description: `${vaultKindLabel(entry.kind)} · mis à jour le ${formatDate(entry.updatedAt)}${entry.problem ? ` · ${entry.problem}` : ""}`,
        tags: [entryTag(entry)],
        actions: [
          {
            id: "edit",
            label: `Modifier ${entry.label}`,
            icon: <Pencil size={16} aria-hidden="true" />,
            onPress: () => setEditing({ entry }),
          },
          {
            id: "remove",
            label: `Supprimer ${entry.label}`,
            danger: true,
            confirm: {
              title: `Supprimer « ${entry.label} » ?`,
              message: "Son secret sera effacé du trousseau de ce poste. Cette suppression est définitive.",
              confirmLabel: "Supprimer",
            },
            onPress: () => remove(entry),
          },
        ],
      })),
      content: dialog,
    },
  ];
}
