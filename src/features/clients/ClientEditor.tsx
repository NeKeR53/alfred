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
  TextArea,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage, ID_PATTERN, listVault, slugify, type VaultEntry } from "../vault/api";
import { VaultEntryDialog } from "../vault/VaultEntryDialog";
import { AUTH_TYPES, type AuthType, type ClientAuth, type ClientConfig, type ClientItem, saveClient } from "./api";

interface Draft {
  label: string;
  id: string;
  baseUrl: string;
  type: AuthType;
  secret: string;
  keyPlace: "header" | "query";
  keyName: string;
  prefix: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string;
  headers: string;
}

type Errors = Partial<
  Record<"label" | "id" | "baseUrl" | "secret" | "keyName" | "authorizationUrl" | "tokenUrl" | "headers", string>
>;

const SECURE_URL = /^https:\/\/\S+$/;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/;
const URL_RULE = "Saisissez une adresse en https:// (http n’est accepté que pour localhost et 127.0.0.1).";

function urlError(value: string, missing: string): string | undefined {
  const text = value.trim();
  if (!text) return missing;
  return SECURE_URL.test(text) || LOCAL_URL.test(text) ? undefined : URL_RULE;
}

function toDraft(source: Partial<ClientConfig> | undefined): Draft {
  const auth: Partial<ClientAuth> = source?.auth ?? {};
  return {
    label: source?.label ?? "",
    id: source?.id ?? "",
    baseUrl: source?.baseUrl ?? "",
    type: AUTH_TYPES.some((item) => item.type === auth.type) ? (auth.type as AuthType) : "none",
    secret: auth.secret ?? "",
    keyPlace: auth.queryParam ? "query" : "header",
    keyName: auth.queryParam ?? auth.header ?? "",
    prefix: auth.prefix ?? "",
    authorizationUrl: auth.authorizationUrl ?? "",
    tokenUrl: auth.tokenUrl ?? "",
    scopes: (auth.scopes ?? []).join(" "),
    headers: Object.entries(source?.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  };
}

/** Lit « Nom: valeur » ligne par ligne ; `null` si une ligne n’a pas cette forme. */
function parseHeaders(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).trim();
    if (separator < 1 || !name) return null;
    headers[name] = line.slice(separator + 1).trim();
  }
  return headers;
}

/**
 * Création ou édition d’un client. Le formulaire ne montre que les champs utiles au type d’authentification choisi,
 * et ne propose que les entrées du coffre du type correspondant.
 */
