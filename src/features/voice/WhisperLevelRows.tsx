import { Check, Download, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenFormFunction, Setting } from "socle-ui";
import { notify } from "../../shell/notifications";
import { formatSize } from "../space/BackupsSection";
import {
  chooseWhisperLevel,
  downloadWhisperLevel,
  getWhisperLevels,
  onWhisperLevels,
  removeWhisperLevel,
  type WhisperLevel,
  type WhisperLevels,
} from "./api";
import { pathSetting } from "./PathField";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const icon = (Icon: typeof Check) => <Icon size={16} aria-hidden="true" />;

/**
 * Niveaux de Whisper, en lignes de la section Dictée : chacun avec sa taille et ce qu’il apporte. Un niveau
 * téléchargé se choisit d’un clic ; un autre se télécharge par la source des modèles, puis sert aussitôt. En
 * dernier, un fichier ggml déjà sur l’ordinateur.
 */
export function useWhisperLevelRows({
  onChanged,
  onCustom,
  openForm,
}: {
  /** Le niveau choisi a changé côté Alfred : relire les réglages et l’état de la voix. */
  onChanged: () => void;
  /** Un fichier ggml indiqué à la main, à la place d’un niveau. */
  onCustom: (path: string) => Promise<void>;
  openForm: OpenFormFunction;
}): Setting[] {
  const [levels, setLevels] = useState<WhisperLevels>();
  const [error, setError] = useState<string>();
  // Niveau choisi à la dernière lecture : un changement fait côté Alfred (fin d’un téléchargement) est signalé.
  const known = useRef<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await getWhisperLevels();
      if (known.current !== undefined && known.current !== next.current) onChanged();
      known.current = next.current;
      setLevels(next);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [onChanged]);

  useEffect(() => {
    void load();
    return onWhisperLevels(() => void load());
  }, [load]);

  // Pendant un téléchargement, la progression se relit chaque seconde.
  const downloading = levels?.downloading?.level;
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const run = async (action: () => Promise<WhisperLevels>, failureTitle: string) => {
    try {
      const next = await action();
      known.current = next.current;
      setLevels(next);
      onChanged();
    } catch (failure) {
      notify({ title: failureTitle, description: errorMessage(failure), tone: "error" });
    }
  };

  if (error) {
    return [
      {
        id: "whisper",
        type: "info",
        label: "Modèle Whisper",
        value: `Les niveaux de Whisper n’ont pas pu être lus : ${error}`,
      },
    ];
  }
  if (!levels) return [{ id: "whisper", type: "info", label: "Modèle Whisper", value: "Chargement des niveaux…" }];

  const describe = (level: WhisperLevel) => {
    if (levels.downloading?.level === level.id) {
      const { received, total } = levels.downloading;
      return `Téléchargement : ${formatSize(received)} sur ${formatSize(total)}.`;
    }
    if (levels.error?.level === level.id) return `Le téléchargement a échoué : ${levels.error.message}`;
    const version = level.installed && level.revision ? ` Version ${level.revision}.` : "";
    const advice = levels.recommended === level.id && levels.recommendedReason ? ` ${levels.recommendedReason}` : "";
    return `${formatSize(level.bytes)} · ${level.summary}${version}${advice}`;
  };

  const usingCustom = levels.current === null && levels.custom !== null;

  const rows: Setting[] = levels.levels.map((level) => {
    const current = levels.current === level.id;
    const busy = levels.downloading?.level === level.id;
    return {
      id: `whisper-${level.id}`,
      type: "item",
      label: `Whisper ${level.id}`,
      description: describe(level),
      tags: current
        ? [{ label: "Utilisé", tone: "success" }]
        : level.installed
          ? [{ label: "Téléchargé", tone: "neutral" }]
          : levels.recommended === level.id
            ? [{ label: "Conseillé", tone: "info" }]
            : undefined,
      actions: level.installed
        ? [
            {
              id: "use",
              label: `Utiliser Whisper ${level.id}`,
              icon: icon(Check),
              isHidden: current,
              onPress: () => run(() => chooseWhisperLevel(level.id), "Le niveau de Whisper n’a pas été choisi"),
            },
            {
              id: "remove",
              label: `Supprimer Whisper ${level.id}`,
              icon: icon(Trash2),
              confirm: {
                title: `Supprimer Whisper ${level.id} ?`,
                message: current
                  ? `Le fichier (${formatSize(level.bytes)}) est effacé de cet ordinateur. C’est le niveau de la dictée : elle ne marchera plus tant qu’un autre niveau n’est pas choisi ou que celui-ci n’est pas téléchargé à nouveau.`
                  : `Le fichier (${formatSize(level.bytes)}) est effacé de cet ordinateur. Il pourra être téléchargé à nouveau.`,
                confirmLabel: "Supprimer",
              },
              onPress: () => run(() => removeWhisperLevel(level.id), "Le niveau de Whisper n’a pas été supprimé"),
            },
          ]
        : [
            {
              id: "download",
              label: `${levels.error?.level === level.id ? "Réessayer" : "Télécharger"} Whisper ${level.id}`,
              icon: icon(Download),
              isDisabled: Boolean(levels.downloading) && !busy,
              onPress: () => run(() => downloadWhisperLevel(level.id), "Le téléchargement de Whisper n’a pas commencé"),
            },
          ],
    };
  });

  const custom = pathSetting({
    id: "whisper-custom",
    label: "Fichier existant",
    description: "Un modèle ggml déjà sur cet ordinateur, à la place d’un niveau téléchargé par Alfred.",
    value: levels.custom ?? "",
    placeholder: "~/models/ggml-large-v3-turbo.bin",
    clearable: false,
    openForm,
    onCommit: async (path) => {
      await onCustom(path);
      await load();
    },
  });
  rows.push({
    ...custom,
    tags: usingCustom ? [{ label: "Utilisé", tone: "success" }] : undefined,
    actions: [
      {
        id: "use-custom",
        label: "Utiliser le fichier existant",
        icon: icon(Check),
        isHidden: !levels.custom || usingCustom,
        onPress: async () => {
          await onCustom(levels.custom ?? "");
          await load();
        },
      },
      ...(custom.actions ?? []),
    ],
  });
  return rows;
}
