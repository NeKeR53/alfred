import { Download, FolderOpen, MoreHorizontal, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, DropdownMenu, type SettingsSection, Table, type TableColumn, useConfirm } from "socle-ui";
import { inTauri, invoke, onNativeEvent, pickFile, pickFolder } from "../../lib/native";
import type { Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { ModuleExportDialog } from "./ModuleDataDialog";

export interface BackupInfo {
  id: string;
  createdAt: string;
  reason: "quotidienne" | "migration" | "manuelle" | "restauration" | "import";
  note?: string;
  size: number;
  modules: { id: string; tables: number; rows: number; files: number }[];
  copyError?: string;
}

interface BackupSettings {
  keep: number;
  copyDir?: string;
}

const REASON_LABEL: Record<BackupInfo["reason"], string> = {
  quotidienne: "Quotidienne",
  migration: "Avant un changement de structure",
  manuelle: "Manuelle",
  restauration: "Avant une restauration",
  import: "Avant un import",
};

const KEEP_CHOICES = [7, 14, 30, 60];

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function moduleName(snapshot: Snapshot, id: string): string {
  return snapshot.modules.find((module) => module.id === id)?.name ?? id;
}

const icon = (Icon: typeof X) => <Icon size={16} aria-hidden="true" />;

type BackupRow = BackupInfo & { when: string; kind: string; weight: string };

const COLUMNS: TableColumn[] = [
  { id: "when", label: "Date", width: 170 },
  { id: "kind", label: "Type" },
  { id: "weight", label: "Taille", width: 90, align: "end" },
];

/**
 * Sauvegardes des données des modules (base et fichiers, hors de l’historique git) : réglages, liste des copies,
 * restauration de tout l’espace de travail ou d’un module, export et import des données d’un module.
 */
export function useBackupsSection(snapshot: Snapshot | null): SettingsSection {
  const [backups, setBackups] = useState<BackupInfo[]>();
  const [settings, setSettings] = useState<BackupSettings>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  /** Modale d’export ou d’import des données d’un module. */
  const [transfer, setTransfer] = useState<"export" | "import">();
  const confirm = useConfirm();
  const space = snapshot?.path;
  const modules = snapshot?.modules ?? [];
  const nameOf = (id: string) => (snapshot ? moduleName(snapshot, id) : id);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `space` relit les sauvegardes quand l’espace change.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, current] = await Promise.all([
        invoke<BackupInfo[]>("backups.list"),
        invoke<BackupSettings>("backups.settings"),
      ]);
      setBackups(list);
      setSettings(current);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [space]);

  useEffect(() => {
    if (!space) return;
    void load();
    return onNativeEvent("backups:changed", () => void load());
  }, [load, space]);

  /** Un échec rejette : la ligne reprend l’ancienne valeur et le signale (D-204). */
  const changeSettings = async (next: Partial<BackupSettings>) => {
    setSettings(await invoke<BackupSettings>("backups.setSettings", next));
  };

  const changeOrReport = async (next: Partial<BackupSettings>) => {
    try {
      await changeSettings(next);
    } catch (failure) {
      notify({ title: "Le réglage n’a pas été changé", description: errorMessage(failure), tone: "error" });
    }
  };

  const chooseCopyDir = async () => {
    const dir = await pickFolder("Dossier où recopier les sauvegardes");
    if (dir) await changeOrReport({ copyDir: dir });
  };

  const backupNow = async () => {
    try {
      const backup = await invoke<BackupInfo>("backups.create");
      notify({
        title: "Sauvegarde faite",
        description: backup.copyError ? `La copie dans le dossier choisi a échoué : ${backup.copyError}` : undefined,
        tone: backup.copyError ? "warning" : "success",
      });
      await load();
    } catch (failure) {
      notify({ title: "La sauvegarde a échoué", description: errorMessage(failure), tone: "error" });
    }
  };

  const restore = async (backup: BackupInfo, target?: string) => {
    const what = target ? `les données du module « ${nameOf(target)} »` : "toutes les données des modules";
    const accepted = await confirm({
      title: `Restaurer ${what} au ${formatDate(backup.createdAt)} ?`,
      message: target
        ? "Les tables et les fichiers de ce module reviennent à leur état de cette sauvegarde ; les autres modules ne changent pas. Alfred sauvegarde d’abord l’état actuel, que vous pourrez restaurer à son tour."
        : "Les tables et les fichiers de tous les modules reviennent à leur état de cette sauvegarde. Alfred sauvegarde d’abord l’état actuel, que vous pourrez restaurer à son tour.",
      confirmLabel: "Restaurer",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await invoke("backups.restore", { id: backup.id, ...(target ? { module: target } : {}) });
      notify({ title: "Données restaurées", description: formatDate(backup.createdAt), tone: "success" });
      await load();
    } catch (failure) {
      notify({ title: "La restauration a échoué", description: errorMessage(failure), tone: "error" });
    }
  };

  const remove = async (backup: BackupInfo) => {
    const accepted = await confirm({
      title: `Supprimer la sauvegarde du ${formatDate(backup.createdAt)} ?`,
      message: "Elle ne pourra plus être restaurée. Les copies déjà faites dans le dossier choisi restent.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await invoke("backups.delete", { id: backup.id });
      await load();
    } catch (failure) {
      notify({ title: "La sauvegarde n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
    }
  };

  const importModule = async (module: string) => {
    setTransfer(undefined);
    const path = await pickFile("Importer des données dans le module");
    if (!path) return;
    const accepted = await confirm({
      title: `Remplacer les données du module « ${nameOf(module)} » ?`,
      message:
        "Les lignes et les fichiers actuels du module sont remplacés par ceux du fichier. Alfred sauvegarde d’abord l’état actuel.",
      confirmLabel: "Importer",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await invoke("backups.importModule", { module, path });
      notify({ title: "Données importées", description: nameOf(module), tone: "success" });
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "L’import a échoué", description: errorMessage(failure), tone: "error" });
    }
  };

  const keep = settings?.keep ?? 14;
  const rows: BackupRow[] = (backups ?? []).map((backup) => ({
    ...backup,
    when: formatDate(backup.createdAt),
    kind: backup.note ? `${REASON_LABEL[backup.reason]} (${backup.note})` : REASON_LABEL[backup.reason],
    weight: formatSize(backup.size),
  }));

  return {
    id: "backups",
    title: "Sauvegardes",
    description:
      "Les données des modules (leurs tables et leurs fichiers) ne font pas partie de l’historique. Alfred les copie chaque jour et avant chaque changement de structure d’un module.",
    actions: [
      { id: "create", label: "Sauvegarder maintenant", primary: true, onPress: backupNow },
      { id: "reload", label: "Actualiser les sauvegardes", icon: icon(RefreshCw), onPress: load },
    ],
    settings: [
      {
        id: "keep",
        type: "select",
        label: "Copies quotidiennes gardées",
        description: "Les plus anciennes sont supprimées au fur et à mesure.",
        value: String(keep),
        isDisabled: !settings,
        width: "sm",
        options: [...new Set([...KEEP_CHOICES, keep])]
          .sort((a, b) => a - b)
          .map((days) => ({ id: String(days), label: `${days} jours` })),
        onChange: (value) => changeSettings({ keep: Number(value) }),
      },
      {
        id: "copy",
        type: "item",
        label: "Copie dans un dossier",
        description:
          settings?.copyDir ?? "Recopiez chaque sauvegarde ailleurs : un disque externe, un dossier synchronisé.",
        actions: [
          {
            id: "choose",
            label: settings?.copyDir ? "Changer de dossier…" : "Choisir un dossier…",
            icon: icon(FolderOpen),
            isHidden: !inTauri,
            isDisabled: !settings,
            onPress: chooseCopyDir,
          },
          {
            id: "stop",
            label: "Ne plus recopier les sauvegardes",
            icon: icon(X),
            isHidden: !settings?.copyDir,
            onPress: () => changeOrReport({ copyDir: "" }),
          },
        ],
      },
      ...(modules.length > 0 && inTauri
        ? [
            {
              id: "module-data",
              type: "item" as const,
              label: "Données d’un module",
              description: "Pour les passer dans un autre espace ou sur un autre ordinateur.",
              actions: [
                { id: "export", label: "Exporter…", icon: icon(Download), onPress: () => setTransfer("export") },
                { id: "import", label: "Importer…", icon: icon(Upload), onPress: () => setTransfer("import") },
              ],
            },
          ]
        : []),
    ],
    content: (
      <>
        {error ? (
          <Alert announce tone="danger" title="Les sauvegardes n’ont pas pu être lues">
            {error}
          </Alert>
        ) : null}
        <Table
          label="Sauvegardes de l’espace de travail"
          columns={COLUMNS}
          rows={rows}
          density="compact"
          isLoading={loading && backups === undefined}
          rowActions={(backup) => [
            {
              icon: icon(MoreHorizontal),
              label: `Actions de la sauvegarde du ${backup.when}`,
              menu: (
                <>
                  <DropdownMenu.Section title="Restaurer">
                    <DropdownMenu.Item label="Toutes les données" onAction={() => void restore(backup)} />
                    {backup.modules.map((saved) => (
                      <DropdownMenu.Item
                        key={saved.id}
                        label={`Seulement « ${nameOf(saved.id)} »`}
                        onAction={() => void restore(backup, saved.id)}
                      />
                    ))}
                  </DropdownMenu.Section>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item label="Supprimer la sauvegarde" danger onAction={() => void remove(backup)} />
                </>
              ),
            },
          ]}
        />
        {transfer ? (
          <ModuleExportDialog
            modules={modules}
            onClose={() => setTransfer(undefined)}
            onImport={transfer === "import" ? (module) => void importModule(module) : undefined}
          />
        ) : null}
      </>
    ),
  };
}
