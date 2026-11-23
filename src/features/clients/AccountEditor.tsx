/**
 * Un compte chez un service, du point de vue de l’utilisateur : ses identifiants, et rien d’autre.
 *
 * La façon de se connecter (adresse du service, type d’authentification, en-têtes, chemin de test) est décrite par
 * le module, donc par l’agent : l’utilisateur ne la voit ni ne la change. Il ne donne que ce qui lui est propre :
 * l’adresse de son compte quand le service n’en a pas une fixe, la façon de se connecter quand le module en propose
 * plusieurs, et son identifiant, son mot de passe ou son jeton. Le nom et l’identifiant technique du compte, comme
 * l’entrée du coffre qui garde le secret, se déduisent seuls.
 */
import { type FormEvent, useEffect, useState } from "react";
import { Button, Checkbox, Disclosure, Select, TextArea, TextField } from "socle-ui";
import { Notice, Row, Stack, Text } from "../../kit";
import { notify } from "../../shell/notifications";
import { ModulePart } from "../modules/ModulePart";
import { errorMessage, listVault, saveVaultEntry, type VaultEntry, type VaultKind } from "../vault/api";
import { AccountPages } from "./AccountPages";
import {
  AUTH_TYPES,
  type AuthType,
  type ClientConfig,
  type ClientInstanceConfig,
  type ClientInstanceItem,
  type ClientItem,
  methodLabel,
  saveInstance,
} from "./api";
import { ParamFields, paramErrors, paramValues } from "./ParamFields";

const SECURE_URL = /^https:\/\/[^\s/?#]+[^\s?#]*$/i;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\s?#]*)?$/i;

/** Adresse en https:// (ou locale), sans paramètres ni ancre. */
export function urlError(value: string, missing: string): string | undefined {
  const text = value.trim();
  if (!text) return missing;
  return SECURE_URL.test(text) || LOCAL_URL.test(text)
    ? undefined
    : "Saisissez une adresse en https://, sans paramètres ni ancre (ex. https://acme.atlassian.net).";
}

/** Ce que l’utilisateur saisit, selon la façon de se connecter. */
interface Fields {
  /** Champ visible (non secret), rangé à part du secret. */
  login?: { name: string; label: string; missing: string };
  secret?: { name: string; label: string; required: boolean; missing: string };
}

function fieldsOf(type: AuthType | undefined): Fields {
  switch (type) {
    case "bearer":
      return { secret: { name: "value", label: "Jeton d’accès", required: true, missing: "Saisissez le jeton." } };
    case "apiKey":
      return { secret: { name: "value", label: "Clé d’API", required: true, missing: "Saisissez la clé." } };
    case "basic":
    case "session":
      return {
        login: { name: "username", label: "Identifiant", missing: "Saisissez votre identifiant." },
        secret: { name: "password", label: "Mot de passe", required: true, missing: "Saisissez le mot de passe." },
      };
    case "secretUrl":
      return {
        secret: {
          name: "value",
          label: "Adresse secrète (avec son jeton)",
          required: true,
          missing: "Collez l’adresse secrète.",
        },
      };
    case "oauth2":
      return {
        login: { name: "clientId", label: "Identifiant client", missing: "Saisissez l’identifiant client." },
        secret: { name: "clientSecret", label: "Secret client (facultatif)", required: false, missing: "" },
      };
    case "clientCredentials":
      return {
        login: { name: "clientId", label: "Identifiant client", missing: "Saisissez l’identifiant client." },
        secret: {
          name: "clientSecret",
          label: "Secret client",
          required: true,
          missing: "Saisissez le secret client.",
        },
      };
    default:
      return {};
  }
}

const vaultKindOf = (type: AuthType | undefined): VaultKind | undefined =>
  AUTH_TYPES.find((item) => item.type === type)?.vaultKind;

/** Identifiant libre pour un nouveau compte : « compte », puis « compte-2 »… */
function freeInstanceId(client: ClientItem): string {
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? "compte" : `compte-${index}`;
    if (!client.instances.some((instance) => instance.id === id)) return id;
  }
}

/** Nom d’un nouveau compte, déduit de ce que l’utilisateur a saisi. */
function accountName(client: ClientItem, login: string, url: string): string {
  if (login.trim()) return login.trim();
  try {
    if (url.trim()) return new URL(url.trim()).host;
  } catch {
    // Adresse illisible : le nom par défaut suffit.
  }
  return client.instances.length === 0 ? "Compte principal" : `Compte ${client.instances.length + 1}`;
}

/** Ce qu’un service à une seule adresse enregistre, repris de sa vue. */
export function configOf(client: ClientItem): ClientConfig {
  return {
    id: client.id,
    label: client.label,
    baseUrl: client.baseUrl,
    auth: client.auth,
    headers: client.headers,
    testPath: client.testPath,
  };
}

