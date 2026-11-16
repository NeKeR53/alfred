import { IconButton } from "@alfred/ui";
import { LoaderCircle, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useEffect } from "react";
import { useVoice } from "./store";
import "./voice.css";

/**
 * Voix dans le composer de l’agent : un interrupteur qui active ou coupe la voix (et arrête la lecture en cours),
 * puis le micro. Un clic sur le micro ouvre la dictée (et coupe la lecture), un second la termine et remet la
 * transcription à `onTranscript`. Le micro est absent tant que la dictée n’est pas réglée ou qu’elle est bloquée (Réglages › Voix).
 */
export function DictationButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const status = useVoice((state) => state.status);
  const dictation = useVoice((state) => state.dictation);
  const level = useVoice((state) => state.level);
  const speaking = useVoice((state) => state.speaking);
  const start = useVoice((state) => state.startDictation);
  const finish = useVoice((state) => state.finishDictation);
  const stopReading = useVoice((state) => state.stopReading);
  const setEnabled = useVoice((state) => state.setEnabled);

  useEffect(() => {
    void useVoice.getState().refresh();
  }, []);

  if (!status) return null;

  // Pendant une lecture, l’interrupteur l’arrête ; sinon il active ou coupe la voix.
  const toggle = speaking ? (
    <IconButton label="Arrêter la lecture" tooltip="Arrêter la lecture" onClick={() => void stopReading()}>
      <Volume2 size={14} className="voice-toggle--speaking" aria-hidden="true" />
    </IconButton>
  ) : (
    <IconButton
      label={status.enabled ? "Couper la voix" : "Activer la voix"}
      tooltip={status.enabled ? "Voix activée · cliquer pour la couper" : "Voix coupée · cliquer pour l’activer"}
      aria-pressed={status.enabled}
      onClick={() => void setEnabled(!status.enabled)}
    >
      {status.enabled ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
    </IconButton>
  );

  // Dictée bloquée (Réglages › Voix) : pas de micro, la lecture reste possible.
  if (!status.enabled || status.dictation === false || (!status.configured && dictation === "idle")) return toggle;

  if (dictation === "starting" || dictation === "transcribing")
    return (
      <IconButton
        label={dictation === "starting" ? "Ouverture du micro" : "Transcription en cours"}
        tooltip={dictation === "starting" ? "Chargement du modèle…" : "Transcription…"}
        disabled
      >
        <LoaderCircle size={14} className="voice-dictation__spin" aria-hidden="true" />
      </IconButton>
    );

  if (dictation === "listening")
    return (
      <IconButton
        className="voice-dictation voice-dictation--listening"
        label="Terminer la dictée et envoyer"
        tooltip="Terminer et envoyer · Échap annule"
        style={{ "--voice-level": level.toFixed(2) } as CSSProperties}
        onClick={async () => {
          const text = await finish();
          if (text) onTranscript(text);
        }}
      >
        <Square size={11} aria-hidden="true" />
      </IconButton>
    );

  return (
    <>
      {toggle}
      <IconButton
        className="voice-dictation"
        label="Dicter un message"
        tooltip={status.listenError ?? "Dicter"}
        disabled={Boolean(status.listenError)}
        onClick={() => void start()}
      >
        <Mic size={14} aria-hidden="true" />
      </IconButton>
    </>
  );
}
