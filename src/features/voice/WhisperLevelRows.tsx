import { Button, SettingRow, StatusBadge } from "@alfred/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "../../shell/notifications";
import { formatSize } from "../space/BackupsSection";
import {
  chooseWhisperLevel,
  downloadWhisperLevel,
  getWhisperLevels,
  onWhisperLevels,
  type WhisperLevel,
  type WhisperLevels,
} from "./api";
import { PathField } from "./PathField";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Niveaux de Whisper, dans les lignes de la section Dictée : chacun avec sa taille et ce qu’il apporte. Un niveau
 * téléchargé se choisit d’un clic ; un autre se télécharge par la source des modèles, puis sert aussitôt. En
 * dernier, un fichier ggml déjà sur l’ordinateur.
 */
export function WhisperLevelRows({
  onChanged,
  onCustom,
}: {
  /** Le niveau choisi a changé côté Alfred : relire les réglages et l’état de la voix. */
  onChanged: () => void;
  /** Un fichier ggml indiqué à la main, à la place d’un niveau. */
  onCustom: (path: string) => Promise<void>;
}) {
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
    return (
      <SettingRow title="Modèle Whisper" description={`Les niveaux de Whisper n’ont pas pu être lus : ${error}`} />
    );
  }
  if (!levels) return <SettingRow title="Modèle Whisper" description="Chargement des niveaux…" />;

  const describe = (level: WhisperLevel) => {
    const size = formatSize(level.bytes);
    if (levels.downloading?.level === level.id) {
      const { received, total } = levels.downloading;
      return `Téléchargement : ${formatSize(received)} sur ${formatSize(total)}.`;
    }
    if (levels.error?.level === level.id) return `Le téléchargement a échoué : ${levels.error.message}`;
    const version = level.installed && level.revision ? ` Téléchargé, version ${level.revision}.` : "";
    return `${size} · ${level.summary}${version}`;
  };

  const usingCustom = levels.current === null && levels.custom !== null;

  return (
    <>
      {levels.levels.map((level) => {
        const current = levels.current === level.id;
        const recommended = levels.recommended === level.id;
        const busy = levels.downloading?.level === level.id;
        return (
          <SettingRow
            key={level.id}
            title={`Whisper ${level.id}`}
            badge={
              current ? (
                <StatusBadge tone="success" size="compact">
                  Utilisé
                </StatusBadge>
              ) : recommended ? (
                <StatusBadge size="compact" title={levels.recommendedReason}>
                  Conseillé
                </StatusBadge>
              ) : null
            }
            description={describe(level)}
          >
            {current ? null : level.installed ? (
              <Button
                variant="secondary"
                onClick={() => void run(() => chooseWhisperLevel(level.id), "Le niveau de Whisper n’a pas été choisi")}
              >
                Utiliser
              </Button>
            ) : (
              <Button
                variant={recommended && !levels.current && !usingCustom ? "primary" : "secondary"}
                aria-label={`Télécharger Whisper ${level.id}`}
                disabled={Boolean(levels.downloading) && !busy}
                loading={busy}
                loadingLabel="Téléchargement…"
                onClick={() =>
                  void run(() => downloadWhisperLevel(level.id), "Le téléchargement de Whisper n’a pas commencé")
                }
              >
                {levels.error?.level === level.id ? "Réessayer" : "Télécharger"}
              </Button>
            )}
          </SettingRow>
        );
      })}
      <SettingRow
        title="Fichier existant"
        badge={
          usingCustom ? (
            <StatusBadge tone="success" size="compact">
              Utilisé
            </StatusBadge>
          ) : null
        }
        description="Un modèle ggml déjà sur cet ordinateur, à la place d’un niveau téléchargé par Alfred."
      >
        <PathField
          label="Fichier du modèle Whisper"
          value={levels.custom ?? ""}
          placeholder="~/models/ggml-large-v3-turbo.bin"
          onCommit={async (path) => {
            await onCustom(path);
            await load();
          }}
        />
      </SettingRow>
    </>
  );
}