/** En-têtes saisis un par ligne, « Nom: valeur ». */
function parseHeaders(text: string): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  for (const line of text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const at = line.indexOf(":");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      return { headers, error: `Ligne « ${line} » : écrivez « Nom: valeur ».` };
    }
    headers[name] = line.slice(at + 1).trim();
  }
  return { headers };
}

const headersText = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

type Errors = Partial<Record<"url" | "login" | "secret" | "headers", string>> & {
  params?: Record<string, string>;
};

export function AccountEditor({
  client,
  initial,
  help,
  redirectUri,
  created = false,
  onCancel,
  onSaved,
}: {
  client: ClientItem;
  /** Compte à modifier ; absent pour un ajout. Le compte d’un service à une seule adresse est toujours modifié. */
  initial?: ClientInstanceItem;
  /** Aide du module : où trouver la clé, quel compte utiliser. */
  help?: string;
  redirectUri: string | null;
  /** Le compte vient d’être ajouté : la fiche invite d’abord à lui ajouter des pages. */
  created?: boolean;
  onCancel: () => void;
  /** `created` : le compte est nouveau ; `saved`, le service tel qu’il est maintenant. */
  onSaved: (result: { saved: ClientItem; instance: string; created: boolean }) => void;
}) {
  const simple = client.simple;
  const editing = simple ? client.instances[0] : initial;
  const [method, setMethod] = useState(editing?.method ?? client.methods[0]?.id ?? "");
  const [url, setUrl] = useState(simple ? "" : (initial?.url ?? ""));
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [headers, setHeaders] = useState(headersText(editing?.headers));
  const [insecureTls, setInsecureTls] = useState(Boolean(editing?.insecureTls));
  const [params, setParams] = useState<Record<string, string>>(editing?.params ?? {});
  const [entries, setEntries] = useState<VaultEntry[]>();
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  const type: AuthType | undefined = simple
    ? client.auth?.type
    : client.methods.find((known) => known.id === method)?.type;
  const kind = vaultKindOf(type);
  const fields = fieldsOf(type);
  const declaredParams = simple ? undefined : client.methods.find((known) => known.id === method)?.params;
  const secretId = simple ? client.auth?.secret : editing?.secret;
  const stored = entries?.find((entry) => entry.id === secretId && entry.kind === kind);

  useEffect(() => {
    void listVault()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);
  // L’identifiant déjà enregistré se montre ; le secret, jamais (Alfred ne le renvoie pas).
  useEffect(() => {
    if (stored && fields.login) setLogin(stored.meta[fields.login.name] ?? "");
  }, [stored, fields.login]);

  /** L’adresse du compte ne se demande que si le module n’en fixe pas une. */
  const askUrl = !simple && (!client.baseUrl || Boolean(initial?.url));
  const keepsSecret = Boolean(stored?.hasSecret);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {
      url: !askUrl
        ? undefined
        : url.trim()
          ? urlError(url, "")
          : client.baseUrl
            ? undefined
            : "Saisissez l’adresse de votre compte.",
      login: fields.login && !login.trim() ? fields.login.missing : undefined,
      secret: fields.secret?.required && !secret && !keepsSecret ? fields.secret.missing : undefined,
      headers: parseHeaders(headers).error,
    };
    const missingParams = paramErrors(declaredParams, params);
    if (Object.keys(missingParams).length > 0) next.params = missingParams;
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setPending(true);
    try {
      const name =
        editing && !(simple && editing.label === "Principale") ? editing.label : accountName(client, login, url);
      let entryId = secretId;
      if (kind && fields.secret) {
        const saved = await saveVaultEntry({
          // Une entrée d’un autre type (la façon de se connecter a changé) ne se réutilise pas.
          id: secretId && (!entries?.some((entry) => entry.id === secretId) || stored) ? secretId : undefined,
          label: simple ? client.label : `${client.label} — ${name}`,
          kind,
          meta: fields.login ? { [fields.login.name]: login.trim() } : {},
          secrets: secret ? { [fields.secret.name]: secret } : {},
        });
        entryId = saved.id;
      }
      // Le compte d’un service à une seule adresse est son instance « default », sans nom.
      const instance: ClientInstanceConfig = simple
        ? { id: "default", label: "", method: "default" }
        : { id: initial?.id ?? freeInstanceId(client), label: name, method };
      if (url.trim()) instance.url = url.trim();
      if (kind) instance.secret = entryId;
      const extra = parseHeaders(headers).headers;
      if (Object.keys(extra).length > 0) instance.headers = extra;
      if (insecureTls) instance.insecureTls = true;
      const values = paramValues(declaredParams, params);
      if (values) instance.params = values;
      const saved = await saveInstance(client.id, instance, !simple && !initial);
      notify({ title: editing && (simple || initial) ? "Compte enregistré" : "Compte ajouté", tone: "success" });
      onSaved({ saved, instance: instance.id, created: !simple && !initial });
    } catch (failure) {
      notify({ title: "Le compte n’a pas été enregistré", description: errorMessage(failure), tone: "error" });
      setPending(false);
    }
  };

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  const adding = !simple && !initial;

  const pages = editing ? <AccountPages client={client} instance={editing} created={created} /> : null;

  return (
    <Stack gap="lg">
      {created ? pages : null}
      <ModulePart
        part="account"
        title={adding ? `Ajouter un compte ${client.label}` : `Votre compte ${client.label}`}
        description="Vos identifiants restent sur cet ordinateur, dans le coffre."
      >
        <form noValidate onSubmit={submit}>
          <Stack gap="md">
            <Stack gap="none">
              <Text weight="strong">
                {adding ? `Ajouter un compte ${client.label}` : `Votre compte ${client.label}`}
              </Text>
              <Text size="meta" tone="muted">
                Vos identifiants restent sur cet ordinateur, dans le coffre.
              </Text>
            </Stack>
            {help ? <Text tone="muted">{help}</Text> : null}
            {askUrl ? (
              <TextField
                label="Adresse de votre compte"
                isRequired={!client.baseUrl}
                description={
                  client.baseUrl ? `Laissez vide pour ${client.baseUrl}.` : "L’adresse où vous vous connectez."
                }
                error={errors.url}
                placeholder={client.baseUrl || "Ex. https://acme.atlassian.net"}
                autoComplete="off"
                value={url}
                onChange={(value) => {
                  setUrl(value);
                  clear("url");
                }}
              />
            ) : null}
            {!simple && client.methods.length > 1 ? (
              <Select
                label="Connexion"
                value={method}
                options={client.methods.map((known) => ({ id: known.id, label: methodLabel(known) }))}
                onChange={(id) => {
                  if (!id) return;
                  setMethod(id);
                  setLogin("");
                  setSecret("");
                  setErrors({});
                }}
              />
            ) : null}
            <ParamFields
              params={declaredParams}
              values={params}
              errors={errors.params}
              onChange={(id, value) => {
                setParams((current) => ({ ...current, [id]: value }));
                setErrors((current) => ({ ...current, params: { ...current.params, [id]: "" } }));
              }}
            />
            {fields.login ? (
              <TextField
                label={fields.login.label}
                isRequired
                autoComplete="off"
                error={errors.login}
                value={login}
                onChange={(value) => {
                  setLogin(value);
                  clear("login");
                }}
              />
            ) : null}
            {fields.secret ? (
              <TextField
                type="password"
                label={fields.secret.label}
                isRequired={fields.secret.required && !keepsSecret}
                description={keepsSecret ? "Laissez vide pour garder celui enregistré." : undefined}
                error={errors.secret}
                autoComplete="off"
                value={secret}
                onChange={(value) => {
                  setSecret(value);
                  clear("secret");
                }}
              />
            ) : null}
            {type === "oauth2" && redirectUri ? (
              <Notice tone="info">
                {`Adresse de retour à donner au service : ${redirectUri}. Vous vous connecterez ensuite dans votre navigateur.`}
              </Notice>
            ) : null}
            <Disclosure title="Options avancées" defaultExpanded={Boolean(errors.headers || insecureTls || headers)}>
              <Stack gap="md">
                <TextArea
                  label="En-têtes en plus"
                  description="Un par ligne, « Nom: valeur ». Ajoutés à chaque appel de ce compte."
                  error={errors.headers}
                  minRows={3}
                  placeholder="X-Tenant: acme"
                  value={headers}
                  onChange={(value) => {
                    setHeaders(value);
                    clear("headers");
                  }}
                />
                <Stack gap="xs">
                  <Checkbox isSelected={insecureTls} onChange={setInsecureTls}>
                    Accepter un certificat non vérifié
                  </Checkbox>
                  <Text size="meta" tone="muted">
                    Pour un serveur interne dont le certificat n’est pas reconnu (auto-signé). La connexion reste
                    chiffrée, mais l’identité du serveur n’est plus vérifiée.
                  </Text>
                </Stack>
              </Stack>
            </Disclosure>
            <Row gap="sm" justify="end">
              <Button onPress={onCancel} isDisabled={pending}>
                {created ? "Terminer" : "Annuler"}
              </Button>
              <Button type="submit" variant="primary" isPending={pending}>
                {adding ? "Ajouter" : "Enregistrer"}
              </Button>
            </Row>
          </Stack>
        </form>
      </ModulePart>
      {created ? null : pages}
    </Stack>
  );
}
