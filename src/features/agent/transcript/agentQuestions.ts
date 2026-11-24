import type { Conversation, ConversationRuntime, Turn } from "../model";

/**
 * Question bloquante de l’agent, reprise de `agentQuestions` de OneApp : l’agent termine sa réponse par un bloc de
 * code ```alfred-question contenant {"question":"…","options":["…"]}. Le bloc est retiré du texte affiché et la
 * question est posée à part, au-dessus de la saisie. Les blocs ```oneapp-question sont lus de la même façon.
 */

export type AgentQuestion = { question: string; options: string[] };

const questionBlock = /\n?```(?:alfred|oneapp)-question[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

function parseQuestion(raw: string): AgentQuestion | undefined {
  try {
    const value = JSON.parse(raw) as { question?: unknown; options?: unknown };
    if (typeof value.question !== "string" || !value.question.trim()) return undefined;
    const options = Array.isArray(value.options)
      ? value.options
          .filter((option): option is string => typeof option === "string" && Boolean(option.trim()))
          .map((option) => option.trim().slice(0, 200))
          .slice(0, 4)
      : [];
    return { question: value.question.trim().slice(0, 1000), options };
  } catch {
    return undefined;
  }
}

/** Texte affiché d’une réponse d’agent : la question bloquante est présentée à part, au-dessus du champ. */
export function withoutAgentQuestion(content: string): string {
  const match = questionBlock.exec(content.trimEnd());
  return match && parseQuestion(match[1]) ? content.trimEnd().slice(0, match.index).trimEnd() : content;
}

function lastAnswer(turn: Turn): string | undefined {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.kind === "message") return item.content;
  }
  return undefined;
}

/** Question mémorisée par tour : un tour inchangé garde le même objet d’une mise à jour à l’autre. */
const questionCache = new WeakMap<Turn, AgentQuestion | null>();

/** Question bloquante posée à la fin du dernier tour, tant que l’utilisateur n’a pas répondu. */
export function agentQuestion(conversation: Conversation, runtime: ConversationRuntime): AgentQuestion | undefined {
  const turn = conversation.turns.at(-1);
  if (turn?.status !== "done" || runtime.status !== "idle" || runtime.queued.length) return undefined;
  const cached = questionCache.get(turn);
  if (cached !== undefined) return cached ?? undefined;
  const answer = lastAnswer(turn);
  const match = answer ? questionBlock.exec(answer.trimEnd()) : null;
  const question = match ? parseQuestion(match[1]) : undefined;
  questionCache.set(turn, question ?? null);
  return question;
}
