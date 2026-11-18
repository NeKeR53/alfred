import { Button, FeedbackBanner, Section, SettingRow, SettingRows } from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { formatSize } from "./BackupsSection";

export interface SemanticModel {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Modèle local de la recherche par le sens : téléchargé une fois, avec l’accord de l’utilisateur. */
export function SemanticSection() {
  const [model, setModel] = useState<SemanticModel>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setModel(await invoke<SemanticModel>("semantic.model"));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
    return onNativeEvent("semantic:changed", () => void load());
  }, [load]);

  // Pendant le téléchargement, la progression se relit chaque seconde.
  useEffect(() => {
    if (model?.status !== "downloading") return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [model?.status, load]);

  const download = async () => {
    try {
      setModel(await invoke<SemanticModel>("semantic.download"));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const progress =
    model?.status === "downloading" && model.received !== null && model.total
      ? `${formatSize(model.received)} sur ${formatSize(model.total)}`
      : undefined;

  return (
    <Section
      title="Recherche par le sens"
      description="Les modules qui le prévoient retrouvent vos données par leur sens, même sans les mots exacts. Le calcul se fait sur cet ordinateur : rien n’est envoyé à un service."
    >
      {error || model?.error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          {model?.error
            ? `Le téléchargement a échoué : ${model.error}`
            : `L’état du modèle n’a pas pu être lu : ${error}`}
        </FeedbackBanner>
      ) : null}
      <SettingRows label="Modèle de recherche par le sens">
        <SettingRow
          title="Modèle de langue local"
          description={
            model?.status === "ready"
              ? `Installé. Les données des modules s’indexent en arrière-plan.${model.revision ? ` Version ${model.revision}.` : ""}`
              : model?.status === "downloading"
                ? `Téléchargement en cours${progress ? ` : ${progress}` : "…"}`
                : model?.status === "damaged" && model.damaged
                  ? model.damaged
                  : `Environ ${model?.sizeMb ?? 470} Mo à télécharger une seule fois (${model?.model ?? "multilingual-e5-small"}, français compris).`
          }
        >
          {model?.status === "ready" ? null : (
            <Button
              variant="primary"
              disabled={!model}
              loading={model?.status === "downloading"}
              loadingLabel="Téléchargement…"
              onClick={() => void download()}
            >
              {model?.status === "damaged" ? "Télécharger à nouveau" : "Télécharger"}
            </Button>
          )}
        </SettingRow>
      </SettingRows>
    </Section>
  );
}
