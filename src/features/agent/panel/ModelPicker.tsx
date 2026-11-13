import { ChoiceButton, ChoiceGroup, FormField, SelectControl } from "@alfred/ui";
import { ChevronDown, Lock } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useContextMenuDismiss } from "../../../ui/components/useContextMenuDismiss";
import { effortLabel } from "../effort";
import { type HarnessModel, listModels, PROVIDER_LABEL, type Provider } from "../harness";
import { usePickerPosition } from "./ChoicePicker";
import { EffortSlider } from "./EffortSlider";
import "./choice-picker.css";

export interface ModelChoice {
  provider: Provider;
  model?: string;
  effort?: string;
}

/** Modèles d’un harnais, relus quand le harnais ou le dossier change. */
export function useHarnessModels(provider: Provider, cwd: string) {
  const [models, setModels] = useState<HarnessModel[]>([]);
  useEffect(() => {
    let active = true;
    setModels([]);
    listModels(provider, cwd).then(
      (catalog) => active && setModels(catalog),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [provider, cwd]);
  return models;
}

/** Libellé court du choix, comme « gpt-6.1 · élevé » dans OneApp. */
export function modelChoiceLabel(choice: ModelChoice, models: readonly HarnessModel[]): string {
  const model = choice.model ? (models.find(({ id }) => id === choice.model)?.name ?? choice.model) : undefined;
  const effort = choice.effort ? effortLabel(choice.effort).toLocaleLowerCase("fr") : undefined;
  return [model ?? `${PROVIDER_LABEL[choice.provider]} · modèle par défaut`, effort].filter(Boolean).join(" · ");
}

/**
 * Choix du modèle d’une conversation, repris de `AgentModelPicker` de OneApp : le harnais en onglets segmentés,
 * le modèle en liste, puis le raisonnement en curseur sur les seuls niveaux que ce modèle propose. Le harnais ne
 * change plus une fois la conversation commencée : la session de l’agent y reste attachée.
 */
export function ModelPicker({
  value,
  cwd,
  providerLocked,
  disabled,
  onChange,
  placement = "above",
}: {
  value: ModelChoice;
  cwd: string;
  providerLocked?: boolean;
  disabled?: boolean;
  onChange: (choice: ModelChoice) => void;
  placement?: "above" | "below";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const position = usePickerPosition(open, placement, trigger, popover);
  const close = useCallback(() => setOpen(false), []);
  useContextMenuDismiss(open, `[data-model-picker="${id}"]`, close);
  const models = useHarnessModels(value.provider, cwd);
  const current = models.find(({ id: model }) => model === value.model);
  return (
    <div className="choice-picker" data-model-picker={id}>
      <button
        ref={trigger}
        type="button"
        className="choice-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-popover`}
        aria-label={`Modèle de l’agent : ${modelChoiceLabel(value, models)}`}
        disabled={disabled}
        onClick={() => setOpen((visible) => !visible)}
      >
        <span>{modelChoiceLabel(value, models)}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popover}
          id={`${id}-popover`}
          className="choice-picker__popover agent-model-picker__popover"
          // Un cran par niveau de raisonnement : au-delà de cinq, la fenêtre s’élargit pour que les libellés restent lisibles.
          style={{
            ...(position ?? { visibility: "hidden" }),
            width: Math.min(560, Math.max(320, 72 * ((current?.efforts.length ?? 0) + 1))),
          }}
          role="dialog"
          aria-label="Modèle de l’agent"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <ChoiceGroup label="Harnais" className="choice-segmented">
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((provider) => (
              <ChoiceButton
                key={provider}
                variant="label"
                size="compact"
                selectionMode="radio"
                label={PROVIDER_LABEL[provider]}
                title={
                  providerLocked && provider !== value.provider
                    ? "Le harnais ne change plus une fois la conversation commencée."
                    : undefined
                }
                selected={provider === value.provider}
                disabled={providerLocked && provider !== value.provider}
                onClick={() => {
                  if (provider !== value.provider) onChange({ provider });
                }}
              >
                {PROVIDER_LABEL[provider]}
              </ChoiceButton>
            ))}
          </ChoiceGroup>
          {providerLocked ? (
            <p className="agent-model-picker__lock">
              <Lock size={12} aria-hidden="true" />
              <span>
                Harnais fixé : cette conversation a commencé avec {PROVIDER_LABEL[value.provider]}. Pour{" "}
                {(Object.keys(PROVIDER_LABEL) as Provider[])
                  .filter((provider) => provider !== value.provider)
                  .map((provider) => PROVIDER_LABEL[provider])
                  .join(" ou ")}
                , ouvre une nouvelle conversation.
              </span>
            </p>
          ) : null}
          <FormField label="Modèle">
            <SelectControl
              value={value.model ?? ""}
              onChange={(event) => onChange({ provider: value.provider, model: event.target.value || undefined })}
            >
              <option value="">Modèle par défaut</option>
              {value.model && !current ? <option value={value.model}>{value.model}</option> : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </SelectControl>
          </FormField>
          <EffortSlider
            efforts={current?.efforts ?? []}
            value={value.effort ?? ""}
            onChange={(effort) => onChange({ ...value, effort: effort || undefined })}
          />
        </div>
      ) : null}
    </div>
  );
}
