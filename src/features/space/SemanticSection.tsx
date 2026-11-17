import { Button, FeedbackBanner, Section, SettingRow, SettingRows, StatusBadge } from "@alfred/ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";

export interface SemanticModel {
  model: string;
  /** `missing` : l’installation n’a pas le modèle ; `broken` : il n’a pas pu être chargé. */
  status: "ready" | "missing" | "broken";
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Modèle local de la recherche par le sens : livré avec Alfred, rien à télécharger. */
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

  const problem = error
    ? `L’état du modèle n’a pas pu être lu : ${error}`
    : model?.status === "broken"
      ? `Le modèle n’a pas pu être chargé : ${model.error ?? "erreur inconnue"}. Réinstallez Alfred.`
      : model?.status === "missing"
        ? "Le modèle manque à cette installation d’Alfred. Réinstallez Alfred pour retrouver la recherche par le sens."
        : undefined;

  return (
    <Section
      title="Recherche par le sens"
      description="Les modules qui le prévoient retrouvent vos données par leur sens, même sans les mots exacts. Le calcul se fait sur cet ordinateur : rien n’est envoyé à un service."
    >
      {problem ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={error ? <Button onClick={() => void load()}>Réessayer</Button> : undefined}
        >
          {problem}
        </FeedbackBanner>
      ) : null}
      <SettingRows label="Modèle de recherche par le sens">
        <SettingRow
          title="Modèle de langue local"
          badge={
            model?.status === "ready" ? (
              <StatusBadge tone="success" size="compact">
                Prêt
              </StatusBadge>
            ) : null
          }
          description={`${model?.model ?? "multilingual-e5-small"}, français compris. Livré avec Alfred : rien à télécharger. Les données des modules s’indexent en arrière-plan.`}
        />
      </SettingRows>
    </Section>
  );
}
