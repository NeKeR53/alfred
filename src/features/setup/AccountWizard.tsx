/**
 * « Connecter un nouveau compte », pas à pas, pour quelqu’un qui n’y connaît rien : un nom proposé, la façon de se
 * connecter en clair quand il y en a plusieurs, l’adresse avec un exemple et une vérification immédiate, puis le
 * jeton (« Créer mon jeton » ouvre la bonne page du service, si le module la connaît) ou « Se connecter avec… » dans
 * le navigateur. Le compte est testé aussitôt ; un échec se dit en clair, avec ce qu’il faut faire.
 *
 * Le secret va dans le coffre, comme depuis la fiche du module. Le compte enregistré est remis à l’étape (`onSaved`)
 * dès sa création, même si son test échoue ensuite : la reprise le retrouve.
 */
import { Button, CheckboxControl, FormField, RadioControl, Stack, Text, TextInput } from "@alfred/ui";
import { Check, ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { openExternal } from "../../lib/native";
import type { ModuleSummary } from "../../lib/types";
import { urlError } from "../clients/AccountEditor";
import {
  type AuthType,
  type ClientConfig,
  type ClientInstanceConfig,
  type ClientInstanceItem,
  type ClientItem,
  type ClientMethod,
  type FailureReason,
  probeAddress,
  saveInstance,
  testClient,
} from "../clients/api";
import { createFromTemplate, templateOf } from "../clients/fromTemplate";
import type { ClientsController } from "../clients/useClients";
import { errorMessage, listVault, saveVaultEntry, slugify, type VaultKind } from "../vault/api";
import type { NeedPlan } from "./flow";

const VAULT_KIND: Partial<Record<AuthType, VaultKind>> = {
  bearer: "token",
  apiKey: "token",
  basic: "basic",
  oauth2: "oauth2",
  clientCredentials: "clientCredentials",
};

/** Ce que l’utilisateur saisit selon la façon de se connecter. */
function fieldsOf(method: ClientMethod | undefined) {
  switch (method?.type) {
    case "bearer":
      return { secret: { name: "value", label: "Collez votre jeton ici", missing: "Collez le jeton." } };
    case "apiKey":
      return { secret: { name: "value", label: "Collez votre clé ici", missing: "Collez la clé." } };
    case "basic":
      return {
        login: { name: "username", label: "Identifiant", missing: "Saisissez votre identifiant." },
        secret: { name: "password", label: "Mot de passe ou jeton", missing: "Saisissez le mot de passe ou le jeton." },
      };
    case "clientCredentials":
      return {
        login: { name: "clientId", label: "Identifiant de l’application", missing: "Saisissez l’identifiant." },
        secret: { name: "clientSecret", label: "Secret de l’application", missing: "Saisissez le secret." },
      };
    case "oauth2":
      // L’application du module est connue : rien à saisir, la connexion se fait dans le navigateur.
      return method.clientId
        ? {}
        : {
            login: { name: "clientId", label: "Identifiant de l’application", missing: "Saisissez l’identifiant." },
          };
    default:
      return {};
  }
}

/** Ce qu’un échec veut dire, et ce qu’il faut faire, en mots simples. */
export function failureText(
  reason: FailureReason | null | undefined,
  type: AuthType | undefined,
  host: string,
  message: string,
) {
  const where = host || "cette adresse";
  switch (reason) {
    case "unreachable":
      return `Je n’arrive pas à joindre ${where}. Vérifiez l’adresse, et que vous êtes bien connecté au réseau de l’entreprise (VPN).`;
    case "certificate":
      return `Le certificat de ${where} n’est pas reconnu, ce qui arrive souvent avec un serveur d’entreprise. Si c’est bien le vôtre, cochez « Faire confiance à ce serveur », puis réessayez.`;
    case "refused":
      if (type === "basic") return "L’identifiant ou le mot de passe a été refusé. Vérifiez-les, puis réessayez.";
      if (type === "none" || !type)
        return "Ce serveur demande un compte : choisissez une autre façon de vous connecter.";
      return "Le jeton a été refusé. Vérifiez que vous l’avez copié en entier, ou créez-en un nouveau.";
    case "forbidden":
      return "Le compte est bien reconnu, mais il n’a pas les droits nécessaires. Donnez-lui au moins le droit de lecture, ou demandez l’accès à la personne qui gère ce serveur.";
    case "notFound":
      return "Cette adresse répond, mais ce n’est pas celle attendue. Vérifiez-la, jusqu’à la fin (par exemple /api).";
    default:
      return `La connexion n’a pas marché. ${message}`;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return "";
  }
};

/** Identifiant libre d’un nouveau compte, tiré de son nom. */
function freeId(name: string, client: ClientItem | undefined) {
  const base = slugify(name) || "compte";
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!client?.instances.some((instance) => instance.id === id)) return id;
  }
}

