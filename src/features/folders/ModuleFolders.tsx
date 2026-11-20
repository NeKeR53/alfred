import { Button, DataTable, type DataTableColumn, Stack, Text, useConfirm } from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { ModulePart } from "../modules/ModulePart";

export interface GrantedFolder {
  id: string;
  path: string;
  label: string;
  grantedAt: string;
  grantedBy: "user" | "agent";
}

const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Partie « Dossiers du poste » de la fiche d’un module (Réglages → Modules) : les dossiers de l’ordinateur que le
 * module peut lire, écrire et gérer avec Git, et de quoi lui retirer l’accès. Rien quand il n’en a aucun.
 */
export function ModuleFolders({ module, name }: { module: string; name: string }) {
  const [folders, setFolders] = useState<GrantedFolder[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setFolders(await invoke<GrantedFolder[]>("folders.list", { module }));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [module]);

  useEffect(() => {
    void load();
    const reload = (payload: unknown) => {
      if ((payload as { module?: string } | null)?.module === module) void load();
    };
    const stopGranted = onNativeEvent("folders:granted", reload);
    const stopRevoked = onNativeEvent("folders:revoked", reload);
    return () => {
      stopGranted();
      stopRevoked();
    };
  }, [load, module]);

  const revoke = async (folder: GrantedFolder) => {
    const accepted = await confirm({
      title: `Retirer l’accès à « ${folder.label} » ?`,
      message: `${name} ne pourra plus lire ni modifier ${folder.path}. Les fichiers restent sur votre ordinateur.`,
      confirmLabel: "Retirer l’accès",
    });
    if (!accepted) return;
    setBusy(folder.id);
    try {
      await invoke("folders.revoke", { module, folder: folder.id });
      await load();
    } catch (failure) {
      notify({ title: "L’accès n’a pas été retiré", description: errorMessage(failure), tone: "error" });
    } finally {
      setBusy(undefined);
    }
  };

  const columns: DataTableColumn<GrantedFolder>[] = [
    {
      key: "label",
      header: "Dossier",
      sortValue: (folder) => folder.label,
      render: (folder) => (
        <Stack gap="none">
          <Text weight="medium">{folder.label}</Text>
          <Text size="meta" tone="muted">
            {folder.path}
          </Text>
        </Stack>
      ),
    },
    {
      key: "grantedAt",
      header: "Accordé",
      width: "190px",
      sortValue: (folder) => folder.grantedAt,
      render: (folder) =>
        `${date.format(new Date(folder.grantedAt))}${folder.grantedBy === "agent" ? " par l’agent" : ""}`,
    },
    {
      key: "actions",
      header: "Actions",
      width: "150px",
      align: "end",
      sortable: false,
      render: (folder) => (
        <Button
          variant="secondary"
          loading={busy === folder.id}
          disabled={busy !== undefined && busy !== folder.id}
          aria-label={`Retirer l’accès à ${folder.label}`}
          onClick={() => void revoke(folder)}
        >
          Retirer l’accès
        </Button>
      ),
    },
  ];

  if (!folders || folders.length === 0) {
    return error ? (
      <Text size="meta" tone="danger">
        Les dossiers n’ont pas pu être lus : {error}
      </Text>
    ) : null;
  }
  return (
    <ModulePart
      part="folders"
      title="Dossiers du poste"
      description={`Dossiers de votre ordinateur que ${name} peut lire, modifier et gérer avec Git.`}
    >
      <DataTable label="Dossiers accordés au module" columns={columns} rows={folders} rowKey={(folder) => folder.id} />
      {confirmDialog}
    </ModulePart>
  );
}
