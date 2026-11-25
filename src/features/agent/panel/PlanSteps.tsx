import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { type DetailSection, List, type ListItemData } from "socle-ui";
import type { PlanStep } from "../harness";

const STEP_STATE: Record<PlanStep["status"], { label: string; icon: typeof Circle }> = {
  pending: { label: "À faire", icon: Circle },
  inProgress: { label: "En cours", icon: CircleDot },
  completed: { label: "Faite", icon: CircleCheck },
};

/**
 * Étapes du plan de l’agent, rendues par `List` de socle-ui (la spec de `ProgressIndicator` renvoie à `List` pour une
 * liste de tâches), une ligne par étape : l’icône à gauche porte seule l’état (à faire, en cours, faite), nommé pour les
 * lecteurs d’écran ; le texte de l’étape en titre. Sans trait entre les étapes (`dividers={false}`, D-400).
 */
function PlanSteps({ steps }: { steps: readonly PlanStep[] }) {
  const items: ListItemData[] = steps.map((step, index) => {
    const state = STEP_STATE[step.status];
    const Icon = state.icon;
    return {
      id: String(index),
      title: step.text,
      visual: <Icon size={16} role="img" aria-label={state.label} />,
    };
  });
  return <List label="Étapes du plan" items={items} selectionMode="none" leading="icon" dividers={false} />;
}

/** Section « Plan » du panneau de la conversation, avec le compte des étapes faites ; rien sans plan. */
export function planSection(plan: readonly PlanStep[] | undefined): DetailSection | undefined {
  if (!plan?.length) return undefined;
  const done = plan.filter((step) => step.status === "completed").length;
  return {
    id: "conversation-plan",
    title: "Plan",
    summary: { label: `${done} sur ${plan.length}`, tone: done === plan.length ? "success" : "neutral" },
    content: <PlanSteps steps={plan} />,
  };
}
