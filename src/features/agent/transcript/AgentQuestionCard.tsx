import { IconButton } from "@alfred/ui";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ApprovalRequest } from "../harness";
import type { AgentQuestion } from "./agentQuestions";

/**
 * Question ou autorisation attendue, posée au-dessus du champ de saisie, reprise de `AgentQuestion` de OneApp. Les
 * choix se valident d’un clic ou par leur numéro ; « Autre réponse » renvoie au champ. La carte se replie en une
 * pastille sans perdre la question.
 */
export function AgentQuestionCard({
  question,
  permission,
  disabled,
  onAnswer,
  onRespond,
  onOther,
}: {
  question?: AgentQuestion;
  permission?: ApprovalRequest;
  disabled?: boolean;
  onAnswer: (text: string) => void;
  onRespond: (optionId: string) => void;
  onOther: () => void;
}) {
  const [folded, setFolded] = useState(false);
  const options = permission
    ? permission.options.map((option) => ({ id: option.id, label: option.label, run: () => onRespond(option.id) }))
    : (question?.options ?? []).map((option) => ({ id: option, label: option, run: () => onAnswer(option) }));
  const text = permission?.title ?? question?.question;
  if (!text) return null;
  const kind = permission ? "Autorisation demandée" : "Question de l’agent";
  if (folded)
    return (
      <button type="button" className="agent-question__pill" onClick={() => setFolded(false)}>
        <span className="agent-question__mark" aria-hidden="true">
          ?
        </span>
        {kind} en attente
        <ChevronUp size={13} aria-hidden="true" />
      </button>
    );
  return (
    <section
      className="agent-question"
      aria-label={kind}
      onKeyDown={(event) => {
        if (disabled || event.target instanceof HTMLTextAreaElement) return;
        const index = Number(event.key) - 1;
        const option = options[index];
        if (!option || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        option.run();
      }}
    >
      <header className="agent-question__head">
        <span className="agent-question__mark" aria-hidden="true">
          {permission ? <ShieldCheck size={12} /> : "?"}
        </span>
        <span className="agent-question__kind">{kind}</span>
        <IconButton size="small" label="Replier la question" onClick={() => setFolded(true)}>
          <ChevronDown size={14} aria-hidden="true" />
        </IconButton>
      </header>
      <p className="agent-question__text">{text}</p>
      {permission?.detail ? <pre className="agent-card__detail">{permission.detail}</pre> : null}
      {options.length ? (
        <ol className="agent-question__options">
          {options.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                className="agent-question__option"
                disabled={disabled}
                aria-label={option.label}
                aria-keyshortcuts={String(index + 1)}
                onClick={option.run}
              >
                <kbd>{index + 1}</kbd>
                <span>{option.label}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {permission ? null : (
        <button type="button" className="agent-question__other" disabled={disabled} onClick={onOther}>
          {options.length ? "Autre réponse…" : "Répondre…"}
        </button>
      )}
    </section>
  );
}
