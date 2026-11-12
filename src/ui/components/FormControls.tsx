import { cn } from "cn";
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { Checkbox } from "../primitives/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "../primitives/field";
import { Input } from "../primitives/input";
import { NativeSelect } from "../primitives/native-select";
import { Radio } from "../primitives/radio";
import { Switch } from "../primitives/switch";
import { Textarea } from "../primitives/textarea";

type FieldContextValue = { controlId: string; messageId?: string; invalid: boolean };
const FormFieldContext = createContext<FieldContextValue | undefined>(undefined);

/** Champ englobant (`FormField`) : identifiant à donner au contrôle, message à lui relier, invalidité. */
export function useFormField() {
  return useContext(FormFieldContext);
}

function descriptionIds(existing: string | undefined, messageId: string | undefined) {
  return [existing, messageId].filter(Boolean).join(" ") || undefined;
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, id, "aria-invalid": invalid, "aria-describedby": describedBy, ...props },
  ref,
) {
  const field = useContext(FormFieldContext);
  return (
    <Input
      {...props}
      ref={ref}
      id={id ?? field?.controlId}
      aria-invalid={invalid ?? (field?.invalid || undefined)}
      aria-describedby={descriptionIds(describedBy, field?.messageId)}
      className={cn("ui-input", className)}
    />
  );
});

export const SelectControl = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SelectControl(
    { className, id, "aria-invalid": invalid, "aria-describedby": describedBy, children, ...props },
    ref,
  ) {
    const field = useContext(FormFieldContext);
    return (
      <NativeSelect
        {...props}
        ref={ref}
        id={id ?? field?.controlId}
        aria-invalid={invalid ?? (field?.invalid || undefined)}
        aria-describedby={descriptionIds(describedBy, field?.messageId)}
        className={cn("ui-select", className)}
      >
        {children}
      </NativeSelect>
    );
  },
);

export type TextAreaVariant = "default" | "composer" | "inline";
export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: TextAreaVariant;
}

function resizeTextarea(node: HTMLTextAreaElement | null, variant: TextAreaVariant) {
  if (variant === "default" || !node) return;
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, variant = "default", onInput, id, "aria-invalid": invalid, "aria-describedby": describedBy, ...props },
  ref,
) {
  const field = useContext(FormFieldContext);
  const element = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    resizeTextarea(element.current, variant);
  });
  useLayoutEffect(() => {
    if (variant === "default" || !element.current) return;
    if (typeof ResizeObserver === "undefined") return;
    const node = element.current;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) {
        width = node.clientWidth;
        resizeTextarea(node, variant);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [variant]);
  return (
    <Textarea
      {...props}
      ref={(node) => {
        element.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      id={id ?? field?.controlId}
      aria-invalid={invalid ?? (field?.invalid || undefined)}
      aria-describedby={descriptionIds(describedBy, field?.messageId)}
      variant={variant}
      onInput={(event) => {
        resizeTextarea(element.current, variant);
        onInput?.(event);
      }}
      className={cn("ui-textarea", variant !== "default" && `ui-textarea--${variant}`, className)}
    />
  );
});

export function FormField({
  label,
  hint,
  error,
  className,
  children,
  layout = "stacked",
  messageId,
  compound = false,
  htmlFor,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  layout?: "stacked" | "inline";
  messageId?: string;
  compound?: boolean;
}) {
  const generatedId = useId();
  const childId =
    isValidElement(children) && typeof (children.props as { id?: unknown }).id === "string"
      ? (children.props as { id: string }).id
      : undefined;
  const controlId = htmlFor ?? childId ?? generatedId;
  const descriptionId = error || hint ? (messageId ?? `${generatedId}-message`) : undefined;
  const invalid = Boolean(error);
  return (
    <FormFieldContext.Provider value={{ controlId, messageId: descriptionId, invalid }}>
      <Field
        data-invalid={invalid || undefined}
        data-compound={compound || undefined}
        orientation={layout === "inline" ? "horizontal" : "vertical"}
        className={cn(
          "form-field",
          layout === "inline" && "form-field--inline",
          invalid && "form-field--error",
          className,
        )}
      >
        <FieldLabel {...props} htmlFor={controlId} className="form-field__label">
          {label}
        </FieldLabel>
        {children}
        {error ? (
          <FieldError className="form-field__message" id={descriptionId}>
            {error}
          </FieldError>
        ) : hint ? (
          <FieldDescription className="form-field__message" id={descriptionId}>
            {hint}
          </FieldDescription>
        ) : null}
      </Field>
    </FormFieldContext.Provider>
  );
}

export function FormControlGroup({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn("form-control-group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2", className)}
    >
      {children}
    </div>
  );
}

type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode };

export const CheckboxControl = forwardRef<HTMLInputElement, ChoiceProps>(function CheckboxControl(
  { label, className, ...props },
  ref,
) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <label
      htmlFor={id}
      className={cn(
        "checkbox-control inline-flex min-h-8 items-center gap-2 text-[13px] font-medium text-foreground cursor-default has-[:disabled]:opacity-50",
        className,
      )}
    >
      <Checkbox {...props} id={id} ref={ref} />
      <span>{label}</span>
    </label>
  );
});

export const RadioControl = forwardRef<HTMLInputElement, ChoiceProps>(function RadioControl(
  { label, className, ...props },
  ref,
) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <label
      htmlFor={id}
      className={cn(
        "radio-control inline-flex min-h-8 items-center gap-2 text-[13px] font-medium text-foreground cursor-default has-[:disabled]:opacity-50",
        className,
      )}
    >
      <Radio {...props} id={id} ref={ref} />
      <span>{label}</span>
    </label>
  );
});

export const SwitchControl = forwardRef<HTMLInputElement, ChoiceProps>(function SwitchControl(
  { label, className, ...props },
  ref,
) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <label
      htmlFor={id}
      className={cn(
        "switch-control inline-flex min-h-8 items-center gap-2 text-[13px] font-medium text-foreground cursor-default has-[:disabled]:opacity-50",
        className,
      )}
    >
      <Switch {...props} id={id} ref={ref} />
      <span className="switch-control__label">{label}</span>
    </label>
  );
});
