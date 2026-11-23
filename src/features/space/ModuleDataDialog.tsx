/**
 * Exporter les données d’un module : une petite modale qui dit quoi (le module), où (l’emplacement choisi à l’étape
 * suivante) et sous quelle forme (un fichier .json), avec un seul bouton principal. Une fois l’export fait, elle dit
 * « Exporté vers … » et propose d’afficher le fichier dans le gestionnaire de fichiers.
 */
import { useState } from "react";
import { Button, Code, Dialog, PropertyRow, Select } from "socle-ui";
import { Notice, Stack, Text } from "../../kit";
import { invoke, pickSaveFile } from "../../lib/native";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage } from "../vault/api";

/** Nom du gestionnaire de fichiers du système, pour le libellé du bouton. */
export function fileManager(platform: string | undefined): string {
  if (platform === "macos") return "le Finder";
  if (platform === "windows") return "l’Explorateur";
  return "le gestionnaire de fichiers";
}

export function ModuleExportDialog({
  modules,
  initial,
  onClose,
  onImport,
}: {
  modules: ModuleSummary[];
  /** Module proposé d’abord (celui de la fiche) ; le premier sinon. */
  initial?: string;
  onClose: () => void;
  /** Mode import : le module choisi, à qui le parent fait choisir le fichier puis confirmer le remplacement. */
  onImport?: (module: string) => void;
}) {
  const platform = useShell((state) => state.info?.platform);
  const [module, setModule] = useState(initial ?? modules[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const name = modules.find((candidate) => candidate.id === module)?.name ?? module;

  const exportNow = async () => {
    if (onImport) {
      onImport(module);
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const path = await pickSaveFile(`Exporter les données de ${name}`, `${module}-${day}.json`);
    if (!path) return;
    setPending(true);
    setError(undefined);
    try {
      await invoke("backups.exportModule", { module, path });
      setDone(path);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  const reveal = async (path: string) => {
    try {
      await invoke("files.reveal", { path });
    } catch (failure) {
      notify({ title: "Le fichier n’a pas pu être affiché", description: errorMessage(failure), tone: "error" });
    }
  };

  if (done)
    return (
      <Dialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        size="sm"
        title="Données exportées"
        footer={
          <>
            <Button onPress={() => void reveal(done)}>{`Afficher dans ${fileManager(platform)}`}</Button>
            <Button variant="primary" onPress={onClose}>
              Terminer
            </Button>
          </>
        }
      >
        <Stack gap="xs">
          <Text>Exporté vers :</Text>
          <Code>{done}</Code>
        </Stack>
      </Dialog>
    );

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      isBusy={pending}
      title={onImport ? "Importer des données" : "Exporter les données"}
      description={
        onImport
          ? "Les données actuelles du module sont remplacées par celles du fichier ; Alfred les sauvegarde d’abord."
          : "Pour les reprendre dans un autre espace de travail ou sur un autre ordinateur."
      }
      footer={
        <>
          <Button onPress={onClose} isDisabled={pending}>
            Annuler
          </Button>
          <Button variant="primary" isPending={pending} isDisabled={!module} onPress={() => void exportNow()}>
            {onImport ? "Choisir le fichier…" : "Exporter…"}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {modules.length > 1 ? (
          <Select
            label="Module"
            isRequired
            value={module}
            isDisabled={pending}
            options={modules.map((candidate) => ({ id: candidate.id, label: candidate.name }))}
            onChange={(id) => setModule(id ?? "")}
          />
        ) : null}
        <div>
          {modules.length > 1 ? null : <PropertyRow label="Module" value={name} />}
          <PropertyRow label="Contenu" value="Ses tables et ses fichiers" />
          <PropertyRow label="Format" value="Un fichier .json" />
          <PropertyRow
            label={onImport ? "D’où" : "Où"}
            value={
              onImport
                ? "Le fichier d’un export, choisi à l’étape suivante"
                : "Vous choisissez l’emplacement à l’étape suivante"
            }
          />
        </div>
        {error ? (
          <Notice tone="danger" title="L’export a échoué">
            {error}
          </Notice>
        ) : null}
      </Stack>
    </Dialog>
  );
}
