/**
 * État de la voix partagé par l’interface : la dictée de la page Agent (micro ouvert, transcription en cours,
 * hypothèse partielle, niveau) et la lecture en cours, quel qu’en soit l’auteur.
 */

import { create } from "zustand";
import { frameServices } from "../../shell/frameBridge";
import { notify } from "../../shell/notifications";
import {
  cancelListening,
  getVoiceStatus,
  onVoiceEvent,
  setVoiceEnabled,
  setVoicePreferences,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
  type VoicePreferences,
  type VoiceStatus,
} from "./api";

type Dictation = "idle" | "starting" | "listening" | "transcribing";

interface VoiceState {
  status?: VoiceStatus;
  /** La dictée de la page Agent. */
  dictation: Dictation;
  /** Dernière hypothèse pendant la dictée. */
  partial: string;
  /** Niveau du micro, entre 0 et 1. */
  level: number;
  /**
   * Dernier instant où l’on a entendu parler pendant la dictée (voix au-dessus du bruit de fond, ou transcription
   * qui avance) ; `null` tant que rien n’a été dit. Une pause assez longue après ce moment envoie le message.
   */
  heardAt: number | null;
  speaking: boolean;
  refresh: () => Promise<VoiceStatus | undefined>;
  /** Ouvre le micro pour la page Agent (coupe la lecture en cours). */
  startDictation: () => Promise<boolean>;
  /** Ferme le micro et rend la transcription (vide si rien n’a été entendu). */
  finishDictation: () => Promise<string>;
  cancelDictation: () => Promise<void>;
  /** Lit un texte ; une erreur est signalée, jamais levée. */
  read: (text: string) => Promise<void>;
  stopReading: () => Promise<void>;
  /** Active ou coupe la voix ; une erreur est signalée. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Bloque ou permet la dictée, lit ou non les notifications ; une erreur est signalée. */
  setPreferences: (preferences: VoicePreferences) => Promise<void>;
  /**
   * Lit une notification si l’utilisateur l’a demandé (voix active, lecture des notifications permise), sans
   * couper une lecture ni une dictée en cours.
   */
  announce: (text: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Niveau du micro (RMS) au-dessus duquel on parle ; le bruit de fond d’une pièce calme est bien en dessous. */
const SPEECH_RMS = 0.02;

let bound = false;

/** Relaie les événements du moteur vocal dans l’état ; une seule fois. */
export function bindVoiceEvents() {
  if (bound) return;
  bound = true;
  onVoiceEvent((event) => {
    switch (event.type) {
      case "level": {
        const listening = useVoice.getState().dictation === "listening";
        useVoice.setState({
          level: Math.min(1, event.rms * 6),
          ...(listening && event.rms >= SPEECH_RMS ? { heardAt: Date.now() } : {}),
        });
        return;
      }
      case "partial": {
        const state = useVoice.getState();
        if (state.dictation !== "listening") return;
        // La transcription avance : on parle encore, même à voix basse.
        const moved = event.text.trim() && event.text !== state.partial;
        useVoice.setState({ partial: event.text, ...(moved ? { heardAt: Date.now() } : {}) });
        return;
      }
      case "speech_started":
        useVoice.setState({ speaking: true });
        return;
      case "speech_finished":
        useVoice.setState({ speaking: false });
        return;
      case "error":
        notify({ title: "Voix", description: event.message, tone: "error" });
        return;
      default:
        return;
    }
  });
}

export const useVoice = create<VoiceState>((set, get) => ({
  dictation: "idle",
  partial: "",
  level: 0,
  heardAt: null,
  speaking: false,

  async refresh() {
    try {
      const status = await getVoiceStatus();
      set({ status });
      return status;
    } catch {
      return undefined;
    }
  },

  async startDictation() {
    bindVoiceEvents();
    if (get().dictation !== "idle") return false;
    set({ dictation: "starting", partial: "", level: 0, heardAt: null });
    try {
      await startListening();
      set({ dictation: "listening" });
      return true;
    } catch (error) {
      set({ dictation: "idle" });
      notify({ title: "Dictée impossible", description: message(error), tone: "error" });
      return false;
    }
  },

  async finishDictation() {
    if (get().dictation !== "listening") return "";
    set({ dictation: "transcribing", level: 0 });
    try {
      const { text } = await stopListening();
      return text.trim();
    } catch (error) {
      notify({ title: "Transcription impossible", description: message(error), tone: "error" });
      return "";
    } finally {
      set({ dictation: "idle", partial: "" });
    }
  },

  async cancelDictation() {
    if (get().dictation === "idle") return;
    set({ dictation: "idle", partial: "", level: 0 });
    await cancelListening().catch(() => undefined);
  },

  async read(text) {
    bindVoiceEvents();
    try {
      await speak(text);
    } catch (error) {
      notify({ title: "Lecture impossible", description: message(error), tone: "error" });
    }
  },

  async stopReading() {
    set({ speaking: false });
    await stopSpeaking().catch(() => undefined);
  },

  async setEnabled(enabled) {
    const previous = get().status;
    if (previous) set({ status: { ...previous, enabled } });
    if (!enabled) set({ dictation: "idle", partial: "", speaking: false });
    try {
      set({ status: await setVoiceEnabled(enabled) });
    } catch (error) {
      set({ status: previous });
      notify({ title: "La voix n’a pas été modifiée", description: message(error), tone: "error" });
    }
  },

  async setPreferences(preferences) {
    const previous = get().status;
    if (previous) set({ status: { ...previous, ...preferences } });
    // Bloquer la dictée ferme le micro : Rust l’a déjà fermé, l’interface suit.
    if (preferences.dictation === false) set({ dictation: "idle", partial: "", level: 0 });
    try {
      set({ status: await setVoicePreferences(preferences) });
    } catch (error) {
      set({ status: previous });
      notify({ title: "La voix n’a pas été modifiée", description: message(error), tone: "error" });
    }
  },

  async announce(text) {
    if (!text.trim()) return;
    // Le réglage peut n’avoir jamais été lu (page Agent pas encore ouverte).
    const status = get().status ?? (await get().refresh());
    const { speaking, dictation } = get();
    if (!status?.enabled || !status.readNotifications || speaking || dictation !== "idle") return;
    await get().read(text);
  },
}));

frameServices.announce = (text) => void useVoice.getState().announce(text);
