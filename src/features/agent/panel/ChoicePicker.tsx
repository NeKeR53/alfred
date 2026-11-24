import { ChatOptionButton, DropdownMenu } from "socle-ui";

export type PickerChoice = { value: string; label: string };

/**
 * Choix sous la saisie (l’autonomie de l’agent) : un `ChatOptionButton` qui ouvre un `DropdownMenu` de choix cochés
 * (D-371). Le choix actuel est coché.
 */
export function ChoicePicker({
  name,
  value,
  choices,
  placeholder,
  disabled,
  onChange,
  placement = "above",
  align = "start",
}: {
  name: string;
  value: string;
  choices: readonly PickerChoice[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placement?: "above" | "below";
  align?: "start" | "end";
}) {
  const current = choices.find((choice) => choice.value === value);
  const label = current?.label ?? placeholder;
  return (
    <DropdownMenu
      label={name}
      placement={`${placement === "above" ? "top" : "bottom"} ${align}`}
      trigger={
        <ChatOptionButton label={label} aria-label={`${label} : ${name}`} isDisabled={disabled || !choices.length} />
      }
    >
      <DropdownMenu.Section
        title={name}
        selectionMode="single"
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next !== undefined && String(next) !== value) onChange(String(next));
        }}
      >
        {choices.map((choice) => (
          <DropdownMenu.Item key={choice.value} id={choice.value} label={choice.label} />
        ))}
      </DropdownMenu.Section>
    </DropdownMenu>
  );
}
