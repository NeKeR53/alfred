import { Check } from "lucide-react";
import "./step-list.css";

export type StepItem<Id extends string> = { id: Id; title: string; hint?: string };

/**
 * Étapes numérotées d’un parcours guidé. Les étapes passées sont cochées ; avec `onSelect`, chaque étape
 * accessible devient un bouton pour y revenir directement.
 */
export function StepList<Id extends string>({
  label,
  steps,
  current,
  onSelect,
  isAvailable = () => true,
  className,
}: {
  label: string;
  steps: readonly StepItem<Id>[];
  current: Id;
  onSelect?: (id: Id) => void;
  isAvailable?: (id: Id) => boolean;
  className?: string;
}) {
  const currentIndex = steps.findIndex(({ id }) => id === current);
  return (
    <ol className={`step-list${className ? ` ${className}` : ""}`} aria-label={label}>
      {steps.map((step, index) => {
        const state = index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : undefined;
        const content = (
          <>
            <span className="step-list__mark" aria-hidden="true">
              {index < currentIndex ? <Check size={13} /> : index + 1}
            </span>
            <span className="step-list__text">
              <strong>{step.title}</strong>
              {step.hint ? <small>{step.hint}</small> : null}
            </span>
          </>
        );
        return (
          <li key={step.id} className={state} aria-current={index === currentIndex ? "step" : undefined}>
            {onSelect ? (
              <button
                type="button"
                className="step-list__item"
                aria-label={step.title}
                title={step.hint ? `${step.title} · ${step.hint}` : step.title}
                disabled={!isAvailable(step.id)}
                onClick={() => onSelect(step.id)}
              >
                {content}
              </button>
            ) : (
              <span className="step-list__item">{content}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
