import type { Conversation, ConversationRuntime, Turn } from "../model";

/**
 * Question bloquante de l’agent, reprise de `agentQuestions` de OneApp : l’agent termine sa réponse par un bloc de
 * code ```alfred-question contenant {"question":"…","options":["…"]}. Le bloc est retiré du texte affiché et la
 * question est posée à part, au-dessus de la saisie. Les blocs ```oneapp-question sont lus de la même façon.
 * Un choix peut porter sa raison (`{"label":"…","why":"…"}`) : c’est ainsi que l’agent guide la création d’une page, une question à la fois, avec son choix recommandé et pourquoi.
 */

export type AgentQuestion = {
  question: string;
  options: string[];
  /** Raison de chaque choix qui en donne une, par libellé. */
  reasons?: Record<string, string>;
};

const questionBlock = /\n?```(?:alfred|oneapp)-question[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

function parseQuestion(raw: string): AgentQuestion | undefined {
  try {
    const value = JSON.parse(raw) as { question?: unknown; options?: unknown };
    if (typeof value.question !== "string" || !value.question.trim()) return undefined;
    const reasons: Record<string, string> = {};
    const options = Array.isArray(value.options)
      ? value.options
          .map((option) => {
            if (typeof option === "string") return option.trim().slice(0, 200);
            if (!option || typeof option !== "object") return "";
            const { label, why } = option as { label?: unknown; why?: unknown };
            const text = typeof label === "string" ? label.trim().slice(0, 200) : "";
            if (text && typeof why === "string" && why.trim()) reasons[text] = why.trim().slice(0, 300);
            return text;
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const question: AgentQuestion = { question: value.question.trim().slice(0, 1000), options };
    if (Object.keys(reasons).length) question.reasons = reasons;
    return question;
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
