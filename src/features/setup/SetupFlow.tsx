/**
 * Parcours de configuration d’un module, pas à pas : ce qu’il fait, puis une étape par service (ajouter le compte,
 * saisir la clé, approuver, se connecter, tester), puis ses pages : chaque modèle du module y est déjà ajouté une
 * fois ; l’utilisateur en retire, en ajoute, les nomme et choisit leurs comptes page par page. Puis un récapitulatif.
 * Un compte est créé une fois par service ; plusieurs pages peuvent s’en servir.
 *
 * Rien n’est mémorisé : chaque étape se lit dans l’état réel des services (`modules.setup`), si bien qu’on peut
 * quitter le parcours à tout moment et le reprendre là où il en était.
 */
import { Button, SettingRow, SettingRows, Spinner, StatusBadge, StepList, Text } from "@alfred/ui";
import { ArrowLeft, Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { type ClientInstanceItem, type ClientItem, testClient } from "../clients/api";
import { createFromTemplate, templateNeedsAccount, templateOf } from "../clients/fromTemplate";
import { UNDESCRIBED } from "../clients/ServiceBlock";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { userPagesOf } from "../modules/menuApi";
import { errorMessage } from "../vault/api";
import type { ModuleSetup, SetupStep, SetupStepState } from "./api";
import { ModulePagesStep } from "./ModulePagesStep";
import "./setup.css";

const INTRO = "intro";
const PAGES = "pages";
const DONE = "fin";
/** État d’une étape, en mots simples. */
export const STEP_STATE: Record<SetupStepState, { label: string; tone: "success" | "pending" | "danger" }> = {
  missing: { label: "À configurer", tone: "pending" },
  incomplete: { label: "À terminer", tone: "pending" },
  untested: { label: "À tester", tone: "pending" },
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

export function SetupFlow({
  setup,
  modules,
  services,
  start,
  step: first,
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
  /** Étape d’ouverture (`module/besoin`), avant `start` : le service qui manque à une page. */
  step?: string;
  onEdit: (editing: ServiceEditing) => void;
  onClose: () => void;
  /** Ouvre la première section du module dans le menu ; absent si le module n’en a pas. */
  onOpenModule?: () => void;
}) {
  const [current, setCurrent] = useState<string>();
  const [creating, setCreating] = useState<string>();
  const [testing, setTesting] = useState<string>();
  /** Comptes déjà testés d’office pendant ce parcours : on ne relance pas un test qui vient d’échouer. */
  const autoTested = useRef(new Set<string>());

  const snapshot = useShell((state) => state.snapshot);
  const owner = setup ? modules.find((candidate) => candidate.id === setup.module) : undefined;
  const templates = (snapshot?.templates ?? []).filter((template) => template.module === setup?.module);
  const entries = setup && snapshot ? userPagesOf(snapshot, setup.module) : [];
  /** L’étape « Vos pages » n’a lieu que si le module a des modèles de pages. */
  const naming = (templates.length > 0 || entries.length > 0) && owner !== undefined;
  const ids = useMemo(
    () => [INTRO, ...(setup?.steps.map((item) => item.key) ?? []), ...(naming ? [PAGES] : []), DONE],
    [naming, setup],
  );

  useEffect(() => {
    if (current || !setup) return;
    const wanted = first && setup.steps.some((item) => item.key === first) ? first : undefined;
    setCurrent(wanted ?? (start === "intro" ? INTRO : resumeStep(setup)));
  }, [current, setup, start, first]);

  const clients = services.overview?.clients ?? [];
  const step = setup?.steps.find((candidate) => candidate.key === current);
  const stepNeeds = step ? [step] : [];
  const stepClients = stepNeeds.flatMap((item) => clients.filter((candidate) => candidate.id === item.client));

  // Un compte prêt qui n’a jamais été testé l’est d’office, une fois : la plupart des gens n’y penseraient pas.
  useEffect(() => {
    if (testing) return;
    for (const client of stepClients) {
      const instance = client.instances.find(
        (candidate) =>
          candidate.status === "ready" &&
          !candidate.lastTest &&
          !autoTested.current.has(`${client.id}#${candidate.id}`),
      );
      if (!instance) continue;
      autoTested.current.add(`${client.id}#${instance.id}`);
      void runTest(client, instance);
      return;
    }
  });
  if (!setup || !current) return <Spinner label="Chargement de la configuration" />;

  const index = Math.max(0, ids.indexOf(current));
  const go = (offset: number) => setCurrent(ids[Math.min(ids.length - 1, Math.max(0, index + offset))]);
  const total = setup.steps.length;
  /** Étapes entre la présentation et la fin : un service chacune, puis les pages. */
  const stepCount = ids.length - 2;

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

  /** Crée le service d’une étape d’après le modèle du module, puis ouvre l’ajout du premier compte. */
  async function createService(item: SetupStep) {
    const template = templateOf(modules, item.module, item.need);
    if (!template) return;
    setCreating(item.key);
    try {
      const saved = await createFromTemplate(template, { key: item.key, id: item.need, label: item.label }, services);
      if (templateNeedsAccount(template)) onEdit({ kind: "account", client: saved, help: item.help || undefined });
    } catch (failure) {
      notify({ title: `${item.label} n’a pas pu être ajouté`, description: errorMessage(failure), tone: "error" });
    } finally {
      setCreating(undefined);
    }
  }

  const header = (
    <div className="setup-flow__header">
      <Button variant="subtle" onClick={onClose}>
        <ArrowLeft size={16} aria-hidden="true" />
        Terminer plus tard
      </Button>
      <div className="setup-flow__title">
        <h2>Configurer {setup.name}</h2>
        <p>
          {current === INTRO || current === DONE
            ? setup.ready && !naming
              ? "Tout est prêt."
              : `${stepCount} étape${stepCount > 1 ? "s" : ""}. Vous pouvez vous arrêter et reprendre plus tard.`
            : `Étape ${index + 1} sur ${ids.length}`}
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
        ...(naming ? [{ id: PAGES, title: "Vos pages", hint: `${entries.length} dans le menu` }] : []),
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
      {naming ? (
        <Text>
          {total > 0
            ? "Vous allez d’abord ajouter et tester vos comptes, puis choisir vos pages dans le menu de gauche, et le compte de chacune."
            : "Vous allez choisir ses pages dans le menu de gauche et leur donner le nom qui vous parle."}
        </Text>
      ) : null}
      {total === 0 ? (
        <Text tone="muted">Ce module n’a besoin d’aucun compte : il est prêt à servir.</Text>
      ) : (
        <>
          <Text>Pour fonctionner, il a besoin de ces services :</Text>
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
    const edit = () => onEdit({ kind: "account", client: target, instance, help: step?.help || undefined });
    const lastTest = instance.lastTest;
    let message: string;
    let tone: "muted" | "success" | "warning" | "danger" = "muted";
    let action = null;
    if (testing === key) {
      message = "Test de la connexion…";
    } else if (instance.status === "invalid") {
      message = instance.problem ?? UNDESCRIBED;
      tone = "danger";
    } else if (instance.status === "toValidate") {
      message = "Vérifiez où partira votre clé, puis approuvez.";
      tone = "warning";
      action = (
        <Button variant="primary" aria-label={`Approuver ${label}`} onClick={() => void services.validate(target)}>
          Approuver
        </Button>
      );
    } else if (instance.status === "missingSecret") {
      message = "Saisissez vos identifiants. Ils restent sur cet ordinateur, dans le coffre.";
      tone = "warning";
      action = (
        <Button variant="primary" aria-label={`Saisir les identifiants de ${label}`} onClick={edit}>
          Saisir vos identifiants…
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
        <Button
          variant="secondary"
          aria-label={`Tester à nouveau ${label}`}
          onClick={() => void runTest(target, instance)}
        >
          Tester à nouveau
        </Button>
      );
    } else if (lastTest) {
      message = `Le test a échoué. ${lastTest.message}`;
      tone = "danger";
      action = (
        <>
          <Button variant="secondary" onClick={edit}>
            Modifier…
          </Button>
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

  /**
   * Combien de comptes ce service accepte, dit simplement : un seul, ou plusieurs (deux boîtes mail, deux sites
   * Jira), avec une page par compte quand le module en affiche une pour chacun.
   */
  const accountsRule = (item: SetupStep) => {
    const known = item.client ? clients.find((candidate) => candidate.id === item.client) : undefined;
    const template = templateOf(modules, item.module, item.need);
    const several = known ? !known.simple : Boolean(template?.methods?.length);
    if (!several) return "Un seul compte suffit pour ce service.";
    return "Vous pouvez connecter plusieurs comptes : chaque page choisit ensuite le sien.";
  };

  /** Les comptes d’un besoin, et de quoi les ajouter et les tester. */
  const accountsOf = (item: SetupStep) => {
    const template = templateOf(modules, item.module, item.need);
    const client = item.client ? clients.find((candidate) => candidate.id === item.client) : undefined;
    if (services.overview === undefined) return <Spinner label="Chargement des services" />;
    if (!client)
      return template ? (
        <SettingRows label={`Comptes ${item.label}`}>
          <SettingRow
            title={templateNeedsAccount(template) ? "Votre compte" : item.label}
            description={
              templateNeedsAccount(template)
                ? "Le module sait comment s’y connecter : il ne vous demande que vos identifiants."
                : "Le module sait comment s’y connecter, sans compte : il suffit de l’activer."
            }
          >
            <Button
              variant="primary"
              loading={creating === item.key}
              disabled={creating !== undefined}
              aria-label={`Ajouter votre compte ${item.label}`}
              onClick={() => void createService(item)}
            >
              {templateNeedsAccount(template) ? "Ajouter votre compte" : "Activer"}
            </Button>
          </SettingRow>
        </SettingRows>
      ) : (
        <Text tone="warning">{UNDESCRIBED}</Text>
      );
    const shown = client.instances;
    return (
      <>
        {client.status === "invalid" && client.instances.length === 0 ? (
          <Text tone="danger">{client.problem ?? UNDESCRIBED}</Text>
        ) : null}
        <SettingRows label={`Comptes ${client.label}`}>
          {shown.map((instance) => accountRow(client, instance))}
        </SettingRows>
        {client.simple ? null : (
          <div className="setup-flow__inline-actions">
            <Button
              variant={shown.length === 0 ? "primary" : "secondary"}
              aria-label={`Ajouter un compte à ${client.label}`}
              onClick={() => onEdit({ kind: "account", client, help: item.help || undefined })}
            >
              {shown.length === 0 ? "Ajouter votre compte" : "Ajouter un autre compte"}
            </Button>
          </div>
        )}
      </>
    );
  };

  const stepBadges = (item: SetupStep) => (
    <>
      <StatusBadge tone={STEP_STATE[item.state].tone} size="compact">
        {STEP_STATE[item.state].label}
      </StatusBadge>
      {item.optional ? <StatusBadge size="compact">Facultatif</StatusBadge> : null}
    </>
  );

  const serviceStep = (item: SetupStep) => (
    <div className="setup-flow__body">
      <div className="setup-flow__step-head">
        <h3>{item.label}</h3>
        {stepBadges(item)}
      </div>
      <Text>
        {item.module === setup.module
          ? `${setup.name} se connecte à ${item.label} en votre nom.`
          : `${item.moduleName}, installé avec ${setup.name}, se connecte à ${item.label} en votre nom.`}
      </Text>
      {item.help ? <Text tone="muted">{item.help}</Text> : null}
      <Text tone="muted">{accountsRule(item)}</Text>
      {accountsOf(item)}
    </div>
  );

  const left = setup.steps.filter((item) => !item.optional && item.state !== "ready");
  /** Un service au moins est prêt : le module sert déjà, le reste peut attendre. */
  const usable = setup.steps.some((item) => item.state === "ready");
  const done = (
    <div className="setup-flow__body">
      {setup.ready ? (
        <>
          <h3>{setup.name} est prêt</h3>
          <Text>Tout ce dont il a besoin est renseigné et testé.</Text>
        </>
      ) : (
        <>
          <h3>{usable ? `${setup.name} est prêt à servir` : "Presque fini"}</h3>
          {usable ? (
            <Text>Vous pouvez déjà vous en servir. Ce qui dépend de ces services restera vide en attendant :</Text>
          ) : (
            <Text>Il reste à configurer :</Text>
          )}
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
            Vous pourrez les configurer plus tard depuis Réglages → Modules.
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
          aria-label={
            step ? step.label : current === INTRO ? "Présentation" : current === PAGES ? "Vos pages" : "Terminé"
          }
        >
          {current === INTRO ? (
            intro
          ) : current === PAGES && owner && snapshot ? (
            <ModulePagesStep
              module={owner}
              modules={modules}
              snapshot={snapshot}
              entries={entries}
              services={services}
              onEdit={onEdit}
            />
          ) : last ? (
            done
          ) : step ? (
            serviceStep(step)
          ) : null}
          <div className="setup-flow__footer">
            {index > 0 ? <Button onClick={() => go(-1)}>Précédent</Button> : null}
            <span className="setup-flow__spacer" />
            {!last && step?.state === "ready" && !setup.ready && onOpenModule ? (
              <Button onClick={onOpenModule}>Utiliser maintenant</Button>
            ) : null}
            {last ? (
              <>
                {(setup.ready || usable) && onOpenModule ? (
                  // Une partie marche déjà : s’en servir est la suite naturelle, finir la configuration attendra.
                  <Button variant={!setup.ready ? "primary" : "secondary"} onClick={onOpenModule}>
                    Ouvrir le module
                  </Button>
                ) : null}
                <Button variant={!setup.ready && usable && onOpenModule ? "secondary" : "primary"} onClick={onClose}>
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
    </div>
  );
}
