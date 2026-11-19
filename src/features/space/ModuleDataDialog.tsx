/**
 * Exporter les données d’un module : une petite modale qui dit quoi (le module), où (l’emplacement choisi à l’étape
 * suivante) et sous quelle forme (un fichier .json), avec un seul bouton principal. Une fois l’export fait, elle dit
 * « Exporté vers … » et propose d’afficher le fichier dans le gestionnaire de fichiers.
 */
import { Button, FormField, KeyValueList, Modal, SelectControl, Stack, Text } from "@alfred/ui";
import { useState } from "react";
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
      <Modal
        open
        size="small"
        onClose={onClose}
        title="Données exportées"
        actions={
          <>
            <Button onClick={() => void reveal(done)}>Afficher dans {fileManager(platform)}</Button>
            <Button variant="primary" onClick={onClose}>
              Terminer
            </Button>
          </>
        }
      >
        <Text>
          Exporté vers <strong>{done}</strong>
        </Text>
      </Modal>
    );

  return (
    <Modal
      open
      size="small"
      onClose={onClose}
      busy={pending}
      title={onImport ? "Importer des données" : "Exporter les données"}
      description={
        onImport
          ? "Les données actuelles du module sont remplacées par celles du fichier ; Alfred les sauvegarde d’abord."
          : "Pour les reprendre dans un autre espace de travail ou sur un autre ordinateur."
      }
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>
            Annuler
          </Button>
          <Button
            variant="primary"
            loading={pending}
            loadingLabel="Export…"
            disabled={!module}
            onClick={() => void exportNow()}
          >
            {onImport ? "Choisir le fichier…" : "Exporter…"}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {modules.length > 1 ? (
          <FormField label="Module">
            <SelectControl value={module} onChange={(event) => setModule(event.target.value)} disabled={pending}>
              {modules.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </SelectControl>
          </FormField>
        ) : null}
        <KeyValueList
          items={[
            ...(modules.length > 1 ? [] : [{ label: "Module", value: name }]),
            { label: "Contenu", value: "Ses tables et ses fichiers" },
            { label: "Format", value: "Un fichier .json" },
            {
              label: onImport ? "D’où" : "Où",
              value: onImport
                ? "Le fichier d’un export, choisi à l’étape suivante"
                : "Vous choisissez l’emplacement à l’étape suivante",
            },
          ]}
        />
        {error ? <Text tone="danger">L’export a échoué : {error}</Text> : null}
      </Stack>
    </Modal>
  );
}
