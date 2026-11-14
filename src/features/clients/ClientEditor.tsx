import {
  Button,
  FeedbackBanner,
  Fieldset,
  FormActions,
  FormControlGroup,
  FormField,
  Page,
  Row,
  Section,
  SelectControl,
  Stack,
  SwitchControl,
  Text,
  TextArea,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { errorMessage, ID_PATTERN, listVault, slugify, type VaultEntry } from "../vault/api";
import { VaultEntryDialog } from "../vault/VaultEntryDialog";
import {
  AUTH_TYPES,
  type AuthType,
  type ClientAuth,
  type ClientConfig,
  type ClientItem,
  type ClientMethod,
  saveClient,
} from "./api";

/** Champs d’une authentification, communs au client à une seule adresse et à chaque méthode. */
interface AuthDraft {
  type: AuthType;
  keyPlace: "header" | "query";
  keyName: string;
  prefix: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string;
}

interface MethodDraft extends AuthDraft {
  /** Clé de rendu, stable pendant l’édition. */
  key: string;
  /** Identifiant enregistré ; vide pour une méthode ajoutée, calculé à l’enregistrement. */
  id: string;
  label: string;
}

interface Draft {
  label: string;
  id: string;
  baseUrl: string;
  /** Plusieurs instances : les méthodes remplacent l’authentification unique et son entrée du coffre. */
  multiple: boolean;
  auth: AuthDraft;
  secret: string;
  methods: MethodDraft[];
  headers: string;
  testPath: string;
}

type AuthErrors = Partial<Record<"keyName" | "authorizationUrl" | "tokenUrl" | "label", string>>;
type Errors = Partial<Record<"label" | "id" | "baseUrl" | "secret" | "headers" | "testPath", string>> & {
  auth?: AuthErrors;
  methods?: Record<string, AuthErrors>;
};

const SECURE_URL = /^https:\/\/\S+$/;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/;
const URL_RULE = "Saisissez une adresse en https:// (http n’est accepté que pour localhost et 127.0.0.1).";

export function urlError(value: string, missing: string): string | undefined {
  const text = value.trim();
  if (!text) return missing;
  return SECURE_URL.test(text) || LOCAL_URL.test(text) ? undefined : URL_RULE;
}

/** Une adresse de méthode peut commencer par `{url}`, l’adresse de l’instance. */
function methodUrlError(value: string, missing: string, multiple: boolean): string | undefined {
  const text = value.trim();
  if (multiple && text.startsWith("{url}")) return undefined;
  return urlError(text, missing);
}

function toAuthDraft(auth: Partial<ClientAuth> | undefined): AuthDraft {
  const source = auth ?? {};
  return {
    type: AUTH_TYPES.some((item) => item.type === source.type) ? (source.type as AuthType) : "none",
    keyPlace: source.queryParam ? "query" : "header",
    keyName: source.queryParam ?? source.header ?? "",
    prefix: source.prefix ?? "",
    authorizationUrl: source.authorizationUrl ?? "",
    tokenUrl: source.tokenUrl ?? "",
    scopes: (source.scopes ?? []).join(" "),
  };
}

let methodKeys = 0;
function toMethodDraft(method: Partial<ClientMethod> = {}): MethodDraft {
  methodKeys += 1;
  return { ...toAuthDraft(method), key: `methode-${methodKeys}`, id: method.id ?? "", label: method.label ?? "" };
}

function toDraft(source: Partial<ClientItem> | undefined): Draft {
  const multiple = source?.simple === false;
  const methods = multiple ? (source?.methods ?? []) : [];
  return {
    label: source?.label ?? "",
    id: source?.id ?? "",
    baseUrl: source?.baseUrl ?? "",
    multiple,
    auth: toAuthDraft(source?.auth),
    secret: source?.auth?.secret ?? "",
    methods: methods.length > 0 ? methods.map(toMethodDraft) : [toMethodDraft()],
    headers: Object.entries(source?.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    testPath: source?.testPath ?? "",
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

const usesTokenUrl = (type: AuthType) => type === "oauth2" || type === "clientCredentials";

function authErrors(auth: AuthDraft, multiple: boolean): AuthErrors {
  return {
    keyName:
      auth.type === "apiKey" && !auth.keyName.trim()
        ? auth.keyPlace === "header"
          ? "Saisissez le nom de l’en-tête."
          : "Saisissez le nom du paramètre."
        : undefined,
    authorizationUrl:
      auth.type === "oauth2"
        ? methodUrlError(auth.authorizationUrl, "Saisissez l’adresse d’autorisation.", multiple)
        : undefined,
    tokenUrl: usesTokenUrl(auth.type)
      ? methodUrlError(auth.tokenUrl, "Saisissez l’adresse du serveur de jetons.", multiple)
      : undefined,
  };
}

const hasErrors = (errors: AuthErrors | undefined) => Object.values(errors ?? {}).some(Boolean);

function toAuth(draft: AuthDraft): ClientAuth {
  const auth: ClientAuth = { type: draft.type };
  if (draft.type === "apiKey") {
    if (draft.keyPlace === "header") auth.header = draft.keyName.trim();
    else auth.queryParam = draft.keyName.trim();
    if (draft.prefix) auth.prefix = draft.prefix;
  }
  if (draft.type === "oauth2") auth.authorizationUrl = draft.authorizationUrl.trim();
  if (usesTokenUrl(draft.type)) {
    auth.tokenUrl = draft.tokenUrl.trim();
    auth.scopes = draft.scopes.split(/[\s,]+/).filter(Boolean);
  }
  return auth;
}

/** Identifiants des méthodes : ceux déjà enregistrés restent, les nouveaux suivent le nom, sans doublon. */
function methodIds(methods: MethodDraft[]): string[] {
  const taken = new Set(methods.map((method) => method.id).filter(Boolean));
  return methods.map((method, index) => {
    if (method.id) return method.id;
    const base = slugify(method.label) || `methode-${index + 1}`;
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
    taken.add(id);
    return id;
  });
}

/** Type d’authentification et champs propres à ce type. */
function AuthFields({
  auth,
  errors,
  multiple,
  onChange,
  typeLabel = "Authentification",
  children,
}: {
  auth: AuthDraft;
  errors: AuthErrors | undefined;
  multiple: boolean;
  onChange: (changes: Partial<AuthDraft>, cleared?: Array<keyof AuthErrors>) => void;
  typeLabel?: string;
  /** Champs à placer juste après le type (l’entrée du coffre d’un client à une seule adresse). */
  children?: ReactNode;
}) {
  const urlHint = multiple ? "« {url} » au début de l’adresse désigne l’adresse de l’instance." : undefined;
  return (
    <>
      <FormField label={typeLabel}>
        <SelectControl
          value={auth.type}
          onChange={(event) =>
            onChange({ type: event.target.value as AuthType }, ["keyName", "authorizationUrl", "tokenUrl"])
          }
        >
          {AUTH_TYPES.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}
            </option>
          ))}
        </SelectControl>
      </FormField>
      {children}
      {auth.type === "apiKey" ? (
        <>
          <FormField label="Emplacement de la clé">
            <SelectControl
              value={auth.keyPlace}
              onChange={(event) => onChange({ keyPlace: event.target.value as AuthDraft["keyPlace"] }, ["keyName"])}
            >
              <option value="header">En-tête HTTP</option>
              <option value="query">Paramètre d’URL</option>
            </SelectControl>
          </FormField>
          <FormField
            label={auth.keyPlace === "header" ? "Nom de l’en-tête" : "Nom du paramètre"}
            error={errors?.keyName}
          >
            <TextInput
              value={auth.keyName}
              placeholder={auth.keyPlace === "header" ? "Ex. X-Api-Key" : "Ex. api_key"}
              aria-required="true"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ keyName: event.target.value }, ["keyName"])}
            />
          </FormField>
          <FormField label="Préfixe (facultatif)" hint="Texte placé devant la clé, espace compris.">
            <TextInput
              value={auth.prefix}
              placeholder="Ex. Token "
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ prefix: event.target.value })}
            />
          </FormField>
        </>
      ) : null}
      {auth.type === "oauth2" ? (
        <FormField label="Adresse d’autorisation" hint={urlHint} error={errors?.authorizationUrl}>
          <TextInput
            value={auth.authorizationUrl}
            placeholder={multiple ? "Ex. {url}/oauth/authorize" : "Ex. https://sso.exemple.com/authorize"}
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => onChange({ authorizationUrl: event.target.value }, ["authorizationUrl"])}
          />
        </FormField>
      ) : null}
      {usesTokenUrl(auth.type) ? (
        <>
          <FormField label="Adresse du serveur de jetons" hint={urlHint} error={errors?.tokenUrl}>
            <TextInput
              value={auth.tokenUrl}
              placeholder={multiple ? "Ex. {url}/oauth/token" : "Ex. https://sso.exemple.com/token"}
              aria-required="true"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              onChange={(event) => onChange({ tokenUrl: event.target.value }, ["tokenUrl"])}
            />
          </FormField>
          <FormField label="Portées (facultatif)" hint="Séparées par des espaces.">
            <TextInput
              value={auth.scopes}
              placeholder="Ex. read write"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ scopes: event.target.value })}
            />
          </FormField>
        </>
      ) : null}
    </>
  );
}

