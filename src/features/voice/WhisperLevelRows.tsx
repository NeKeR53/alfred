import { Button, Row, SettingRow, StatusBadge, useConfirm } from "@alfred/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const { confirm, confirmDialog } = useConfirm();
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
    const version = level.installed && level.revision ? ` Version ${level.revision}.` : "";
    return `${size} · ${level.summary}${version}`;
  };

  const remove = async (level: WhisperLevel, current: boolean) => {
    const accepted = await confirm({
      title: `Supprimer Whisper ${level.id} ?`,
      message: current
        ? `Le fichier (${formatSize(level.bytes)}) est effacé de cet ordinateur. C’est le niveau de la dictée : elle ne marchera plus tant qu’un autre niveau n’est pas choisi ou que celui-ci n’est pas téléchargé à nouveau.`
        : `Le fichier (${formatSize(level.bytes)}) est effacé de cet ordinateur. Il pourra être téléchargé à nouveau.`,
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (!accepted) return;
    await run(() => removeWhisperLevel(level.id), "Le niveau de Whisper n’a pas été supprimé");
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
              ) : level.installed ? (
                <StatusBadge size="compact">Téléchargé</StatusBadge>
              ) : recommended ? (
                <StatusBadge size="compact" title={levels.recommendedReason}>
                  Conseillé
                </StatusBadge>
              ) : null
            }
            description={describe(level)}
          >
            {level.installed ? (
              <Row gap="xs">
                {current ? null : (
                  <Button
                    variant="secondary"
                    aria-label={`Utiliser Whisper ${level.id}`}
                    onClick={() =>
                      void run(() => chooseWhisperLevel(level.id), "Le niveau de Whisper n’a pas été choisi")
                    }
                  >
                    Utiliser
                  </Button>
                )}
                <Button
                  variant="secondary"
                  aria-label={`Supprimer Whisper ${level.id}`}
                  onClick={() => void remove(level, current)}
                >
                  Supprimer
                </Button>
              </Row>
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
        <Row gap="xs">
          <PathField
            label="Fichier du modèle Whisper"
            value={levels.custom ?? ""}
            placeholder="~/models/ggml-large-v3-turbo.bin"
            onCommit={async (path) => {
              await onCustom(path);
              await load();
            }}
          />
          {levels.custom && !usingCustom ? (
            <Button
              variant="secondary"
              aria-label="Utiliser le fichier existant"
              onClick={async () => {
                await onCustom(levels.custom ?? "");
                await load();
              }}
            >
              Utiliser
            </Button>
          ) : null}
        </Row>
      </SettingRow>
      {confirmDialog}
    </>
  );
}
