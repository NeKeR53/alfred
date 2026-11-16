/**
 * Parcours de configuration d’un module, pas à pas : ce qu’il fait, puis chaque service dont il a besoin (créer ou
 * choisir le service, ajouter un compte, saisir la clé, approuver, se connecter, tester), puis un récapitulatif.
 *
 * Rien n’est mémorisé : chaque étape se lit dans l’état réel des services (`modules.setup`), si bien qu’on peut
 * quitter le parcours à tout moment et le reprendre là où il en était.
 */
import {
  Button,
  FeedbackBanner,
  SelectControl,
  SettingRow,
  SettingRows,
  Spinner,
  StatusBadge,
  StepList,
  Text,
} from "@alfred/ui";
import { ArrowLeft, Check, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import {
  AUTH_TYPES,
  type AuthType,
  type ClientConfig,
  type ClientInstanceItem,
  type ClientItem,
  saveClient,
  testClient,
} from "../clients/api";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { errorMessage, slugify } from "../vault/api";
import { VaultEntryDialog } from "../vault/VaultEntryDialog";
import type { ModuleSetup, SetupStep, SetupStepState } from "./api";
import "./setup.css";

const INTRO = "intro";
const DONE = "fin";

/** État d’une étape, en mots simples. */
export const STEP_STATE: Record<SetupStepState, { label: string; tone: "success" | "warning" | "danger" }> = {
  missing: { label: "À configurer", tone: "warning" },
  incomplete: { label: "À terminer", tone: "warning" },
  untested: { label: "À tester", tone: "warning" },
  failed: { label: "Le test a échoué", tone: "danger" },
  ready: { label: "Prêt", tone: "success" },
};

/** Première étape à montrer à la reprise : le premier service essentiel qui n’est pas prêt, sinon la fin. */
export function resumeStep(setup: ModuleSetup): string {
  return (
    setup.steps.find((step) => !step.optional && step.state !== "ready")?.key ??
    setup.steps.find((step) => step.state !== "ready")?.key ??
    DONE
  );
}

/** Identifiant libre pour un nouveau service : celui du besoin, sinon suffixé. */
function freeId(wanted: string, clients: ClientItem[]) {
  const base = slugify(wanted) || "service";
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!clients.some((client) => client.id === id)) return id;
  }
}

/** Ce qu’un service à une seule adresse enregistre, repris de sa vue dans les Réglages. */
function configOf(client: ClientItem): ClientConfig {
  return {
    id: client.id,
    label: client.label,
    baseUrl: client.baseUrl,
    auth: client.auth,
    headers: client.headers,
    testPath: client.testPath,
  };
}

