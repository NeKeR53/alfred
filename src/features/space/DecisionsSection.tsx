import { Button, FeedbackBanner, Section, SettingRow, SettingRows } from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { formatSize } from "./BackupsSection";

export interface DecisionsModel {
  model: string;
  sizeMb: number;
  status: "ready" | "missing" | "downloading" | "damaged";
  received: number | null;
  total: number | null;
  error: string | null;
  damaged: string | null;
  /** Révision installée, en court (`92d2214`). */
  revision?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Modèle local des décisions (`ai.decide`) : téléchargé une fois, avec l’accord de l’utilisateur. */
export function DecisionsSection() {
  const [model, setModel] = useState<DecisionsModel>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setModel(await invoke<DecisionsModel>("decisions.model"));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
    return onNativeEvent("decisions:changed", () => void load());
  }, [load]);

  // Pendant le téléchargement, la progression se relit chaque seconde.
  useEffect(() => {
    if (model?.status !== "downloading") return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [model?.status, load]);

  const download = async () => {
    try {
      setModel(await invoke<DecisionsModel>("decisions.download"));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const progress =
    model?.status === "downloading" && model.received !== null && model.total
      ? `${formatSize(model.received)} sur ${formatSize(model.total)}`
      : undefined;
  const size = `${model?.sizeMb ?? 647} Mo`;
  const description =
    model?.status === "ready"
      ? `Prêt. Les pages et les fonctions qui le prévoient trient et décident sur cet ordinateur.${model.revision ? ` Version ${model.revision}.` : ""}`
      : model?.status === "downloading"
        ? `Téléchargement en cours${progress ? ` : ${progress}` : "…"}`
        : model?.status === "damaged"
          ? (model.damaged ?? `Le modèle est abîmé : téléchargez-le à nouveau (environ ${size}).`)
          : `Environ ${size} à télécharger une seule fois (${model?.model ?? "convaiinnovations/laya-multilingual"}, français compris).`;

  return (
    <Section
      title="Décisions locales"
      description="Les pages et les fonctions qui le prévoient classent un message, trient une demande ou répondent par oui ou non, avec leur degré de certitude. Le calcul se fait sur cet ordinateur : rien n’est envoyé à un service."
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
      <SettingRows label="Modèle de décision">
        <SettingRow title="Modèle de décision local" description={description}>
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
