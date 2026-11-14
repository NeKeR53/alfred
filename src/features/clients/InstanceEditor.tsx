import {
  Button,
  FeedbackBanner,
  FormActions,
  FormControlGroup,
  FormField,
  Page,
  Section,
  SelectControl,
  Stack,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage, ID_PATTERN, listVault, slugify, type VaultEntry } from "../vault/api";
import { VaultEntryDialog } from "../vault/VaultEntryDialog";
import {
  AUTH_TYPES,
  type ClientInstanceConfig,
  type ClientInstanceItem,
  type ClientItem,
  methodLabel,
  saveInstance,
} from "./api";
import { urlError } from "./ClientEditor";

type Errors = Partial<Record<"label" | "id" | "url" | "secret", string>>;

/**
 * Ajout ou modification d’une instance d’un client : son nom, son adresse, la méthode d’authentification qu’elle
 * utilise et son entrée du coffre. L’enregistrer depuis les Réglages vaut validation.
 */
export function InstanceEditor({
  client,
  initial,
  redirectUri,
  onCancel,
  onSaved,
}: {
  client: ClientItem;
  /** Instance à modifier ; absente pour un ajout. */
  initial?: ClientInstanceItem;
  redirectUri: string | null;
  onCancel: () => void;
  onSaved: (client: ClientItem) => void;
}) {
  const formId = useId();
  const secretId = useId();
  const [label, setLabel] = useState(
    initial?.id === "default" && initial.label === "Principale" ? "" : (initial?.label ?? ""),
  );
  const [id, setId] = useState(initial?.id ?? "");
  const [idEdited, setIdEdited] = useState(Boolean(initial));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [method, setMethod] = useState(initial?.method ?? client.methods[0]?.id ?? "");
  const [secret, setSecret] = useState(initial?.secret ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [creatingEntry, setCreatingEntry] = useState(false);

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await listVault());
    } catch (failure) {
      notify({ title: "Le coffre n’a pas pu être lu", description: errorMessage(failure), tone: "error" });
    }
  }, []);

  useEffect(() => {
    void loadEntries();
    return onNativeEvent("vault:changed", () => void loadEntries());
  }, [loadEntries]);

  const clear = (key: keyof Errors) =>
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  const chosen = client.methods.find((known) => known.id === method);
  const vaultKind = AUTH_TYPES.find((item) => item.type === chosen?.type)?.vaultKind;
  const candidates = entries.filter((entry) => entry.kind === vaultKind);
  const missingEntry = Boolean(secret) && !entries.some((entry) => entry.id === secret);
  const resolvedId = initial ? initial.id : idEdited ? id.trim() : slugify(label);
  // L’instance d’un client à une seule adresse n’a pas toujours de nom : « Principale » s’affiche à sa place.
  const unnamedDefault = initial?.id === "default";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {
      label: label.trim() || unnamedDefault ? undefined : "Saisissez le nom de l’instance.",
      id: ID_PATTERN.test(resolvedId)
        ? undefined
        : "Saisissez un identifiant en minuscules, chiffres et tirets (64 caractères au plus).",
      url: url.trim() ? urlError(url, "") : client.baseUrl ? undefined : "Saisissez l’adresse de l’instance.",
      secret: vaultKind && !secret ? "Choisissez une entrée du coffre." : undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const instance: ClientInstanceConfig = { id: resolvedId, label: label.trim(), method };
    if (url.trim()) instance.url = url.trim();
    if (vaultKind) instance.secret = secret;
    setPending(true);
    try {
      const saved = await saveInstance(client.id, instance, !initial);
      notify({ title: initial ? "Instance enregistrée" : "Instance ajoutée", tone: "success" });
      onSaved(saved);
    } catch (failure) {
      notify({
        title: initial ? "L’instance n’a pas été enregistrée" : "L’instance n’a pas été ajoutée",
        description: errorMessage(failure),
        tone: "error",
      });
      setPending(false);
    }
  };

  return (
    <Page width="text">
      <Section
        title={
          initial
            ? `Modifier l’instance « ${initial.label} » de ${client.label}`
            : `Nouvelle instance de ${client.label}`
        }
        description="Une instance est un compte ou une installation du service. Son secret reste dans le coffre : l’instance n’en garde que l’identifiant."
      >
        <form id={formId} noValidate onSubmit={submit}>
          <Stack gap="md">
            <FormField label="Nom de l’instance" error={errors.label}>
              <TextInput
                value={label}
                placeholder={unnamedDefault ? "Principale" : "Ex. Acme"}
                aria-required={unnamedDefault ? undefined : "true"}
                autoComplete="off"
                onChange={(event) => {
                  setLabel(event.target.value);
                  clear("label");
                  clear("id");
                }}
              />
            </FormField>
            <FormField
              label="Identifiant de l’instance"
              hint={
                initial
                  ? "Les pages choisissent l’instance par cet identifiant : il ne se modifie pas."
                  : "Nom par lequel une page choisit cette instance. Minuscules, chiffres et tirets."
              }
              error={errors.id}
            >
              <TextInput
                value={resolvedId}
                disabled={Boolean(initial)}
                aria-required="true"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setIdEdited(true);
                  setId(event.target.value);
                  clear("id");
                }}
              />
            </FormField>
            <FormField
              label="Adresse de l’instance"
              hint={
                client.baseUrl
                  ? `Laissez vide pour utiliser l’adresse du client (${client.baseUrl}).`
                  : "Les pages ne peuvent appeler que des chemins situés sous cette adresse."
              }
              error={errors.url}
            >
              <TextInput
                value={url}
                placeholder={client.baseUrl || "Ex. https://acme.atlassian.net"}
                aria-required={client.baseUrl ? undefined : "true"}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                onChange={(event) => {
                  setUrl(event.target.value);
                  clear("url");
                }}
              />
            </FormField>
            {client.methods.length > 1 ? (
              <FormField label="Méthode d’authentification">
                <SelectControl
                  value={method}
                  onChange={(event) => {
                    const next = client.methods.find((known) => known.id === event.target.value);
                    const kind = AUTH_TYPES.find((item) => item.type === next?.type)?.vaultKind;
                    setMethod(event.target.value);
                    // L’entrée choisie ne reste que si elle convient encore à la méthode.
                    if (kind !== vaultKind) setSecret("");
                    clear("secret");
                  }}
                >
                  {client.methods.map((known) => (
                    <option key={known.id} value={known.id}>
                      {methodLabel(known)}
                    </option>
                  ))}
                </SelectControl>
              </FormField>
            ) : null}
            {vaultKind ? (
              <FormField
                label="Entrée du coffre"
                compound
                htmlFor={secretId}
                hint={
                  missingEntry
                    ? "Cette entrée n’existe pas sur ce poste. « Nouvelle entrée » la crée avec cet identifiant."
                    : "Le secret reste dans le coffre ; l’instance n’en garde que l’identifiant."
                }
                error={errors.secret}
              >
                <FormControlGroup>
                  <SelectControl
                    id={secretId}
                    value={secret}
                    aria-required="true"
                    onChange={(event) => {
                      setSecret(event.target.value);
                      clear("secret");
                    }}
                  >
                    <option value="">Choisir une entrée…</option>
                    {candidates.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                    {missingEntry ? <option value={secret}>{secret} (absente de ce poste)</option> : null}
                  </SelectControl>
                  <Button onClick={() => setCreatingEntry(true)}>Nouvelle entrée</Button>
                </FormControlGroup>
              </FormField>
            ) : null}
            {chosen?.type === "oauth2" && redirectUri ? (
              <FeedbackBanner tone="info" appearance="contained">
                Adresse de retour à déclarer chez le fournisseur d’identité : {redirectUri}
              </FeedbackBanner>
            ) : null}
            <FormActions
              form={formId}
              submitLabel={initial ? "Enregistrer" : "Ajouter"}
              pendingLabel={initial ? "Enregistrement…" : "Ajout…"}
              pending={pending}
              onCancel={onCancel}
            />
          </Stack>
        </form>
      </Section>
      {creatingEntry && vaultKind ? (
        <VaultEntryDialog
          fixedKind={vaultKind}
          suggested={{
            id: missingEntry ? secret : undefined,
            label: [client.label, label.trim()].filter(Boolean).join(" — ") || undefined,
          }}
          onClose={() => setCreatingEntry(false)}
          onSaved={(entry) => {
            setEntries((current) => [...current.filter((known) => known.id !== entry.id), entry]);
            setSecret(entry.id);
            clear("secret");
          }}
        />
      ) : null}
    </Page>
  );
}