export function SetupFlow({
  setup,
  modules,
  services,
  start,
  onEdit,
  onClose,
  onOpenModule,
}: {
  setup: ModuleSetup | undefined;
  /** Tous les modules de l’espace : le modèle d’un service peut venir d’une dépendance. */
  modules: ModuleSummary[];
  services: ClientsController;
  /** `intro` juste après l’installation ; `resume` pour reprendre à la première étape incomplète. */
  start: "intro" | "resume";
  onEdit: (editing: ServiceEditing) => void;
  onClose: () => void;
  /** Ouvre la première section du module dans le menu ; absent si le module n’en a pas. */
  onOpenModule?: () => void;
}) {
  const [current, setCurrent] = useState<string>();
  const [creating, setCreating] = useState<string>();
  const [entryFor, setEntryFor] = useState<ClientItem>();
  const [testing, setTesting] = useState<string>();
  /** Comptes déjà testés d’office pendant ce parcours : on ne relance pas un test qui vient d’échouer. */
  const autoTested = useRef(new Set<string>());

  useEffect(() => {
    if (current || !setup) return;
    setCurrent(start === "intro" ? INTRO : resumeStep(setup));
  }, [current, setup, start]);

  const clients = services.overview?.clients ?? [];
  const needs = services.overview?.needs ?? [];
  const step = setup?.steps.find((candidate) => candidate.key === current);
  const client = step?.client ? clients.find((candidate) => candidate.id === step.client) : undefined;

  // Un compte prêt qui n’a jamais été testé l’est d’office, une fois : la plupart des gens n’y penseraient pas.
  useEffect(() => {
    if (!client || testing) return;
    const instance = client.instances.find(
      (candidate) =>
        candidate.status === "ready" && !candidate.lastTest && !autoTested.current.has(`${client.id}#${candidate.id}`),
    );
    if (!instance) return;
    autoTested.current.add(`${client.id}#${instance.id}`);
    void runTest(client, instance);
  });

  const ids = useMemo(() => [INTRO, ...(setup?.steps.map((item) => item.key) ?? []), DONE], [setup]);
  if (!setup || !current) return <Spinner label="Chargement de la configuration" />;

  const index = Math.max(0, ids.indexOf(current));
  const go = (offset: number) => setCurrent(ids[Math.min(ids.length - 1, Math.max(0, index + offset))]);
  const total = setup.steps.length;

  async function runTest(target: ClientItem, instance: ClientInstanceItem) {
    const key = `${target.id}#${instance.id}`;
    setTesting(key);
    try {
      // Le résultat est gardé par Alfred et revient avec la liste des services (`lastTest`).
      await testClient(target.id, target.simple ? undefined : instance.id);
    } catch (failure) {
      notify({ title: `${target.label} : le test a échoué`, description: errorMessage(failure), tone: "error" });
    } finally {
      setTesting(undefined);
      await services.load();
    }
  }

  /** Crée le service d’une étape : depuis le modèle du module, sinon par le formulaire prérempli. */
  async function createService(item: SetupStep) {
    const owner = modules.find((candidate) => candidate.id === item.module);
    const need = owner?.clients.find((candidate) => candidate.id === item.need);
    const wanted = clients.some((known) => known.id === item.need) ? undefined : item.need;
    if (!need?.client) {
      onEdit({
        kind: "client",
        preset: {
          id: wanted,
          label: item.label,
          baseUrl: need?.baseUrl ?? "",
          auth: { type: (need?.auth ?? "none") as AuthType },
        },
      });
      return;
    }
    setCreating(item.key);
    try {
      const template = need.client as Partial<ClientConfig>;
      const id = wanted ?? freeId(item.need, clients);
      const saved = await saveClient(
        { ...template, id, label: template.label || item.label, baseUrl: template.baseUrl ?? "" } as ClientConfig,
        true,
      );
      // Un service créé sous un autre nom que le besoin doit lui être relié.
      const needItem = needs.find((candidate) => candidate.key === item.key);
      if (id !== item.need && needItem) await services.bind(needItem, id);
      await services.load();
      // Plusieurs comptes possibles : le premier se crée tout de suite.
      if (!saved.simple) onEdit({ kind: "instance", client: saved });
    } catch (failure) {
      notify({ title: `${item.label} n’a pas pu être créé`, description: errorMessage(failure), tone: "error" });
    } finally {
      setCreating(undefined);
    }
  }

  const header = (
    <div className="setup-flow__header">
      <Button onClick={onClose}>
        <ArrowLeft size={16} aria-hidden="true" />
        Terminer plus tard
      </Button>
      <div className="setup-flow__title">
        <h2>Configurer {setup.name}</h2>
        <p>
          {current === INTRO || current === DONE
            ? setup.ready
              ? "Tout est prêt."
              : `${total} étape${total > 1 ? "s" : ""} à suivre. Vous pouvez vous arrêter et reprendre plus tard.`
            : `Étape ${index} sur ${total}`}
        </p>
      </div>
    </div>
  );

  const stepper = (
    <StepList
      label={`Étapes de la configuration de ${setup.name}`}
      steps={[
        { id: INTRO, title: "Présentation" },
        ...setup.steps.map((item) => ({
          id: item.key,
          title: item.label,
          hint: item.optional && item.state !== "ready" ? "Facultatif" : STEP_STATE[item.state].label,
        })),
        { id: DONE, title: "Terminé" },
      ]}
      current={current}
      onSelect={setCurrent}
    />
  );

  const intro = (
    <div className="setup-flow__body">
      <h3>Bienvenue dans {setup.name}</h3>
      {setup.description ? <Text>{setup.description}</Text> : null}
      {setup.welcome ? <Text>{setup.welcome}</Text> : null}
      {total === 0 ? (
        <Text tone="muted">Ce module n’a besoin de rien d’autre : il est prêt à servir.</Text>
      ) : (
        <>
          <Text>Pour fonctionner, il a besoin de :</Text>
          <ul className="setup-flow__needs">
            {setup.steps.map((item) => (
              <li key={item.key}>
                <strong>{item.label}</strong>
                {item.optional ? " (facultatif)" : ""}
                {item.module !== setup.module ? ` — pour ${item.moduleName}, installé avec lui` : ""}
                {item.state === "ready" ? (
                  <span className="setup-flow__done">
                    <Check size={14} aria-hidden="true" /> déjà prêt
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <Text tone="muted" size="meta">
            Comptez quelques minutes. Gardez sous la main vos identifiants de ces services.
          </Text>
        </>
      )}
    </div>
  );

  /** Ce qu’un compte attend, et le bouton qui le fait. */
  const accountRow = (target: ClientItem, instance: ClientInstanceItem) => {
    const key = `${target.id}#${instance.id}`;
    const label = target.simple ? target.label : `${target.label} — ${instance.label}`;
    const edit = () =>
      onEdit(target.simple ? { kind: "client", client: target } : { kind: "instance", client: target, instance });
    const lastTest = instance.lastTest;
    let message: string;
    let tone: "muted" | "success" | "warning" | "danger" = "muted";
    let action = null;
    if (testing === key) {
      message = "Test de la connexion…";
    } else if (instance.status === "invalid") {
      message = instance.problem ?? "Ce compte est mal configuré.";
      tone = "danger";
      action = <Button onClick={edit}>Corriger…</Button>;
    } else if (instance.status === "toValidate") {
      message = "Vérifiez où partira votre clé, puis approuvez.";
      tone = "warning";
      action = (
        <Button variant="primary" aria-label={`Approuver ${label}`} onClick={() => void services.validate(target)}>
          Approuver
        </Button>
      );
    } else if (instance.status === "missingSecret") {
      message = "Saisissez le mot de passe ou la clé de ce compte. Il reste sur cet ordinateur, dans le coffre.";
      tone = "warning";
      action = (
        <Button
          variant="primary"
          aria-label={`Saisir la clé de ${label}`}
          onClick={() => (target.simple ? setEntryFor(target) : edit())}
        >
          Saisir la clé…
        </Button>
      );
    } else if (instance.status === "toConnect") {
      message = "Connectez-vous : une page du service s’ouvre dans votre navigateur.";
      tone = "warning";
      action = (
        <Button
          variant="primary"
          aria-label={`Se connecter à ${label}`}
          onClick={() => void services.connect({ client: target, instance: target.simple ? undefined : instance })}
        >
          Se connecter
        </Button>
      );
    } else if (lastTest?.ok) {
      message = `Connexion réussie. ${lastTest.message}`;
      tone = "success";
      action = (
        <Button aria-label={`Tester à nouveau ${label}`} onClick={() => void runTest(target, instance)}>
          Tester à nouveau
        </Button>
      );
    } else if (lastTest) {
      message = `Le test a échoué. ${lastTest.message}`;
      tone = "danger";
      action = (
        <>
          <Button onClick={edit}>Modifier…</Button>
          <Button variant="primary" aria-label={`Réessayer ${label}`} onClick={() => void runTest(target, instance)}>
            Réessayer
          </Button>
        </>
      );
    } else {
      message = "Prêt à être testé.";
      action = (
        <Button variant="primary" aria-label={`Tester ${label}`} onClick={() => void runTest(target, instance)}>
          Tester
        </Button>
      );
    }
    return (
      <SettingRow
        key={instance.id}
        title={
          target.simple ? (instance.authType === "none" ? "Connexion au service" : "Votre compte") : instance.label
        }
        description={
          <Text as="span" size="meta" tone={tone}>
            {message}
          </Text>
        }
      >
        {testing === key ? <Spinner label={`Test de ${label}`} /> : action}
      </SettingRow>
    );
  };

  /** Le modèle du service demande-t-il un compte (une authentification) ? */
  const templateNeedsAccount = (item: SetupStep) => {
    const template = modules
      .find((candidate) => candidate.id === item.module)
      ?.clients.find((candidate) => candidate.id === item.need)?.client as Partial<ClientConfig> | undefined;
    if (!template) return true;
    if (template.methods?.length) return template.methods.some((method) => method.type !== "none");
    return (template.auth?.type ?? "none") !== "none";
  };

  const serviceStep = (item: SetupStep) => {
    const others = clients.filter((known) => known.id !== item.client);
    const needItem = needs.find((candidate) => candidate.key === item.key);
    return (
      <div className="setup-flow__body">
        <div className="setup-flow__step-head">
          <h3>{item.label}</h3>
          <StatusBadge tone={STEP_STATE[item.state].tone} size="compact">
            {STEP_STATE[item.state].label}
          </StatusBadge>
          {item.optional ? <StatusBadge size="compact">Facultatif</StatusBadge> : null}
        </div>
        <Text>
          {item.module === setup.module
            ? `${setup.name} se connecte à ${item.label} en votre nom.`
            : `${item.moduleName}, installé avec ${setup.name}, se connecte à ${item.label} en votre nom.`}
        </Text>
        {item.help ? <Text tone="muted">{item.help}</Text> : null}

        {services.overview === undefined ? (
          <Spinner label="Chargement des services" />
        ) : !client ? (
          <SettingRows label={`Service ${item.label}`}>
            <SettingRow
              title={`Ajouter ${item.label}`}
              description={
                !item.hasTemplate
                  ? "Indiquez l’adresse du service et comment s’y connecter."
                  : templateNeedsAccount(item)
                    ? "Le module sait déjà comment s’y connecter : il ne vous restera qu’à indiquer votre compte."
                    : "Le module sait déjà comment s’y connecter, sans compte : il suffit de l’ajouter."
              }
            >
              <Button
                variant="primary"
                disabled={creating !== undefined}
                aria-label={`Ajouter ${item.label}`}
                onClick={() => void createService(item)}
              >
                {creating === item.key ? "Création…" : "Ajouter"}
              </Button>
            </SettingRow>
            {others.length > 0 && needItem ? (
              <SettingRow
                title="Ou utiliser un service déjà configuré"
                description="Un service que vous avez déjà ajouté dans Alfred."
              >
                <SelectControl
                  aria-label={`Utiliser un service existant pour ${item.label}`}
                  value=""
                  onChange={(event) => void services.bind(needItem, event.target.value)}
                >
                  <option value="">Choisir…</option>
                  {others.map((known) => (
                    <option key={known.id} value={known.id}>
                      {known.label}
                    </option>
                  ))}
                </SelectControl>
              </SettingRow>
            ) : null}
          </SettingRows>
        ) : (
          <>
            {client.status === "invalid" && client.instances.length === 0 ? (
              <FeedbackBanner
                tone="danger"
                action={<Button onClick={() => onEdit({ kind: "client", client })}>Corriger…</Button>}
              >
                {client.problem ?? "Ce service est mal configuré."}
              </FeedbackBanner>
            ) : null}
            <SettingRows label={`Comptes ${client.label}`}>
              {client.instances.map((instance) => accountRow(client, instance))}
            </SettingRows>
            {client.simple ? null : (
              <div className="setup-flow__inline-actions">
                <Button
                  variant={client.instances.length === 0 ? "primary" : "secondary"}
                  aria-label={`Ajouter un compte à ${client.label}`}
                  onClick={() => onEdit({ kind: "instance", client })}
                >
                  <Plus size={14} aria-hidden="true" />
                  {client.instances.length === 0 ? "Ajouter votre compte" : "Ajouter un autre compte"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const left = setup.steps.filter((item) => !item.optional && item.state !== "ready");
  const done = (
    <div className="setup-flow__body">
      {setup.ready ? (
        <>
          <h3>{setup.name} est prêt</h3>
          <Text>Tout ce dont il a besoin est renseigné et testé.</Text>
        </>
      ) : (
        <>
          <h3>Presque fini</h3>
          <Text>Il reste à configurer :</Text>
          <ul className="setup-flow__needs">
            {left.map((item) => (
              <li key={item.key}>
                <button type="button" className="setup-flow__link" onClick={() => setCurrent(item.key)}>
                  {item.label}
                </button>{" "}
                — {STEP_STATE[item.state].label.toLowerCase()}
              </li>
            ))}
          </ul>
          <Text tone="muted" size="meta">
            Le module reste marqué « Configuration à terminer » tant que ces services ne sont pas prêts. Vous pourrez
            reprendre depuis Réglages → Modules.
          </Text>
        </>
      )}
    </div>
  );

  const last = current === DONE;
  const ready = !step || step.state === "ready" || step.optional;
  return (
    <div className="setup-flow">
      {header}
      <div className="setup-flow__layout">
        <aside className="setup-flow__steps">{stepper}</aside>
        <section
          className="setup-flow__main"
          aria-label={step ? step.label : current === INTRO ? "Présentation" : "Terminé"}
        >
          {current === INTRO ? intro : last ? done : step ? serviceStep(step) : null}
          <div className="setup-flow__footer">
            {index > 0 ? <Button onClick={() => go(-1)}>Précédent</Button> : null}
            <span className="setup-flow__spacer" />
            {last ? (
              <>
                {setup.ready && onOpenModule ? <Button onClick={onOpenModule}>Ouvrir le module</Button> : null}
                <Button variant="primary" onClick={onClose}>
                  {setup.ready ? "Terminer" : "Terminer plus tard"}
                </Button>
              </>
            ) : (
              <Button variant={ready ? "primary" : "secondary"} onClick={() => go(1)}>
                {current === INTRO
                  ? total === 0
                    ? "Continuer"
                    : "Commencer"
                  : ready
                    ? "Suivant"
                    : "Passer pour l’instant"}
              </Button>
            )}
          </div>
        </section>
      </div>
      {entryFor ? (
        <VaultEntryDialog
          fixedKind={AUTH_TYPES.find((item) => item.type === entryFor.auth?.type)?.vaultKind}
          suggested={{ label: entryFor.label }}
          onClose={() => setEntryFor(undefined)}
          onSaved={(entry) => {
            const target = entryFor;
            setEntryFor(undefined);
            void (async () => {
              try {
                await saveClient(
                  { ...configOf(target), auth: { ...(target.auth ?? { type: "none" }), secret: entry.id } },
                  false,
                );
              } catch (failure) {
                notify({ title: "La clé n’a pas été reliée", description: errorMessage(failure), tone: "error" });
              }
              await services.load();
            })();
          }}
        />
      ) : null}
    </div>
  );
}
