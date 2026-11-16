/**
 * Surveillance du silence, reprise de OneApp : un CLI muet en pleine réponse (texte coupé) ou en réflexion sans outil
 * voit son tour arrêté, au lieu de rester « en cours » sans fin. Aucune limite tant qu’un outil ou une commande
 * s’exécute, ni pendant qu’une demande d’accord ou une question attend l’utilisateur.
 */
import type { Turn } from "./model";

/** Durées de silence du CLI au-delà desquelles un tour est considéré comme interrompu. */
export interface SilenceWatch {
  checkMs: number;
  streamMs: number;
  thinkingMs: number;
}

export const DEFAULT_SILENCE_WATCH: SilenceWatch = { checkMs: 30_000, streamMs: 3 * 60_000, thinkingMs: 15 * 60_000 };

/** Silence permis pour ce tour ; `undefined` quand un outil travaille encore après le dernier message. */
export function silenceLimit(turn: Turn, watch: SilenceWatch = DEFAULT_SILENCE_WATCH): number | undefined {
  const { items } = turn;
  let lastMessage = items.length - 1;
  while (lastMessage >= 0 && items[lastMessage]?.kind !== "message") lastMessage -= 1;
  const toolRunning = items.some(
    (item, index) =>
      item.kind === "activity" &&
      item.activityKind !== "analysis" &&
      item.status === "running" &&
      (lastMessage < 0 || index > lastMessage),
  );
  if (toolRunning) return undefined;
  return items.at(-1)?.kind === "message" ? watch.streamMs : watch.thinkingMs;
}

/** Message du tour arrêté par la surveillance. */
export function silenceMessage(silenceMs: number, writing: boolean): string {
  const minutes = Math.max(1, Math.round(silenceMs / 60_000));
  return `Le CLI ne donne plus signe de vie depuis ${minutes} min${writing ? " au milieu de sa réponse" : ""}. Le tour a été arrêté ; relancez la tâche.`;
}

/** Tour suivi par la surveillance. */
export interface WatchedTurn {
  id: string;
  turn: Turn;
  /** Dernier signe du CLI pour ce tour. */
  lastEventAt: number;
  /** Une demande d’accord ou une question attend l’utilisateur : le silence est normal. */
  waitingForUser: boolean;
}

/**
 * Une seule surveillance pour tous les tours en cours ; elle s’arrête d’elle-même quand plus aucun tour ne travaille
 * et repart au tour suivant (`start`).
 */
export function createSilenceWatch(options: {
  running: () => WatchedTurn[];
  fail: (id: string, message: string) => void;
  watch?: () => SilenceWatch;
  now?: () => number;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const settings = () => options.watch?.() ?? DEFAULT_SILENCE_WATCH;
  const now = options.now ?? (() => Date.now());
  const check = () => {
    const running = options.running();
    if (!running.length) {
      stop();
      return;
    }
    for (const { id, turn, lastEventAt, waitingForUser } of running) {
      if (waitingForUser) continue;
      const limit = silenceLimit(turn, settings());
      const silence = now() - lastEventAt;
      if (limit === undefined || silence <= limit) continue;
      options.fail(id, silenceMessage(silence, turn.items.at(-1)?.kind === "message"));
    }
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return {
    start() {
      if (!timer) timer = setInterval(check, settings().checkMs);
    },
    stop,
    check,
  };
}
