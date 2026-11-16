/** Voix d’Alfred : dictée (Whisper local) et lecture à voix haute, servies par le backend (`voice.*`). */

import { invoke, onNativeEvent } from "../../lib/native";

/** `qwen` : la voix d’Alfred (Qwen3-TTS en local, voix clonée). */
export type TtsBackend = "qwen" | "system" | "kokoro";

export interface VoiceConfig {
  whisperModel: string;
  whisperServer: string;
  language: string;
  voice: string;
  /** Débit de la voix du système, en mots par minute (0 : celui de la voix). */
  rate: number;
  ttsBackend: TtsBackend;
  kokoroPython: string | null;
  kokoroModel: string | null;
  kokoroVoices: string | null;
  kokoroVoice: string;
  /** Python où qwen-tts est installé ; `null` : celui qu’Alfred installe. */
  qwenPython: string | null;
  qwenModel: string;
  /** Échantillon de la voix à cloner ; `null` : la voix d’Alfred. */
  qwenReference: string | null;
  qwenReferenceText: string;
  partialIntervalMs: number;
  /** Lire à voix haute la réponse de l’agent à une demande dictée. */
  readReplies: boolean;
  /** Voix active : coupée, ni dictée ni lecture, et rien ne reste chargé. */
  enabled: boolean;
  /** Dictée permise ; bloquée, le micro ne s’ouvre pour personne, même si l’on parle. */
  dictation: boolean;
  /** Lire à voix haute les notifications des pages et des fonctions de l’espace. */
  readNotifications: boolean;
}

export interface VoiceStatus {
  /** Un modèle Whisper est indiqué. */
  configured: boolean;
  /** Pourquoi la dictée ne peut pas démarrer ; `null` si elle le peut. */
  listenError: string | null;
  /** Pourquoi la lecture ne peut pas démarrer ; `null` si elle le peut. */
  speakError: string | null;
  listening: boolean;
  readReplies: boolean;
  enabled: boolean;
  dictation: boolean;
  readNotifications: boolean;
  /** La voix d’Alfred est installée (environnement Python de Qwen3-TTS). */
  qwenInstalled: boolean;
}

export type VoiceEvent =
  | { type: "level"; rms: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "speech_started" }
  | { type: "utterance"; text: string }
  | { type: "speech_finished"; interrupted: boolean }
  | { type: "error"; message: string };

export const getVoiceSettings = () => invoke<VoiceConfig>("voice.settings.get");
export const saveVoiceSettings = (config: VoiceConfig) => invoke<VoiceStatus>("voice.settings.set", { config });
export const getVoiceStatus = () => invoke<VoiceStatus>("voice.status");
/** Réglages vocaux d’Argos, s’il est installé ; rien n’est enregistré. */
export const importArgosVoice = () => invoke<VoiceConfig>("voice.importArgos");

export interface SystemVoice {
  id: string;
  label: string;
  /** Code de langue, « fr-FR ». */
  language: string;
}
export const listSystemVoices = () => invoke<SystemVoice[]>("voice.voices");

/** Installe la voix d’Alfred (quelques minutes) ; rend le nouvel état. */
export const installAlfredVoice = () => invoke<VoiceStatus>("voice.qwen.install");

/** Active ou coupe la voix ; rend le nouvel état. */
export const setVoiceEnabled = (enabled: boolean) => invoke<VoiceStatus>("voice.enabled.set", { enabled });

export interface VoicePreferences {
  dictation?: boolean;
  readNotifications?: boolean;
}

/** Bloque ou permet la dictée, lit ou non les notifications, sans recharger la voix ; rend le nouvel état. */
export const setVoicePreferences = (preferences: VoicePreferences) =>
  invoke<VoiceStatus>("voice.preferences.set", { ...preferences });

export const startListening = () => invoke<void>("voice.listen.start");
export const stopListening = () => invoke<{ text: string }>("voice.listen.stop");
export const cancelListening = () => invoke<void>("voice.listen.cancel");
/** Lit `text` (une nouvelle lecture coupe la précédente) ; se résout à la fin de la lecture. */
export const speak = (text: string) => invoke<{ interrupted: boolean }>("voice.speak", { text });
export const stopSpeaking = () => invoke<void>("voice.speak.stop");

export function onVoiceEvent(handler: (event: VoiceEvent) => void): () => void {
  return onNativeEvent("voice:event", (payload) => handler(payload as VoiceEvent));
}