type Address = { state: "idle" | "checking" | "ok" | "failed"; reason?: FailureReason | null; message?: string };

export function AccountWizard({
  plan,
  modules,
  services,
  client: known,
  editing,
  help,
  onSaved,
  onConnected,
  onBack,
}: {
  plan: Pick<NeedPlan, "key" | "module" | "need" | "label">;
  modules: ModuleSummary[];
  services: ClientsController;
  /** Service du besoin, s’il existe déjà ; sinon il se crée d’après le modèle du module. */
  client?: ClientItem;
  /** Compte à compléter (secret manquant, test raté) plutôt qu’à créer. */
  editing?: ClientInstanceItem;
  /** Aide du module pour ce compte (`clients[].help`). */
  help?: string;
  /** Le compte est enregistré : l’étape le donne aux onglets de la page. */
  onSaved: (client: ClientItem, instance: string) => Promise<void> | void;
  /** Le compte répond : l’étape continue. */
  onConnected: (client: ClientItem, instance: string) => void;
  onBack?: () => void;
}) {
  const formId = useId();
  const [owner, need] = plan.key.split("/") as [string, string];
  const template = templateOf(modules, owner, need) as Partial<ClientConfig> | undefined;
  const simple = known ? known.simple : !template?.methods?.length;
  /** Façons de se connecter : celles du service, complétées de l’aide que le module a écrite pour chacune. */
  const methods: ClientMethod[] = (() => {
    const declared = template?.methods ?? [];
    if (simple) {
      const auth = known?.auth ?? template?.auth ?? { type: "none" as const };
      return [{ ...auth, id: "default" }];
    }
    const own = known?.methods ?? declared;
    return own.map((method) => ({ ...declared.find((item) => item.id === method.id), ...method }));
  })();
  const fixedUrl = (known?.baseUrl ?? template?.baseUrl ?? "").trim();
  const askUrl = !simple && (!fixedUrl || Boolean(editing?.url));
  const count = known?.instances.length ?? 0;

  const [name, setName] = useState(
    editing?.label ?? (count === 0 ? `Mon ${plan.label}` : `${plan.label} ${count + 1}`),
  );
  const [methodId, setMethodId] = useState(editing?.method ?? methods[0]?.id ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [trust, setTrust] = useState(Boolean(editing?.insecureTls));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [address, setAddress] = useState<Address>({ state: "idle" });
  const [phase, setPhase] = useState<"form" | "saving" | "browser" | "testing">("form");
  const [failure, setFailure] = useState<{ reason?: FailureReason | null; message: string }>();
  /** Compte créé par ce formulaire : un nouvel essai le modifie au lieu d’en créer un autre. */
  const saved = useRef<{ client: ClientItem; instance: ClientInstanceItem | ClientInstanceConfig } | undefined>(
    known && editing ? { client: known, instance: editing } : undefined,
  );

  const method = methods.find((item) => item.id === methodId) ?? methods[0];
  const fields = fieldsOf(method);
  const kind = method ? VAULT_KIND[method.type] : undefined;
  const effectiveUrl = (askUrl ? url.trim() : "") || fixedUrl;
  const example = method?.urlExample;
  const [stored, setStored] = useState(Boolean(editing?.hasSecret));
  const keepsSecret = stored;
  const browser = method?.type === "oauth2";

  // L’identifiant enregistré se montre à nouveau quand on reprend un compte ; le secret, jamais.
  useEffect(() => {
    const secretId = editing?.secret;
    if (!secretId || !fields.login) return;
    void listVault()
      .then((entries) => {
        const entry = entries.find((item) => item.id === secretId);
        if (entry && fields.login) setLogin(entry.meta[fields.login.name] ?? "");
      })
      .catch(() => undefined);
  }, [editing?.secret, fields.login]);

  // Retour de la connexion dans le navigateur : dès que le compte est connecté, je le teste.
  const target = saved.current;
  const live = target
    ? services.overview?.clients
        .find((client) => client.id === target.client.id)
        ?.instances.find((instance) => instance.id === target.instance.id)
    : undefined;
  useEffect(() => {
    if (phase !== "browser" || !live || !target) return;
    if (live.status === "ready") void runTest();
  });

  const checkAddress = async (value = url, trusted = trust) => {
    const text = value.trim();
    if (!text) return setAddress({ state: "idle" });
    const invalid = urlError(text, "");
    if (invalid) {
      setErrors((current) => ({ ...current, url: invalid }));
      return setAddress({ state: "idle" });
    }
    setAddress({ state: "checking" });
    try {
      const result = await probeAddress(text, trusted);
      setAddress(result.ok ? { state: "ok" } : { state: "failed", reason: result.reason, message: result.message });
    } catch (failed) {
      setErrors((current) => ({ ...current, url: errorMessage(failed) }));
      setAddress({ state: "idle" });
    }
  };

  async function runTest() {
    const current = saved.current;
    if (!current) return;
    setPhase("testing");
    try {
      const result = await testClient(current.client.id, current.client.simple ? undefined : current.instance.id);
      await services.load();
      if (result.ok) {
        setFailure(undefined);
        onConnected(current.client, current.instance.id);
        return;
      }
      setFailure({ reason: result.reason, message: result.message });
    } catch (failed) {
      setFailure({ message: errorMessage(failed) });
    }
    setPhase("form");
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string | undefined> = {
      name: !simple && !name.trim() ? "Donnez un nom à ce compte." : undefined,
      url: askUrl ? (url.trim() ? urlError(url, "") : fixedUrl ? undefined : "Saisissez l’adresse.") : undefined,
      login: fields.login && !login.trim() ? fields.login.missing : undefined,
      secret: fields.secret && !secret && !keepsSecret ? fields.secret.missing : undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean) || !method) return;
    setFailure(undefined);
    setPhase("saving");
    try {
      let client = saved.current?.client ?? known;
      if (!client) {
        if (!template) throw new Error("Le module ne dit pas comment se connecter à ce compte.");
        client = await createFromTemplate(template, { key: plan.key, id: need, label: plan.label }, services);
      }
      const label = name.trim() || plan.label;
      const previous = saved.current?.instance;
      let secretId = previous?.secret;
      if (kind) {
        const entry = await saveVaultEntry({
          id: secretId,
          label: simple ? client.label : `${client.label} — ${label}`,
          kind,
          meta: fields.login
            ? { [fields.login.name]: login.trim() }
            : method.clientId
              ? { clientId: method.clientId }
              : {},
          secrets: fields.secret && secret ? { [fields.secret.name]: secret } : {},
        });
        secretId = entry.id;
        if (secret) {
          // Gardé dans le coffre : le champ se vide, et un nouvel essai garde ce secret si l’on n’en colle pas d’autre.
          setStored(true);
          setSecret("");
        }
      }
      const instance: ClientInstanceConfig = simple
        ? { id: "default", label: "", method: "default" }
        : { id: previous?.id ?? freeId(label, client), label, method: method.id };
      if (askUrl && url.trim()) instance.url = url.trim();
      if (kind) instance.secret = secretId;
      if (trust) instance.insecureTls = true;
      const created = !simple && !previous;
      const next = await saveInstance(client.id, instance, created);
      saved.current = { client: next, instance };
      await services.load();
      // Un compte nouveau devient tout de suite celui de la page, même si son test échoue : la reprise le retrouve.
      if (!previous) await onSaved(next, instance.id);
      if (browser) {
        setPhase("browser");
        await services.connect({
          client: next,
          instance: next.simple ? undefined : next.instances.find((item) => item.id === instance.id),
        });
        return;
      }
      await runTest();
    } catch (failed) {
      setFailure({ message: errorMessage(failed) });
      setPhase("form");
    }
  };

  const busy = phase !== "form";
  const tokenPage = method?.tokenPage;
  const tokenLink = tokenPage
    ? tokenPage.includes("{url}")
      ? effectiveUrl
        ? tokenPage.replace("{url}", effectiveUrl.replace(/\/+$/, ""))
        : undefined
      : tokenPage
    : undefined;
  const advice = method?.help || help;
  const certificate = failure?.reason === "certificate" || address.reason === "certificate" || trust;

  return (
    <form
      id={formId}
      className="setup-wizard"
      noValidate
      onSubmit={submit}
      aria-label={`Connecter un compte ${plan.label}`}
    >
      <Stack gap="md">
        {!simple ? (
          <FormField label="Nom du compte" hint="Pour le reconnaître dans le menu." error={errors.name}>
            <TextInput
              value={name}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
        ) : null}
        {methods.length > 1 ? (
          <fieldset className="setup-wizard__methods" disabled={busy}>
            <legend>Comment vous connectez-vous ?</legend>
            {methods.map((item) => (
              <RadioControl
                key={item.id}
                name={`${formId}-methode`}
                label={item.label || item.id}
                checked={item.id === method?.id}
                onChange={() => {
                  setMethodId(item.id);
                  setLogin("");
                  setSecret("");
                  setErrors({});
                  setFailure(undefined);
                }}
              />
            ))}
          </fieldset>
        ) : null}
        {askUrl ? (
          <FormField
            label="Adresse"
            hint={
              example
                ? `Par exemple ${example}`
                : fixedUrl
                  ? `Laissez vide pour ${fixedUrl}.`
                  : "L’adresse où vous vous connectez d’habitude."
            }
            error={errors.url}
          >
            <TextInput
              value={url}
              placeholder={example ?? fixedUrl ?? "https://"}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              disabled={busy}
              onChange={(event) => {
                setUrl(event.target.value);
                setErrors((current) => ({ ...current, url: undefined }));
                setAddress({ state: "idle" });
              }}
              onBlur={() => void checkAddress()}
            />
          </FormField>
        ) : null}
        {address.state === "checking" ? (
          <Text size="meta" tone="muted">
            Je vérifie l’adresse…
          </Text>
        ) : address.state === "ok" ? (
          <Text size="meta" tone="success">
            <Check size={12} aria-hidden="true" /> L’adresse répond.
          </Text>
        ) : address.state === "failed" ? (
          <Text size="meta" tone="danger">
            {failureText(address.reason, method?.type, hostOf(url), address.message ?? "")}
          </Text>
        ) : null}
        {certificate ? (
          <CheckboxControl
            label="Faire confiance à ce serveur"
            checked={trust}
            disabled={busy}
            onChange={(event) => {
              setTrust(event.target.checked);
              if (address.state === "failed") void checkAddress(url, event.target.checked);
            }}
          />
        ) : null}
        {advice && (fields.secret || fields.login || browser) ? <Text tone="muted">{advice}</Text> : null}
        {tokenPage && fields.secret ? (
          <div className="setup-wizard__token">
            <Button
              variant="secondary"
              disabled={!tokenLink || busy}
              onClick={() => tokenLink && void openExternal(tokenLink)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              Créer mon jeton
            </Button>
            {!tokenLink ? (
              <Text size="meta" tone="muted">
                Saisissez d’abord l’adresse.
              </Text>
            ) : null}
          </div>
        ) : null}
        {fields.login ? (
          <FormField label={fields.login.label} error={errors.login}>
            <TextInput
              value={login}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setLogin(event.target.value)}
            />
          </FormField>
        ) : null}
        {fields.secret ? (
          <FormField
            label={fields.secret.label}
            hint={
              keepsSecret
                ? "Laissez vide pour garder celui enregistré. Il reste sur cet ordinateur."
                : "Il reste sur cet ordinateur, dans le coffre."
            }
            error={errors.secret}
          >
            <TextInput
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setSecret(event.target.value)}
            />
          </FormField>
        ) : null}
        {browser && !method?.clientId && services.overview?.redirectUri ? (
          <Text size="meta" tone="muted">
            Adresse de retour à donner au service : {services.overview.redirectUri}
          </Text>
        ) : null}
        {phase === "browser" ? (
          <Text tone="muted">Une page s’est ouverte dans votre navigateur : connectez-vous, puis revenez ici.</Text>
        ) : null}
        {phase === "testing" ? <Text tone="muted">Je vérifie la connexion…</Text> : null}
        {failure ? (
          <div role="alert">
            <Text tone="danger">
              {failureText(failure.reason, method?.type, hostOf(effectiveUrl), failure.message)}
            </Text>
          </div>
        ) : null}
        <div className="setup-wizard__actions">
          {onBack ? (
            <Button disabled={phase === "saving" || phase === "testing"} onClick={onBack}>
              Retour
            </Button>
          ) : null}
          <span className="setup-flow__spacer" />
          <Button
            type="submit"
            variant="primary"
            loading={phase === "saving" || phase === "testing"}
            disabled={phase === "browser"}
          >
            {browser ? `Se connecter avec ${plan.label}` : failure ? "Réessayer" : "Connecter"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}
