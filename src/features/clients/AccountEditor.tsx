/**
 * Un compte chez un service, du point de vue de l’utilisateur : ses identifiants, et rien d’autre.
 *
 * La façon de se connecter (adresse du service, type d’authentification, en-têtes, chemin de test) est décrite par
 * le module, donc par l’agent : l’utilisateur ne la voit ni ne la change. Il ne donne que ce qui lui est propre :
 * l’adresse de son compte quand le service n’en a pas une fixe, la façon de se connecter quand le module en propose
 * plusieurs, et son identifiant, son mot de passe ou son jeton. Le nom et l’identifiant technique du compte, comme
 * l’entrée du coffre qui garde le secret, se déduisent seuls.
 */
import {
  CheckboxControl,
  Disclosure,
  FeedbackBanner,
  Fieldset,
  FormActions,
  FormField,
  Page,
  Section,
  SelectControl,
  Stack,
  Text,
  TextArea,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { AccountPage, Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage, listVault, saveVaultEntry, type VaultEntry, type VaultKind } from "../vault/api";
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
import "./services.css";

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
      return {
        login: { name: "username", label: "Identifiant", missing: "Saisissez votre identifiant." },
        secret: { name: "password", label: "Mot de passe", required: true, missing: "Saisissez le mot de passe." },
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

/**
 * Pages qui sont pour chaque compte de ce client, et si elles sont cochées pour celui-ci : toutes pour un compte
 * nouveau, sinon toutes sauf celles que l’utilisateur a décochées (`excluded` de `page:module/page@compte`).
 */
export function accountPagesOf(
  snapshot: Snapshot | null | undefined,
  client: string,
  instance: string | undefined,
): Array<AccountPage & { selected: boolean }> {
  const overrides = snapshot?.layout?.overrides ?? {};
  return (snapshot?.accountPages ?? [])
    .filter((page) => page.client === client)
    .map((page) => ({
      ...page,
      selected: instance === undefined || !overrides[`page:${page.reference}@${instance}`]?.excluded,
    }));
}

type Errors = Partial<Record<"url" | "login" | "secret" | "headers", string>>;

export function AccountEditor({
  client,
  initial,
  help,
  redirectUri,
  onCancel,
  onSaved,
}: {
  client: ClientItem;
  /** Compte à modifier ; absent pour un ajout. Le compte d’un service à une seule adresse est toujours modifié. */
  initial?: ClientInstanceItem;
  /** Aide du module : où trouver la clé, quel compte utiliser. */
  help?: string;
  redirectUri: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const simple = client.simple;
  const editing = simple ? client.instances[0] : initial;
  const [method, setMethod] = useState(editing?.method ?? client.methods[0]?.id ?? "");
  const [url, setUrl] = useState(simple ? "" : (initial?.url ?? ""));
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [headers, setHeaders] = useState(headersText(editing?.headers));
  const [insecureTls, setInsecureTls] = useState(Boolean(editing?.insecureTls));
  const [entries, setEntries] = useState<VaultEntry[]>();
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const snapshot = useShell((state) => state.snapshot);
  // Le choix se lit une fois, à l’ouverture : la fiche le garde ensuite tel que l’utilisateur le règle.
  const [pages, setPages] = useState(() =>
    accountPagesOf(snapshot, client.id, editing ? editing.id : simple ? "default" : undefined),
  );
  const severalSections = new Set(pages.map((page) => `${page.module}/${page.section}`)).size > 1;

  const type: AuthType | undefined = simple
    ? client.auth?.type
    : client.methods.find((known) => known.id === method)?.type;
  const kind = vaultKindOf(type);
  const fields = fieldsOf(type);
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
      const choice =
        pages.length > 0 ? Object.fromEntries(pages.map((page) => [page.reference, page.selected])) : undefined;
      await saveInstance(client.id, instance, !simple && !initial, choice);
      notify({ title: editing && (simple || initial) ? "Compte enregistré" : "Compte ajouté", tone: "success" });
      onSaved();
    } catch (failure) {
      notify({ title: "Le compte n’a pas été enregistré", description: errorMessage(failure), tone: "error" });
      setPending(false);
    }
  };

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  const adding = !simple && !initial;

  return (
    <Page width="text">
      <Section
        title={adding ? `Ajouter un compte ${client.label}` : `Votre compte ${client.label}`}
        description="Vos identifiants restent sur cet ordinateur, dans le coffre."
      >
        <form id={formId} className="settings-form" noValidate onSubmit={submit}>
          <Stack gap="md">
            {help ? <Text tone="muted">{help}</Text> : null}
            {askUrl ? (
              <FormField
                label="Adresse de votre compte"
                hint={client.baseUrl ? `Laissez vide pour ${client.baseUrl}.` : "L’adresse où vous vous connectez."}
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
            ) : null}
            {!simple && client.methods.length > 1 ? (
              <FormField label="Connexion">
                <SelectControl
                  value={method}
                  onChange={(event) => {
                    setMethod(event.target.value);
                    setLogin("");
                    setSecret("");
                    setErrors({});
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
            {fields.login ? (
              <FormField label={fields.login.label} error={errors.login}>
                <TextInput
                  value={login}
                  aria-required="true"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setLogin(event.target.value);
                    clear("login");
                  }}
                />
              </FormField>
            ) : null}
            {fields.secret ? (
              <FormField
                label={fields.secret.label}
                hint={keepsSecret ? "Laissez vide pour garder celui enregistré." : undefined}
                error={errors.secret}
              >
                <TextInput
                  type="password"
                  value={secret}
                  aria-required={fields.secret.required && !keepsSecret ? "true" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setSecret(event.target.value);
                    clear("secret");
                  }}
                />
              </FormField>
            ) : null}
            {type === "oauth2" && redirectUri ? (
              <FeedbackBanner tone="info" appearance="contained">
                Adresse de retour à donner au service : {redirectUri}. Vous vous connecterez ensuite dans votre
                navigateur.
              </FeedbackBanner>
            ) : null}
            {pages.length > 0 ? (
              <Fieldset
                legend="Pages de ce compte"
                hint="Les pages du menu qui existent pour ce compte. Une page décochée quitte le menu ; ses données restent."
              >
                {pages.map((page) => (
                  <CheckboxControl
                    key={page.reference}
                    label={severalSections ? `${page.title} · ${page.section}` : page.title}
                    checked={page.selected}
                    onChange={(event) => {
                      const selected = event.target.checked;
                      setPages((current) =>
                        current.map((item) => (item.reference === page.reference ? { ...item, selected } : item)),
                      );
                    }}
                  />
                ))}
              </Fieldset>
            ) : null}
            <Disclosure
              label="Options avancées"
              appearance="subtle"
              open={errors.headers || insecureTls || headers ? true : undefined}
            >
              <Stack gap="md">
                <FormField
                  label="En-têtes en plus (facultatif)"
                  hint="Un par ligne, « Nom: valeur ». Ajoutés à chaque appel de ce compte."
                  error={errors.headers}
                >
                  <TextArea
                    value={headers}
                    rows={3}
                    spellCheck={false}
                    placeholder="X-Tenant: acme"
                    onChange={(event) => {
                      setHeaders(event.target.value);
                      clear("headers");
                    }}
                  />
                </FormField>
                <FormField
                  label="Certificat du serveur"
                  hint="Pour un serveur interne dont le certificat n’est pas reconnu (auto-signé). La connexion reste chiffrée, mais l’identité du serveur n’est plus vérifiée."
                >
                  <CheckboxControl
                    label="Accepter un certificat non vérifié"
                    checked={insecureTls}
                    onChange={(event) => setInsecureTls(event.target.checked)}
                  />
                </FormField>
              </Stack>
            </Disclosure>
            <FormActions
              form={formId}
              submitLabel={adding ? "Ajouter" : "Enregistrer"}
              pendingLabel="Enregistrement…"
              pending={pending}
              onCancel={onCancel}
            />
          </Stack>
        </form>
      </Section>
    </Page>
  );
}
