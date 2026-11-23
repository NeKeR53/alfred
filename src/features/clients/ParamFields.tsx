/**
 * Paramètres non secrets d’un compte (royaume Keycloak, montage OpenBao, endpoint Portainer), déclarés par la méthode
 * de connexion du service : un champ par paramètre, avec son exemple et son aide. Partagé par l’assistant de compte
 * et la fiche du module. Les valeurs vont dans le fichier du service, jamais dans le coffre : elles ne sont pas
 * secrètes.
 */
import { TextField } from "socle-ui";
import type { ClientParamDef } from "./api";

/** Paramètre à saisir : sans valeur par défaut ni caractère facultatif. */
export const paramRequired = (param: ClientParamDef) => !param.optional && !param.default;

/** Erreurs des paramètres obligatoires restés vides, par identifiant. */
export function paramErrors(
  params: ClientParamDef[] | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const param of params ?? []) {
    if (paramRequired(param) && !values[param.id]?.trim()) errors[param.id] = `Saisissez ${paramName(param)}.`;
  }
  return errors;
}

/** Valeurs à enregistrer : seulement celles saisies, sans espaces autour. */
export function paramValues(
  params: ClientParamDef[] | undefined,
  values: Record<string, string>,
): Record<string, string> | undefined {
  const kept: Record<string, string> = {};
  for (const param of params ?? []) {
    const value = values[param.id]?.trim();
    if (value) kept[param.id] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

const paramName = (param: ClientParamDef) => (param.label ? `« ${param.label} »` : `« ${param.id} »`);

export function ParamFields({
  params,
  values,
  errors,
  disabled,
  onChange,
}: {
  params: ClientParamDef[] | undefined;
  values: Record<string, string>;
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
  onChange: (id: string, value: string) => void;
}) {
  if (!params?.length) return null;
  return (
    <>
      {params.map((param) => {
        const hint = [
          param.help,
          param.example ? `Par exemple ${param.example}.` : undefined,
          param.default ? `Laissez vide pour ${param.default}.` : param.optional ? "Facultatif." : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <TextField
            key={param.id}
            label={param.label || param.id}
            isRequired={paramRequired(param)}
            description={hint || undefined}
            error={errors?.[param.id] || undefined}
            value={values[param.id] ?? ""}
            placeholder={param.default ?? param.example}
            autoComplete="off"
            isDisabled={disabled}
            onChange={(value) => onChange(param.id, value)}
          />
        );
      })}
    </>
  );
}
