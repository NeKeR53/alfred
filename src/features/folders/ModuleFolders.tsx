import { FolderX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SettingsSection } from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";

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
 * Section « Dossiers du poste » de la fiche d’un module (Réglages → Modules) : les dossiers de l’ordinateur que le
 * module peut lire, écrire et gérer avec Git, et de quoi lui retirer l’accès. Aucune section quand il n’en a aucun.
 */
export function useFoldersSection(module: { id: string; name: string } | undefined): SettingsSection | null {
  const id = module?.id;
  const [folders, setFolders] = useState<GrantedFolder[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setFolders(await invoke<GrantedFolder[]>("folders.list", { module: id }));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [id]);

  useEffect(() => {
    setFolders(undefined);
    if (!id) return;
    void load();
    const reload = (payload: unknown) => {
      if ((payload as { module?: string } | null)?.module === id) void load();
    };
    const stopGranted = onNativeEvent("folders:granted", reload);
    const stopRevoked = onNativeEvent("folders:revoked", reload);
    return () => {
      stopGranted();
      stopRevoked();
    };
  }, [load, id]);

  if (!module) return null;
  const revoke = async (folder: GrantedFolder) => {
    try {
      await invoke("folders.revoke", { module: module.id, folder: folder.id });
      await load();
    } catch (failure) {
      notify({ title: "L’accès n’a pas été retiré", description: errorMessage(failure), tone: "error" });
    }
  };

  if (!folders || folders.length === 0) {
    return error
      ? { id: "folders", title: "Dossiers du poste", emptyMessage: `Les dossiers n’ont pas pu être lus : ${error}` }
      : null;
  }
  return {
    id: "folders",
    title: "Dossiers du poste",
    description: `Dossiers de votre ordinateur que ${module.name} peut lire, modifier et gérer avec Git.`,
    settings: folders.map((folder) => ({
      type: "item",
      id: folder.id,
      label: folder.label,
      description: `${folder.path} · accordé le ${date.format(new Date(folder.grantedAt))}${folder.grantedBy === "agent" ? " par l’agent" : ""}`,
      actions: [
        {
          id: "revoke",
          label: `Retirer l’accès à ${folder.label}`,
          icon: <FolderX size={16} aria-hidden="true" />,
          danger: true,
          confirm: {
            title: `Retirer l’accès à « ${folder.label} » ?`,
            message: `${module.name} ne pourra plus lire ni modifier ${folder.path}. Les fichiers restent sur votre ordinateur.`,
            confirmLabel: "Retirer l’accès",
          },
          onPress: () => revoke(folder),
        },
      ],
    })),
  };
}