export function ClientEditor({
  initial,
  preset,
  redirectUri,
  onCancel,
  onSaved,
}: {
  /** Client à modifier ; absent pour une création. */
  initial?: ClientItem;
  /** Valeurs proposées à la création, par exemple celles que demande un module. */
  preset?: Partial<ClientConfig>;
  redirectUri: string | null;
  onCancel: () => void;
  onSaved: (client: ClientItem) => void;
}) {
  const formId = useId();
  const secretId = useId();
  const [draft, setDraft] = useState(() => toDraft(initial ?? preset));
  // Tant que l’identifiant n’a pas été saisi à la main, il suit le libellé.
  const [idEdited, setIdEdited] = useState(Boolean(initial || preset?.id));
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

  const set = (changes: Partial<Draft>, cleared: Array<keyof Errors> = []) => {
    setDraft((current) => ({ ...current, ...changes }));
    if (cleared.length > 0) {
      setErrors((current) => {
        const next = { ...current };
        for (const key of cleared) delete next[key];
        return next;
      });
    }
  };

  const resolvedId = initial ? initial.id : idEdited ? draft.id.trim() : slugify(draft.label);
  const vaultKind = AUTH_TYPES.find((item) => item.type === draft.type)?.vaultKind;
  const candidates = entries.filter((entry) => entry.kind === vaultKind);
  // Le fichier d’un client voyage avec l’espace, pas le coffre : l’entrée attendue peut manquer sur ce poste.
  const missingEntry = Boolean(draft.secret) && !entries.some((entry) => entry.id === draft.secret);
  const usesTokenUrl = draft.type === "oauth2" || draft.type === "clientCredentials";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const headers = parseHeaders(draft.headers);
    const next: Errors = {
      label: draft.label.trim() ? undefined : "Saisissez un libellé.",
      id: ID_PATTERN.test(resolvedId)
        ? undefined
        : "Saisissez un identifiant en minuscules, chiffres et tirets (64 caractères au plus).",
      baseUrl: urlError(draft.baseUrl, "Saisissez l’adresse de base."),
      secret: vaultKind && !draft.secret ? "Choisissez une entrée du coffre." : undefined,
      keyName:
        draft.type === "apiKey" && !draft.keyName.trim()
          ? draft.keyPlace === "header"
            ? "Saisissez le nom de l’en-tête."
            : "Saisissez le nom du paramètre."
          : undefined,
      authorizationUrl:
        draft.type === "oauth2" ? urlError(draft.authorizationUrl, "Saisissez l’adresse d’autorisation.") : undefined,
      tokenUrl: usesTokenUrl ? urlError(draft.tokenUrl, "Saisissez l’adresse du serveur de jetons.") : undefined,
      headers: headers ? undefined : "Écrivez un en-tête par ligne, sous la forme « Nom: valeur ».",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean) || !headers) return;

    const auth: ClientAuth = { type: draft.type };
    if (vaultKind) auth.secret = draft.secret;
    if (draft.type === "apiKey") {
      if (draft.keyPlace === "header") auth.header = draft.keyName.trim();
      else auth.queryParam = draft.keyName.trim();
      if (draft.prefix) auth.prefix = draft.prefix;
    }
    if (draft.type === "oauth2") auth.authorizationUrl = draft.authorizationUrl.trim();
    if (usesTokenUrl) {
      auth.tokenUrl = draft.tokenUrl.trim();
      auth.scopes = draft.scopes.split(/[\s,]+/).filter(Boolean);
    }
    setPending(true);
    try {
      const saved = await saveClient(
        { id: resolvedId, label: draft.label.trim(), baseUrl: draft.baseUrl.trim(), auth, headers },
        !initial,
      );
      notify({ title: initial ? "Client enregistré" : "Client créé", tone: "success" });
      onSaved(saved);
    } catch (failure) {
      notify({
        title: initial ? "Le client n’a pas été enregistré" : "Le client n’a pas été créé",
        description: errorMessage(failure),
        tone: "error",
      });
      setPending(false);
    }
  };

  return (
    <Page width="text">
      <Section
        title={initial ? `Modifier « ${initial.label} »` : "Nouveau client"}
        description="Le client est enregistré dans l’espace, sans aucun secret : seul l’identifiant de l’entrée du coffre y figure."
      >
        <form id={formId} noValidate onSubmit={submit}>
          <Stack gap="md">
            <FormField label="Libellé" error={errors.label}>
              <TextInput
                value={draft.label}
                aria-required="true"
                autoComplete="off"
                onChange={(event) => set({ label: event.target.value }, ["label", "id"])}
              />
            </FormField>
            <FormField
              label="Identifiant"
              hint={
                initial
                  ? "Les pages appellent le client par cet identifiant : il ne se modifie pas."
                  : "Nom par lequel les pages et les modules appellent ce client. Minuscules, chiffres et tirets."
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
                  set({ id: event.target.value }, ["id"]);
                }}
              />
            </FormField>
            <FormField
              label="Adresse de base"
              hint="Les pages ne peuvent appeler que des chemins situés sous cette adresse."
              error={errors.baseUrl}
            >
              <TextInput
                value={draft.baseUrl}
                placeholder="Ex. https://jira.exemple.com"
                aria-required="true"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                onChange={(event) => set({ baseUrl: event.target.value }, ["baseUrl"])}
              />
            </FormField>
            <FormField label="Authentification">
              <SelectControl
                value={draft.type}
                onChange={(event) => {
                  const type = event.target.value as AuthType;
                  const kind = AUTH_TYPES.find((item) => item.type === type)?.vaultKind;
                  // L’entrée choisie ne reste que si elle convient encore au nouveau type.
                  set({ type, secret: kind === vaultKind ? draft.secret : "" }, [
                    "secret",
                    "keyName",
                    "authorizationUrl",
                    "tokenUrl",
                  ]);
                }}
              >
                {AUTH_TYPES.map((item) => (
                  <option key={item.type} value={item.type}>
                    {item.label}
                  </option>
                ))}
              </SelectControl>
            </FormField>

            {vaultKind ? (
              <FormField
                label="Entrée du coffre"
                compound
                htmlFor={secretId}
                hint={
                  missingEntry
                    ? "Cette entrée n’existe pas sur ce poste. « Nouvelle entrée » la crée avec cet identifiant."
                    : "Le secret reste dans le coffre ; le client n’en garde que l’identifiant."
                }
                error={errors.secret}
              >
                <FormControlGroup>
                  <SelectControl
                    id={secretId}
                    value={draft.secret}
                    aria-required="true"
                    onChange={(event) => set({ secret: event.target.value }, ["secret"])}
                  >
                    <option value="">Choisir une entrée…</option>
                    {candidates.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                    {missingEntry ? <option value={draft.secret}>{draft.secret} (absente de ce poste)</option> : null}
                  </SelectControl>
                  <Button onClick={() => setCreatingEntry(true)}>Nouvelle entrée</Button>
                </FormControlGroup>
              </FormField>
            ) : null}

            {draft.type === "apiKey" ? (
              <>
                <FormField label="Emplacement de la clé">
                  <SelectControl
                    value={draft.keyPlace}
                    onChange={(event) => set({ keyPlace: event.target.value as Draft["keyPlace"] }, ["keyName"])}
                  >
                    <option value="header">En-tête HTTP</option>
                    <option value="query">Paramètre d’URL</option>
                  </SelectControl>
                </FormField>
                <FormField
                  label={draft.keyPlace === "header" ? "Nom de l’en-tête" : "Nom du paramètre"}
                  error={errors.keyName}
                >
                  <TextInput
                    value={draft.keyName}
                    placeholder={draft.keyPlace === "header" ? "Ex. X-Api-Key" : "Ex. api_key"}
                    aria-required="true"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => set({ keyName: event.target.value }, ["keyName"])}
                  />
                </FormField>
                <FormField label="Préfixe (facultatif)" hint="Texte placé devant la clé, espace compris.">
                  <TextInput
                    value={draft.prefix}
                    placeholder="Ex. Token "
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => set({ prefix: event.target.value })}
                  />
                </FormField>
              </>
            ) : null}

            {draft.type === "oauth2" ? (
              <FormField label="Adresse d’autorisation" error={errors.authorizationUrl}>
                <TextInput
                  value={draft.authorizationUrl}
                  placeholder="Ex. https://sso.exemple.com/authorize"
                  aria-required="true"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  onChange={(event) => set({ authorizationUrl: event.target.value }, ["authorizationUrl"])}
                />
              </FormField>
            ) : null}
            {usesTokenUrl ? (
              <>
                <FormField label="Adresse du serveur de jetons" error={errors.tokenUrl}>
                  <TextInput
                    value={draft.tokenUrl}
                    placeholder="Ex. https://sso.exemple.com/token"
                    aria-required="true"
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                    onChange={(event) => set({ tokenUrl: event.target.value }, ["tokenUrl"])}
                  />
                </FormField>
                <FormField label="Portées (facultatif)" hint="Séparées par des espaces.">
                  <TextInput
                    value={draft.scopes}
                    placeholder="Ex. read write"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => set({ scopes: event.target.value })}
                  />
                </FormField>
              </>
            ) : null}
            {draft.type === "oauth2" && redirectUri ? (
              <FeedbackBanner tone="info" appearance="contained">
                Adresse de retour à déclarer chez le fournisseur d’identité : {redirectUri}
              </FeedbackBanner>
            ) : null}

            <FormField
              label="En-têtes fixes (facultatif)"
              hint="Un en-tête par ligne, sous la forme « Nom: valeur ». L’authentification n’en fait pas partie : elle vient du coffre."
              error={errors.headers}
            >
              <TextArea
                value={draft.headers}
                placeholder="Ex. Accept: application/json"
                spellCheck={false}
                onChange={(event) => set({ headers: event.target.value }, ["headers"])}
              />
            </FormField>

            <FormActions
              form={formId}
              submitLabel={initial ? "Enregistrer" : "Créer"}
              pendingLabel={initial ? "Enregistrement…" : "Création…"}
              pending={pending}
              onCancel={onCancel}
            />
          </Stack>
        </form>
      </Section>
      {creatingEntry && vaultKind ? (
        <VaultEntryDialog
          fixedKind={vaultKind}
          suggested={{ id: missingEntry ? draft.secret : undefined, label: draft.label.trim() || undefined }}
          onClose={() => setCreatingEntry(false)}
          onSaved={(entry) => {
            // Ajoutée tout de suite à la liste : le choix ne passe pas par un état « absente de ce poste ».
            setEntries((current) => [...current.filter((known) => known.id !== entry.id), entry]);
            set({ secret: entry.id }, ["secret"]);
          }}
        />
      ) : null}
    </Page>
  );
}
