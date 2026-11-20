/**
 * Faux pilote des agents pour les tests : il répond aux commandes `agents.*` que `native.ts` envoie à Rust et
 * renvoie des événements normalisés sur le bus `agent:event`, comme le pont de développement.
 */
import type { Mock } from "vitest";
import type { HarnessEvent } from "./types";

type Outgoing = HarnessEvent | { type: "structured"; value: unknown };

export interface FakeSession {
  handle: string;
  /** Arguments de `agents.start`. */
  args: Record<string, unknown>;
  /** Textes envoyés par `agents.send`. */
  sent: string[];
  closed: boolean;
  emit(...events: Outgoing[]): void;
}

let bus: ((payload: unknown) => void) | undefined;
let count = 0;

/**
 * Branche le faux pilote sur les doubles de `invoke` et `onNativeEvent` du test. `onSend` reçoit chaque message ; les
 * autres commandes passent à l’implémentation déjà en place.
 */
export function fakeAgents(
  native: { invoke: Mock; onNativeEvent: Mock },
  onSend: (session: FakeSession, text: string) => void = () => undefined,
): FakeSession[] {
  const sessions: FakeSession[] = [];
  native.onNativeEvent.mockImplementation((name: string, handler: (payload: unknown) => void) => {
    if (name === "agent:event") bus = handler;
    return () => undefined;
  });
  const previous = native.invoke.getMockImplementation();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "agents.start") {
      const handle = `fausse-session-${++count}`;
      const session: FakeSession = {
        handle,
        args,
        sent: [],
        closed: false,
        emit: (...events) => {
          for (const event of events) bus?.({ ...event, session: handle });
        },
      };
      sessions.push(session);
      return { handle, sessionId: null };
    }
    const session = sessions.find((item) => item.handle === args?.handle);
    if (command === "agents.send" && session) {
      const text = String(args.text ?? "");
      session.sent.push(text);
      queueMicrotask(() => onSend(session, text));
      return null;
    }
    if (command === "agents.close") {
      if (session) session.closed = true;
      return null;
    }
    if (command.startsWith("agents.")) return null;
    return previous ? previous(command, args) : null;
  });
  return sessions;
}

/** Réponse complète d’un tour : texte, résultat structuré éventuel, puis fin du tour. */
export function answerTurn(session: FakeSession, text: string, structured?: unknown) {
  session.emit(
    { type: "status", status: "responding" },
    { type: "message", itemId: `m-${session.sent.length}`, content: text, replace: true },
    ...(structured !== undefined ? [{ type: "structured" as const, value: structured }] : []),
    { type: "status", status: "idle" },
  );
}
