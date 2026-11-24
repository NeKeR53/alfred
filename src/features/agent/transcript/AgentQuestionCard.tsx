import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Button, ChoicePrompt } from "socle-ui";
import type { ApprovalRequest } from "../harness";
import type { AgentQuestion } from "./agentQuestions";

/**
 * Question ou autorisation attendue, posée au-dessus du champ de saisie : `ChoicePrompt` de Socle (D-377). Un choix
 * répond tout de suite, au clic ou par son numéro quand le focus est dans la carte ; « Autre réponse… » ouvre un champ
 * dans la carte. Le repli en pastille, repris de OneApp, n’existe pas dans Socle 1.4 : il reste en boutons de Socle
 * sous la carte (voir docs/socle-propositions.md, « Manques vus en 1.4 »).
 */
export function AgentQuestionCard({
  question,
  permission,
  disabled,
  onAnswer,
  onRespond,
}: {
  question?: AgentQuestion;
  permission?: ApprovalRequest;
  disabled?: boolean;
  onAnswer: (text: string) => void;
  onRespond: (optionId: string) => void;
}) {
  const [folded, setFolded] = useState(false);
  const text = permission?.title ?? question?.question;
  if (!text) return null;
  const kind = permission ? "Autorisation demandée" : "Question de l’agent";
  if (folded)
    return (
      <Button size="sm" variant="subtle" icon={<ChevronUp size={14} />} onPress={() => setFolded(false)}>
        {`${kind} en attente`}
      </Button>
    );
  return (
    <>
      {permission ? (
        <ChoicePrompt
          kind="permission"
          question={text}
          detail={permission.detail}
          options={permission.options.map(({ id, label }) => ({ id, label }))}
          onChoose={(answer) => "id" in answer && onRespond(answer.id)}
        />
      ) : (
        <ChoicePrompt
          question={text}
          options={(question?.options ?? []).map((option) => ({ id: option, label: option }))}
          isDisabled={disabled}
          onChoose={(answer) => onAnswer("id" in answer ? answer.id : answer.text)}
        />
      )}
      <Button size="sm" variant="subtle" icon={<ChevronDown size={14} />} onPress={() => setFolded(true)}>
        Replier la question
      </Button>
    </>
  );
}
