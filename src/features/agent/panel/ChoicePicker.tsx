import { ChevronDown } from "lucide-react";
import { Button, Menu } from "socle-ui";

export type PickerChoice = { value: string; label: string };

/**
 * Bouton discret (texte et chevron) qui ouvre une liste de choix : l’autonomie de l’agent, sous la saisie. Le choix
 * actuel est coché.
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
    <Menu
      label={name}
      placement={`${placement === "above" ? "top" : "bottom"} ${align}`}
      trigger={
        <Button
          size="sm"
          variant="subtle"
          icon={<ChevronDown size={13} />}
          aria-label={`${name} : ${label}`}
          isDisabled={disabled || !choices.length}
        >
          {label}
        </Button>
      }
    >
      <Menu.Section
        title={name}
        selectionMode="single"
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next !== undefined && String(next) !== value) onChange(String(next));
        }}
      >
        {choices.map((choice) => (
          <Menu.Item key={choice.value} id={choice.value} label={choice.label} />
        ))}
      </Menu.Section>
    </Menu>
  );
}
