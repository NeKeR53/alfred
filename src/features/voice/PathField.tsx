import { Button, TextInput } from "@alfred/ui";
import { useEffect, useState } from "react";
import { inTauri, pickFile } from "../../lib/native";
import "./voice.css";

/** Champ de chemin : saisie libre, enregistrée en quittant le champ, et sélecteur de fichier dans l’application. */
export function PathField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="voice-settings__path">
      <TextInput
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== value) onCommit(draft.trim());
        }}
      />
      {inTauri ? (
        <Button
          variant="secondary"
          onClick={async () => {
            const picked = await pickFile(label);
            if (picked) onCommit(picked);
          }}
        >
          Choisir…
        </Button>
      ) : null}
    </div>
  );
}
