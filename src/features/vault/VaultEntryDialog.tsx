import { type FormEvent, useState } from "react";
import { Button, Dialog, Select, TextField } from "socle-ui";
import { Stack } from "../../kit";
import { notify } from "../../shell/notifications";
import {
  errorMessage,
  ID_PATTERN,
  saveVaultEntry,
  slugify,
  VAULT_KINDS,
  type VaultEntry,
  type VaultKind,
  vaultKindLabel,
} from "./api";

interface KindFields {
  /** Champ non secret, rangé dans `meta`. */
  meta?: { name: string; label: string; missing: string };
  secret: { name: string; label: string; required: boolean; missing: string };
}

const CLIENT_ID = { name: "clientId", label: "Identifiant client", missing: "Saisissez l’identifiant client." };

const FIELDS: Record<VaultKind, KindFields> = {
  token: { secret: { name: "value", label: "Valeur", required: true, missing: "Saisissez la valeur." } },
  basic: {
    meta: { name: "username", label: "Identifiant de connexion", missing: "Saisissez l’identifiant de connexion." },
    secret: { name: "password", label: "Mot de passe", required: true, missing: "Saisissez le mot de passe." },
  },
  oauth2: {
    meta: CLIENT_ID,
    secret: { name: "clientSecret", label: "Secret client (facultatif)", required: false, missing: "" },
  },
  clientCredentials: {
    meta: CLIENT_ID,
    secret: { name: "clientSecret", label: "Secret client", required: true, missing: "Saisissez le secret client." },
  },
};

type Errors = Partial<Record<"label" | "id" | "meta" | "secret", string>>;

/**
 * Création ou édition d’une entrée du coffre. Le champ secret n’est jamais prérempli : Alfred ne renvoie pas la
 * valeur enregistrée, et le laisser vide la conserve.
 */
export function VaultEntryDialog({
  entry,
  fixedKind,
  suggested,
  onClose,
  onSaved,
}: {
  /** Entrée à modifier ; absente pour une création. */
  entry?: VaultEntry;
  /** Type imposé à la création (raccourci depuis un client qui attend ce type). */
  fixedKind?: VaultKind;
  /** Valeurs proposées à la création. */
  suggested?: { id?: string; label?: string };
  onClose: () => void;
  onSaved: (entry: VaultEntry) => void;
}) {
  const formId = "coffre-entree";
  const [label, setLabel] = useState(entry?.label ?? suggested?.label ?? "");
  const [id, setId] = useState(entry?.id ?? suggested?.id ?? "");
  // Tant que l’identifiant n’a pas été saisi à la main, il suit le libellé.
  const [idEdited, setIdEdited] = useState(Boolean(entry || suggested?.id));
  const [kind, setKind] = useState<VaultKind>(entry?.kind ?? fixedKind ?? "token");
  const fields = FIELDS[kind];
  const [meta, setMeta] = useState(fields.meta ? (entry?.meta[fields.meta.name] ?? "") : "");
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  const resolvedId = entry ? entry.id : idEdited ? id.trim() : slugify(label);
  const keepsSecret = Boolean(entry?.hasSecret);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {
      label: label.trim() ? undefined : "Saisissez un libellé.",
      id: ID_PATTERN.test(resolvedId)
        ? undefined
        : "Saisissez un identifiant en minuscules, chiffres et tirets (64 caractères au plus).",
      meta: !fields.meta || meta.trim() ? undefined : fields.meta.missing,
      secret: !fields.secret.required || secret || keepsSecret ? undefined : fields.secret.missing,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setPending(true);
    try {
      const saved = await saveVaultEntry({
        id: resolvedId,
        label: label.trim(),
        kind,
        meta: fields.meta ? { [fields.meta.name]: meta.trim() } : {},
        secrets: secret ? { [fields.secret.name]: secret } : {},
      });
      notify({ title: entry ? "Mot de passe ou clé enregistré" : "Mot de passe ou clé ajouté", tone: "success" });
      onSaved(saved);
      onClose();
    } catch (error) {
      notify({
        title: entry
          ? "Le mot de passe ou la clé n’a pas été enregistré"
          : "Le mot de passe ou la clé n’a pas été ajouté",
        description: errorMessage(error),
        tone: "error",
      });
      setPending(false);
    }
  };

  return (
    <Dialog
      isOpen
      title={entry ? `Modifier « ${entry.label} »` : "Nouveau mot de passe ou clé"}
      // Pas de fermeture pendant l’écriture au trousseau : le résultat doit rester visible.
      isBusy={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose} isDisabled={pending}>
            Annuler
          </Button>
          <Button type="submit" form={formId} variant="primary" isPending={pending}>
            {entry ? "Enregistrer" : "Créer"}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit}>
        <Stack gap="md">
          <TextField
            label="Libellé"
            isRequired
            autoComplete="off"
            error={errors.label}
            value={label}
            onChange={(value) => {
              setLabel(value);
              setErrors((current) => ({ ...current, label: undefined }));
            }}
          />
          <TextField
            label="Identifiant"
            isRequired
            isDisabled={Boolean(entry)}
            autoComplete="off"
            description={
              entry
                ? "Les services le désignent par cet identifiant : il ne se modifie pas."
                : "Les services le désignent par cet identifiant. Minuscules, chiffres et tirets."
            }
            error={errors.id}
            value={resolvedId}
            onChange={(value) => {
              setId(value);
              setIdEdited(true);
              setErrors((current) => ({ ...current, id: undefined }));
            }}
          />
          <Select
            label="Type"
            isDisabled={Boolean(entry || fixedKind)}
            value={kind}
            options={VAULT_KINDS.map((item) => ({ id: item.kind, label: vaultKindLabel(item.kind) }))}
            onChange={(value) => {
              if (!value) return;
              setKind(value as VaultKind);
              setMeta("");
              setSecret("");
              setErrors({});
            }}
          />
          {fields.meta ? (
            <TextField
              label={fields.meta.label}
              isRequired
              autoComplete="off"
              error={errors.meta}
              value={meta}
              onChange={(value) => {
                setMeta(value);
                setErrors((current) => ({ ...current, meta: undefined }));
              }}
            />
          ) : null}
          <TextField
            type="password"
            label={fields.secret.label}
            isRequired={fields.secret.required && !keepsSecret}
            autoComplete="new-password"
            description={
              keepsSecret
                ? "Laisser vide pour conserver la valeur enregistrée."
                : "Rangé dans le trousseau de ce poste ; Alfred ne l’affiche jamais."
            }
            error={errors.secret}
            value={secret}
            onChange={(value) => {
              setSecret(value);
              setErrors((current) => ({ ...current, secret: undefined }));
            }}
          />
        </Stack>
      </form>
    </Dialog>
  );
}
