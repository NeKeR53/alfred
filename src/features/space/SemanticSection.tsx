import { useCallback, useEffect, useState } from "react";
import type { Setting, SettingsSection } from "socle-ui";
import { Alert } from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { formatSize } from "./BackupsSection";

/** État d’un modèle local téléchargé à la demande (recherche par le sens, décisions). */
export interface LocalModel {
  model: string;
  sizeMb: number;
  status: "ready" | "missing" | "downloading" | "damaged";
  received: number | null;
  total: number | null;
  error: string | null;
  /** Le modèle installé n’a pas pu être chargé (version au format non pris en charge). */
  damaged?: string | null;
  /** Révision installée, en court (`614241f`). */
  revision?: string | null;
}

export type SemanticModel = LocalModel;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Progression d’un téléchargement en cours, ou rien. */
export function downloadProgress(model: LocalModel | undefined): string | undefined {
  return model?.status === "downloading" && model.received !== null && model.total
    ? `${formatSize(model.received)} sur ${formatSize(model.total)}`
    : undefined;
}

/**
 * Lit l’état d’un modèle local, le relit à chaque événement et chaque seconde pendant un téléchargement, et le
 * décrit en une ligne de réglage : la description dit son état, l’action le télécharge.
 */
export function useLocalModelSection({
  id,
  command,
  event,
  title,
  description,
  rowLabel,
  describe,
}: {
  id: string;
  /** Préfixe des commandes : `semantic` donne `semantic.model` et `semantic.download`. */
  command: string;
  event: string;
  title: string;
  description: string;
  rowLabel: string;
  describe: (model: LocalModel | undefined) => string;
}): SettingsSection {
  const [model, setModel] = useState<LocalModel>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setModel(await invoke<LocalModel>(`${command}.model`));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [command]);

  useEffect(() => {
    void load();
    return onNativeEvent(event, () => void load());
  }, [load, event]);

  // Pendant le téléchargement, la progression se relit chaque seconde.
  useEffect(() => {
    if (model?.status !== "downloading") return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [model?.status, load]);

  const download = async () => {
    try {
      setModel(await invoke<LocalModel>(`${command}.download`));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const row: Setting =
    model?.status === "ready"
      ? {
          id: "model",
          type: "item",
          label: rowLabel,
          description: describe(model),
          tags: [{ label: "Installé", tone: "success" }],
        }
      : {
          id: "model",
          type: "action",
          label: rowLabel,
          description: describe(model),
          action: {
            id: "download",
            label: model?.status === "damaged" ? "Télécharger à nouveau" : "Télécharger",
            isDisabled: !model || model.status === "downloading",
            onPress: download,
          },
        };

  return {
    id,
    title,
    description,
    settings: [row],
    content:
      error || model?.error ? (
        <Alert
          tone="danger"
          title={model?.error ? "Le téléchargement a échoué" : "L’état du modèle n’a pas pu être lu"}
        >
          {model?.error ?? error}
        </Alert>
      ) : undefined,
  };
}

/** Modèle local de la recherche par le sens : téléchargé une fois, avec l’accord de l’utilisateur. */
export function useSemanticSection(): SettingsSection {
  return useLocalModelSection({
    id: "semantic",
    command: "semantic",
    event: "semantic:changed",
    title: "Recherche par le sens",
    description:
      "Les modules qui le prévoient retrouvent vos données par leur sens, même sans les mots exacts. Le calcul se fait sur cet ordinateur : rien n’est envoyé à un service.",
    rowLabel: "Modèle de langue local",
    describe: (model) => {
      const progress = downloadProgress(model);
      if (model?.status === "ready")
        return `Installé. Les données des modules s’indexent en arrière-plan.${model.revision ? ` Version ${model.revision}.` : ""}`;
      if (model?.status === "downloading") return `Téléchargement en cours${progress ? ` : ${progress}` : "…"}`;
      if (model?.status === "damaged" && model.damaged) return model.damaged;
      return `Environ ${model?.sizeMb ?? 470} Mo à télécharger une seule fois (${model?.model ?? "multilingual-e5-small"}, français compris).`;
    },
  });
}
