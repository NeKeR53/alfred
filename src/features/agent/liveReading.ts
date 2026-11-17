/**
 * Lecture à voix haute d’une réponse pendant que l’agent l’écrit : à une demande dictée, Alfred commence à parler
 * dès sa première phrase complète, au lieu d’attendre la fin de toute la réponse.
 *
 * Le texte des messages du tour (Markdown) est suivi au fil des événements ; ce qui précède la dernière fin de
 * phrase est mis en texte simple et la part nouvelle part à la synthèse, qui dit chaque phrase dès qu’elle est
 * complète. La fin du tour envoie le reste et clôt la lecture.
 */
import { addStreamedSpeech, beginStreamedSpeech, endStreamedSpeech } from "../voice/api";
import { useVoice } from "../voice/store";
import { plainText, QUESTION_BLOCK_LANGUAGE, type Turn } from "./model";

interface Reading {
  turnId: string;
  /** Longueur du texte brut (Markdown) déjà confié à la synthèse. */
  sent: number;
  /** Les envois partent dans l’ordre, après l’ouverture de la lecture. */
  chain: Promise<unknown>;
  failed: boolean;
}

const readings = new Map<string, Reading>();

/** La voix doit-elle lire la réponse de ce tour ? Une demande dictée, voix active, lecture des réponses permise. */
function wanted(turn: Turn): boolean {
  if (!turn.user.spoken) return false;
  const status = useVoice.getState().status;
  return status?.enabled !== false && status?.readReplies !== false;
}

/** Texte dit du tour : ses messages dans l’ordre, sans le bloc de question (il devient une carte). */
function spokenSource(turn: Turn): string {
  return turn.items
    .flatMap((item) => (item.kind === "message" && item.content.trim() ? [item.content] : []))
    .join("\n\n")
    .split(`\`\`\`${QUESTION_BLOCK_LANGUAGE}`)[0];
}

/** Ce qui précède la dernière fin de phrase (ou de ligne), hors d’un bloc de code encore ouvert. */
export function completeSentences(markdown: string): string {
  let text = markdown;
  const fences = text.split("```").length - 1;
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf("```"));
  let end = -1;
  for (const match of text.matchAll(/[.!?…:;](?=\s)|\n/g)) end = (match.index ?? 0) + match[0].length;
  return end < 0 ? "" : text.slice(0, end);
}

/** Confie à la synthèse le texte brut au-delà de ce qui a déjà été envoyé, mis en texte simple. */
function send(reading: Reading, raw: string) {
  if (raw.length <= reading.sent) return;
  const delta = plainText(raw.slice(reading.sent));
  reading.sent = raw.length;
  if (!delta) return;
  reading.chain = reading.chain.then(() => (reading.failed ? undefined : addStreamedSpeech(` ${delta}`)));
}

/** Le tour a reçu du texte : dit les nouvelles phrases complètes. */
export function readAlong(conversationId: string, turn: Turn | undefined) {
  if (turn?.status !== "running" || !wanted(turn)) return;
  let reading = readings.get(conversationId);
  if (reading?.turnId !== turn.id) {
    const opened: Reading = { turnId: turn.id, sent: 0, chain: Promise.resolve(), failed: false };
    opened.chain = beginStreamedSpeech().catch(() => {
      opened.failed = true;
    });
    reading = opened;
    readings.set(conversationId, reading);
  }
  send(reading, completeSentences(spokenSource(turn)));
}

/**
 * Le tour est fini : dit le reste et clôt la lecture. Rend `false` si la réponse n’était pas lue au fil de l’eau
 * (réponse arrivée d’un bloc) : l’appelant la lit alors entière, comme avant.
 */
export function finishReading(conversationId: string, turn: Turn, status: Turn["status"]): boolean {
  const reading = readings.get(conversationId);
  if (!reading || reading.turnId !== turn.id) return false;
  readings.delete(conversationId);
  if (status === "done") send(reading, spokenSource(turn));
  reading.chain = reading.chain.then(() => (reading.failed ? undefined : endStreamedSpeech())).catch(() => undefined);
  return true;
}