/**
 * Création ou édition d’un client. Un client à une seule adresse porte son authentification et son entrée du
 * coffre ; un client à plusieurs instances propose des méthodes, et chaque instance (ajoutée ensuite) choisit la
 * sienne avec son adresse et son entrée du coffre.
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
  const [draft, setDraft] = useState(() => toDraft(initial ?? (preset as Partial<ClientItem> | undefined)));
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

  const set = (
    changes: Partial<Draft>,
    cleared: Array<"label" | "id" | "baseUrl" | "secret" | "headers" | "testPath"> = [],
  ) => {
    setDraft((current) => ({ ...current, ...changes }));
    if (cleared.length > 0) {
      setErrors((current) => {
        const next = { ...current };
        for (const key of cleared) delete next[key];
        return next;
      });
    }
  };

  const setAuth = (changes: Partial<AuthDraft>, cleared: Array<keyof AuthErrors> = []) => {
    setDraft((current) => {
      const auth = { ...current.auth, ...changes };
      const kind = AUTH_TYPES.find((item) => item.type === auth.type)?.vaultKind;
      const previous = AUTH_TYPES.find((item) => item.type === current.auth.type)?.vaultKind;
      // L’entrée choisie ne reste que si elle convient encore au nouveau type.
      return { ...current, auth, secret: kind === previous ? current.secret : "" };
    });
    setErrors((current) => {
      const auth = { ...current.auth };
      for (const key of cleared) delete auth[key];
      return { ...current, auth, ...(changes.type ? { secret: undefined } : {}) };
    });
  };

  const setMethod = (key: string, changes: Partial<MethodDraft>, cleared: Array<keyof AuthErrors> = []) => {
    setDraft((current) => ({
      ...current,
      methods: current.methods.map((method) => (method.key === key ? { ...method, ...changes } : method)),
    }));
    setErrors((current) => {
      const methods = { ...current.methods };
      const own = { ...methods[key] };
      for (const name of cleared) delete own[name];
      methods[key] = own;
      return { ...current, methods };
    });
  };

  const resolvedId = initial ? initial.id : idEdited ? draft.id.trim() : slugify(draft.label);
  const vaultKind = AUTH_TYPES.find((item) => item.type === draft.auth.type)?.vaultKind;
  const candidates = entries.filter((entry) => entry.kind === vaultKind);
  // Le fichier d’un client voyage avec l’espace, pas le coffre : l’entrée attendue peut manquer sur ce poste.
  const missingEntry = Boolean(draft.secret) && !entries.some((entry) => entry.id === draft.secret);
  // Un client à plusieurs instances le reste : ses instances perdraient leur adresse et leur méthode.
  const canChooseMode = !initial || initial.simple;
  const showsOauthHint = draft.multiple
    ? draft.methods.some((method) => method.type === "oauth2")
    : draft.auth.type === "oauth2";

  const toggleMultiple = (multiple: boolean) => {
    setDraft((current) => ({
      ...current,
      multiple,
      // Passer à plusieurs instances garde l’authentification actuelle comme première méthode : l’instance
      // existante continue de l’utiliser.
      methods:
        multiple && initial?.simple
          ? [{ ...toMethodDraft(), ...current.auth, id: "default", label: "" }]
          : multiple && current.methods.length === 1 && !current.methods[0].label && !initial
            ? [{ ...current.methods[0], ...current.auth }]
            : current.methods,
    }));
    setErrors({});
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const headers = parseHeaders(draft.headers);
    const testPath = draft.testPath.trim();
    const methodErrors: Record<string, AuthErrors> = {};
    if (draft.multiple) {
      for (const method of draft.methods) {
        const own = authErrors(method, true);
        if (draft.methods.length > 1 && !method.label.trim() && method.id !== "default")
          own.label = "Saisissez le nom de la méthode.";
        methodErrors[method.key] = own;
      }
    }
    const next: Errors = {
      label: draft.label.trim() ? undefined : "Saisissez un libellé.",
      id: ID_PATTERN.test(resolvedId)
        ? undefined
        : "Saisissez un identifiant en minuscules, chiffres et tirets (64 caractères au plus).",
      baseUrl: draft.multiple
        ? draft.baseUrl.trim()
          ? urlError(draft.baseUrl, "")
          : undefined
        : urlError(draft.baseUrl, "Saisissez l’adresse de base."),
      secret: !draft.multiple && vaultKind && !draft.secret ? "Choisissez une entrée du coffre." : undefined,
      headers: headers ? undefined : "Écrivez un en-tête par ligne, sous la forme « Nom: valeur ».",
      testPath:
        !testPath || testPath.startsWith("/") ? undefined : "Saisissez un chemin qui commence par « / », ex. /me.",
      auth: draft.multiple ? undefined : authErrors(draft.auth, false),
      methods: draft.multiple ? methodErrors : undefined,
    };
    setErrors(next);
    const invalid =
      [next.label, next.id, next.baseUrl, next.secret, next.headers, next.testPath].some(Boolean) ||
      hasErrors(next.auth) ||
      Object.values(methodErrors).some(hasErrors);
    if (invalid || !headers) return;

    let config: ClientConfig;
    if (draft.multiple) {
      const ids = methodIds(draft.methods);
      config = {
        id: resolvedId,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        methods: draft.methods.map((method, index) => ({
          id: ids[index],
          ...(method.label.trim() ? { label: method.label.trim() } : {}),
          ...toAuth(method),
        })),
        headers,
        ...(testPath ? { testPath } : {}),
      };
    } else {
      const auth = toAuth(draft.auth);
      if (vaultKind) auth.secret = draft.secret;
      config = {
        id: resolvedId,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        auth,
        headers,
        ...(testPath ? { testPath } : {}),
      };
    }
    setPending(true);
    try {
      const saved = await saveClient(config, !initial);
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
            {canChooseMode ? (
              <FormField
                label="Instances"
                hint="Plusieurs comptes ou installations du même service (plusieurs sites Jira, plusieurs boîtes mail) : chacune aura son adresse, sa méthode et son secret."
              >
                <SwitchControl
                  label="Plusieurs instances"
                  checked={draft.multiple}
                  onChange={(event) => toggleMultiple(event.target.checked)}
                />
              </FormField>
            ) : null}
            <FormField
              label={draft.multiple ? "Adresse par défaut (facultative)" : "Adresse de base"}
              hint={
                draft.multiple
                  ? "Proposée aux instances qui n’ont pas la leur. Laissez vide si chaque instance a son adresse."
                  : "Les pages ne peuvent appeler que des chemins situés sous cette adresse."
              }
              error={errors.baseUrl}
            >
              <TextInput
                value={draft.baseUrl}
                placeholder="Ex. https://jira.exemple.com"
                aria-required={draft.multiple ? undefined : "true"}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                onChange={(event) => set({ baseUrl: event.target.value }, ["baseUrl"])}
              />
            </FormField>

            {draft.multiple ? (
              <Stack gap="md">
                <Text tone="muted">
                  Méthodes d’authentification que les instances pourront choisir. Le secret de chaque instance se
                  choisit avec elle.
                </Text>
                {draft.methods.map((method, index) => (
                  <Fieldset key={method.key} legend={method.label.trim() || `Méthode ${index + 1}`}>
                    <Stack gap="md">
                      <FormField label="Nom de la méthode" error={errors.methods?.[method.key]?.label}>
                        <TextInput
                          value={method.label}
                          placeholder="Ex. Jira Cloud (jeton d’API)"
                          autoComplete="off"
                          onChange={(event) => setMethod(method.key, { label: event.target.value }, ["label"])}
                        />
                      </FormField>
                      <AuthFields
                        auth={method}
                        errors={errors.methods?.[method.key]}
                        multiple
                        onChange={(changes, cleared) => setMethod(method.key, changes, cleared)}
                      />
                      {draft.methods.length > 1 ? (
                        <Row justify="end">
                          <Button
                            aria-label={`Retirer la méthode ${method.label.trim() || index + 1}`}
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                methods: current.methods.filter((known) => known.key !== method.key),
                              }))
                            }
                          >
                            Retirer
                          </Button>
                        </Row>
                      ) : null}
                    </Stack>
                  </Fieldset>
                ))}
                <Row>
                  <Button
                    onClick={() =>
                      setDraft((current) => ({ ...current, methods: [...current.methods, toMethodDraft()] }))
                    }
                  >
                    Ajouter une méthode
                  </Button>
                </Row>
              </Stack>
            ) : (
              <AuthFields auth={draft.auth} errors={errors.auth} multiple={false} onChange={setAuth}>
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
                        {missingEntry ? (
                          <option value={draft.secret}>{draft.secret} (absente de ce poste)</option>
                        ) : null}
                      </SelectControl>
                      <Button onClick={() => setCreatingEntry(true)}>Nouvelle entrée</Button>
                    </FormControlGroup>
                  </FormField>
                ) : null}
              </AuthFields>
            )}
            {showsOauthHint && redirectUri ? (
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
            <FormField
              label="Chemin de test (facultatif)"
              hint="Lu par le bouton Tester. Choisissez une lecture qui demande l’authentification, ex. /me ; sans chemin, Tester lit la racine de l’adresse de base."
              error={errors.testPath}
            >
              <TextInput
                value={draft.testPath}
                placeholder="Ex. /me"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ testPath: event.target.value }, ["testPath"])}
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
