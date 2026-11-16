import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  IconButton,
  LoadingSkeleton,
  MenuGroup,
  MenuItem,
  OverflowMenu,
  RefreshButton,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  type useConfirm,
} from "@alfred/ui";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { inTauri, invoke, onNativeEvent, pickFile, pickFolder, pickSaveFile } from "../../lib/native";
import type { Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";

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

/**
 * Sauvegardes des données des modules (base et fichiers, hors de l’historique git) : réglages, liste des copies,
 * restauration de tout l’espace de travail ou d’un module, export et import des données d’un module.
 */
export function BackupsSection({
  snapshot,
  confirm,
}: {
  snapshot: Snapshot;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [backups, setBackups] = useState<BackupInfo[]>();
  const [settings, setSettings] = useState<BackupSettings>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [module, setModule] = useState(snapshot.modules[0]?.id ?? "");

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
  }, []);

  useEffect(() => {
    void load();
    return onNativeEvent("backups:changed", () => void load());
  }, [load]);

  if (!snapshot.modules.some((candidate) => candidate.id === module) && snapshot.modules[0]) {
    setModule(snapshot.modules[0].id);
  }

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const changeSettings = (next: Partial<BackupSettings>) =>
    run("settings", async () => {
      try {
        setSettings(await invoke<BackupSettings>("backups.setSettings", next));
      } catch (failure) {
        notify({ title: "Le réglage n’a pas été changé", description: errorMessage(failure), tone: "error" });
      }
    });

  const chooseCopyDir = async () => {
    const dir = await pickFolder("Dossier où recopier les sauvegardes");
    if (dir) await changeSettings({ copyDir: dir });
  };

  const backupNow = () =>
    run("create", async () => {
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
    });

  const restore = async (backup: BackupInfo, target?: string) => {
    const what = target
      ? `les données du module « ${moduleName(snapshot, target)} »`
      : "toutes les données des modules";
    const confirmed = await confirm({
      title: `Restaurer ${what} au ${formatDate(backup.createdAt)} ?`,
      message: target
        ? "Les tables et les fichiers de ce module reviennent à leur état de cette sauvegarde ; les autres modules ne changent pas. Alfred sauvegarde d’abord l’état actuel, que vous pourrez restaurer à son tour."
        : "Les tables et les fichiers de tous les modules reviennent à leur état de cette sauvegarde. Alfred sauvegarde d’abord l’état actuel, que vous pourrez restaurer à son tour.",
      confirmLabel: "Restaurer",
      tone: "danger",
    });
    if (!confirmed) return;
    await run(`restore:${backup.id}`, async () => {
      try {
        await invoke("backups.restore", { id: backup.id, ...(target ? { module: target } : {}) });
        notify({ title: "Données restaurées", description: formatDate(backup.createdAt), tone: "success" });
        await load();
      } catch (failure) {
        notify({ title: "La restauration a échoué", description: errorMessage(failure), tone: "error" });
      }
    });
  };

  const remove = async (backup: BackupInfo) => {
    const confirmed = await confirm({
      title: `Supprimer la sauvegarde du ${formatDate(backup.createdAt)} ?`,
      message: "Elle ne pourra plus être restaurée. Les copies déjà faites dans le dossier choisi restent.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!confirmed) return;
    await run(`delete:${backup.id}`, async () => {
      try {
        await invoke("backups.delete", { id: backup.id });
        await load();
      } catch (failure) {
        notify({ title: "La sauvegarde n’a pas été supprimée", description: errorMessage(failure), tone: "error" });
      }
    });
  };

  const exportModule = () =>
    run("export", async () => {
      const day = new Date().toISOString().slice(0, 10);
      const path = await pickSaveFile("Exporter les données du module", `${module}-${day}.json`);
      if (!path) return;
      try {
        await invoke("backups.exportModule", { module, path });
        notify({ title: "Données exportées", description: path, tone: "success" });
      } catch (failure) {
        notify({ title: "L’export a échoué", description: errorMessage(failure), tone: "error" });
      }
    });

  const importModule = async () => {
    const path = await pickFile("Importer des données dans le module");
    if (!path) return;
    const confirmed = await confirm({
      title: `Remplacer les données du module « ${moduleName(snapshot, module)} » ?`,
      message:
        "Les lignes et les fichiers actuels du module sont remplacés par ceux du fichier. Alfred sauvegarde d’abord l’état actuel.",
      confirmLabel: "Importer",
      tone: "danger",
    });
    if (!confirmed) return;
    await run("import", async () => {
      try {
        await invoke("backups.importModule", { module, path });
        notify({ title: "Données importées", description: moduleName(snapshot, module), tone: "success" });
        await useShell.getState().refresh();
      } catch (failure) {
        notify({ title: "L’import a échoué", description: errorMessage(failure), tone: "error" });
      }
    });
  };

  const columns: DataTableColumn<BackupInfo>[] = [
    {
      key: "createdAt",
      header: "Date",
      width: "150px",
      render: (backup) => formatDate(backup.createdAt),
      sortValue: (backup) => backup.createdAt,
    },
    {
      key: "reason",
      header: "Type",
      render: (backup) =>
        backup.note ? `${REASON_LABEL[backup.reason]} (${backup.note})` : REASON_LABEL[backup.reason],
      sortValue: (backup) => backup.reason,
    },
    {
      key: "size",
      header: "Taille",
      width: "80px",
      align: "end",
      render: (backup) => formatSize(backup.size),
      sortValue: (backup) => backup.size,
    },
    {
      key: "actions",
      header: "Actions",
      width: "72px",
      align: "end",
      sortable: false,
      render: (backup) => (
        <OverflowMenu
          size="small"
          label={`Actions de la sauvegarde du ${formatDate(backup.createdAt)}`}
          tooltip="Restaurer ou supprimer"
          disabled={busy !== null}
        >
          <MenuGroup label="Restaurer">
            <MenuItem onClick={() => void restore(backup)}>Toutes les données</MenuItem>
            {backup.modules.map((saved) => (
              <MenuItem key={saved.id} onClick={() => void restore(backup, saved.id)}>
                Seulement « {moduleName(snapshot, saved.id)} »
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuItem tone="danger" onClick={() => void remove(backup)}>
            Supprimer la sauvegarde
          </MenuItem>
        </OverflowMenu>
      ),
    },
  ];

  return (
    <Section
      title="Sauvegardes"
      description="Les données des modules (leurs tables et leurs fichiers) ne font pas partie de l’historique. Alfred les copie chaque jour et avant chaque changement de structure d’un module."
      actions={
        <>
          <RefreshButton label="Actualiser les sauvegardes" loading={loading} onClick={() => void load()} />
          <Button loading={busy === "create"} loadingLabel="Sauvegarde…" disabled={busy !== null} onClick={backupNow}>
            Sauvegarder maintenant
          </Button>
        </>
      }
    >
      {error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          Les sauvegardes n’ont pas pu être lues : {error}
        </FeedbackBanner>
      ) : null}
      <SettingRows label="Réglages des sauvegardes">
        <SettingRow
          title="Copies quotidiennes gardées"
          description="Les plus anciennes sont supprimées au fur et à mesure."
        >
          <SelectControl
            aria-label="Copies quotidiennes gardées"
            value={String(settings?.keep ?? 14)}
            disabled={!settings || busy !== null}
            onChange={(event) => void changeSettings({ keep: Number(event.target.value) })}
          >
            {[...new Set([...KEEP_CHOICES, settings?.keep ?? 14])]
              .sort((a, b) => a - b)
              .map((count) => (
                <option key={count} value={count}>
                  {count} jours
                </option>
              ))}
          </SelectControl>
        </SettingRow>
        <SettingRow
          title="Copie dans un dossier"
          description={
            settings?.copyDir ? (
              <span title={settings.copyDir}>{settings.copyDir}</span>
            ) : (
              "Recopiez chaque sauvegarde ailleurs : un disque externe, un dossier synchronisé."
            )
          }
        >
          {inTauri ? (
            <Button disabled={!settings || busy !== null} onClick={() => void chooseCopyDir()}>
              {settings?.copyDir ? "Changer…" : "Choisir un dossier…"}
            </Button>
          ) : null}
          {settings?.copyDir ? (
            <IconButton
              size="small"
              label="Ne plus recopier les sauvegardes"
              tooltip="Ne plus recopier"
              disabled={busy !== null}
              onClick={() => void changeSettings({ copyDir: "" })}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          ) : null}
        </SettingRow>
        {snapshot.modules.length > 0 ? (
          <SettingRow
            title="Données d’un module"
            description="Un fichier pour passer les données d’un module dans un autre espace ou sur un autre ordinateur."
          >
            <SelectControl
              aria-label="Module à exporter ou importer"
              value={module}
              onChange={(event) => setModule(event.target.value)}
            >
              {snapshot.modules.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </SelectControl>
            {inTauri ? (
              <>
                <Button loading={busy === "export"} disabled={busy !== null} onClick={() => void exportModule()}>
                  Exporter…
                </Button>
                <Button loading={busy === "import"} disabled={busy !== null} onClick={() => void importModule()}>
                  Importer…
                </Button>
              </>
            ) : null}
          </SettingRow>
        ) : null}
      </SettingRows>
      {backups === undefined ? (
        error ? null : (
          <LoadingSkeleton rows={3} label="Chargement des sauvegardes…" />
        )
      ) : backups.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucune sauvegarde"
          description="La première copie est faite dès qu’un module a des données."
        />
      ) : (
        <DataTable
          label="Sauvegardes de l’espace de travail"
          columns={columns}
          rows={backups}
          rowKey={(backup) => backup.id}
          loading={loading}
        />
      )}
    </Section>
  );
}
