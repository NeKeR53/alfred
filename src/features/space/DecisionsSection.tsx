import type { SettingsSection } from "socle-ui";
import { downloadProgress, type LocalModel, useLocalModelSection } from "./SemanticSection";

export type DecisionsModel = LocalModel;

/** Modèle local des décisions (`ai.decide`) : téléchargé une fois, avec l’accord de l’utilisateur. */
export function useDecisionsSection(): SettingsSection {
  return useLocalModelSection({
    id: "decisions",
    command: "decisions",
    event: "decisions:changed",
    title: "Décisions locales",
    description:
      "Les pages et les fonctions qui le prévoient classent un message, trient une demande ou répondent par oui ou non, avec leur degré de certitude. Le calcul se fait sur cet ordinateur : rien n’est envoyé à un service.",
    rowLabel: "Modèle de décision local",
    describe: (model) => {
      const progress = downloadProgress(model);
      const size = `${model?.sizeMb ?? 647} Mo`;
      if (model?.status === "ready")
        return `Prêt. Les pages et les fonctions qui le prévoient trient et décident sur cet ordinateur.${model.revision ? ` Version ${model.revision}.` : ""}`;
      if (model?.status === "downloading") return `Téléchargement en cours${progress ? ` : ${progress}` : "…"}`;
      if (model?.status === "damaged")
        return model.damaged ?? `Le modèle est abîmé : téléchargez-le à nouveau (environ ${size}).`;
      return `Environ ${size} à télécharger une seule fois (${model?.model ?? "convaiinnovations/laya-multilingual"}, français compris).`;
    },
  });
}
