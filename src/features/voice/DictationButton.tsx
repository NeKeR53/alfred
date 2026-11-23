import { Mic, Square, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useEffect, useRef } from "react";
import { IconButton } from "socle-ui";
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

  // Après avoir parlé, une pause assez longue termine la dictée et envoie le message, comme un clic sur le bouton.
  const pause = status?.pauseSendMs ?? 0;
  const deliver = useRef(onTranscript);
  deliver.current = onTranscript;
  useEffect(() => {
    if (dictation !== "listening" || pause <= 0) return;
    const timer = setInterval(() => {
      const { heardAt, dictation: current } = useVoice.getState();
      if (current !== "listening" || heardAt === null || Date.now() - heardAt < pause) return;
      clearInterval(timer);
      void finish().then((text) => {
        if (text) deliver.current(text);
      });
    }, 150);
    return () => clearInterval(timer);
  }, [dictation, pause, finish]);

  if (!status) return null;

  // Pendant une lecture, l’interrupteur l’arrête ; sinon il active ou coupe la voix.
  const toggle = speaking ? (
    <IconButton
      icon={<Volume2 size={14} className="voice-toggle--speaking" aria-hidden="true" />}
      label="Arrêter la lecture"
      onPress={() => void stopReading()}
    />
  ) : (
    <IconButton
      icon={status.enabled ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
      label={status.enabled ? "Couper la voix" : "Activer la voix"}
      isSelected={status.enabled}
      onChange={(enabled) => void setEnabled(enabled)}
    />
  );

  // Dictée bloquée (Réglages › Voix) : pas de micro, la lecture reste possible.
  if (!status.enabled || status.dictation === false || (!status.configured && dictation === "idle")) return toggle;

  if (dictation === "starting" || dictation === "transcribing")
    return (
      <IconButton
        icon={<Mic size={14} aria-hidden="true" />}
        label={dictation === "starting" ? "Ouverture du micro" : "Transcription en cours"}
        isPending
      />
    );

  if (dictation === "listening")
    return (
      // L’anneau autour du bouton suit le niveau du micro : il est porté par l’enveloppe, pas par le bouton.
      <span className="voice-dictation--listening" style={{ "--voice-level": level.toFixed(2) } as CSSProperties}>
        <IconButton
          icon={<Square size={11} aria-hidden="true" />}
          label="Terminer la dictée et envoyer"
          onPress={async () => {
            const text = await finish();
            if (text) onTranscript(text);
          }}
        />
      </span>
    );

  return (
    <>
      {toggle}
      <IconButton
        icon={<Mic size={14} aria-hidden="true" />}
        label="Dicter un message"
        isDisabled={Boolean(status.listenError)}
        onPress={() => void start()}
      />
    </>
  );
}
