import { FileSearch, Pencil, X } from "lucide-react";
import type { ItemSetting, OpenFormFunction } from "socle-ui";
import { inTauri, pickFile } from "../../lib/native";

/**
 * Ligne de réglage d’un chemin de fichier : le chemin en description, « Modifier le chemin… » (saisie libre),
 * « Choisir un fichier… » dans l’application, et « Effacer » quand la valeur peut rester vide.
 */
export function pathSetting({
  id,
  label,
  description,
  value,
  placeholder,
  clearable = true,
  openForm,
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  placeholder?: string;
  clearable?: boolean;
  openForm: OpenFormFunction;
  onCommit: (value: string) => unknown;
}): ItemSetting {
  return {
    id,
    type: "item",
    label,
    description: value ? `${description} ${value}` : `${description}${placeholder ? ` Vide : ${placeholder}.` : ""}`,
    actions: [
      {
        id: "edit",
        label: `Modifier : ${label}`,
        icon: <Pencil size={16} aria-hidden="true" />,
        onPress: async () => {
          const values = await openForm({
            title: label,
            submitLabel: "Enregistrer",
            initialValues: { path: value },
            fields: [{ name: "path", label: "Chemin", placeholder, autoComplete: "off" }],
          });
          const next = String(values?.path ?? "").trim();
          if (values && next !== value) await onCommit(next);
        },
      },
      {
        id: "pick",
        label: `Choisir un fichier : ${label}`,
        icon: <FileSearch size={16} aria-hidden="true" />,
        isHidden: !inTauri,
        onPress: async () => {
          const picked = await pickFile(label);
          if (picked) await onCommit(picked);
        },
      },
      {
        id: "clear",
        label: `Effacer : ${label}`,
        icon: <X size={16} aria-hidden="true" />,
        isHidden: !clearable || !value,
        onPress: () => onCommit(""),
      },
    ],
  };
}
