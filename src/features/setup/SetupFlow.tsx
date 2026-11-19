/**
 * Parcours de configuration d’un module, pas à pas et page d’abord : ce qu’il fait, le nom de ses pages, puis une
 * étape par page qui se sert de comptes (ajouter le compte, saisir la clé, approuver, se connecter, tester), puis
 * les comptes qu’aucune page n’utilise, puis un récapitulatif. Un compte partagé par deux pages se configure sous la
 * première ; la seconde le montre, déjà prêt.
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
import { type ClientInstanceItem, type ClientItem, setAccountPages, testClient } from "../clients/api";
import { createFromTemplate, templateNeedsAccount, templateOf } from "../clients/fromTemplate";
import { UNDESCRIBED } from "../clients/ServiceBlock";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { accountsWithPage, type PageEntry, type PageGroup, pageGroups } from "../modules/pageGroups";
import { errorMessage } from "../vault/api";
import type { ModuleSetup, SetupStep, SetupStepState } from "./api";
import { ModuleNaming, moduleSections } from "./ModuleNaming";
import "./setup.css";

const INTRO = "intro";
const PAGES = "pages";
const DONE = "fin";
/** Étape d’une page : `page:<groupe>`. */
const PAGE = "page:";

/** Pages du module qui se servent d’au moins un compte, dans l’ordre du menu. */
export function pagesWithAccounts(groups: PageGroup[], setup: ModuleSetup): PageGroup[] {
  const known = new Set(setup.steps.map((step) => step.key));
  return groups.filter((group) => group.needs.some((need) => known.has(need)));
}

/** Étape du parcours où se configure un besoin : la première page qui s’en sert, sinon le besoin lui-même. */
export function stepOfNeed(groups: PageGroup[], need: string): string {
  const group = groups.find((candidate) => candidate.needs.includes(need));
  return group ? `${PAGE}${group.key}` : need;
}

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
  const sections = setup && snapshot ? moduleSections(snapshot.sections, setup.module) : [];
  const owner = setup ? modules.find((candidate) => candidate.id === setup.module) : undefined;
  /** L’étape « Vos pages » n’a lieu que si le module ajoute quelque chose au menu. */
  const naming = sections.length > 0 && owner !== undefined;
  const groups = useMemo(
    () => (setup && snapshot ? pagesWithAccounts(pageGroups(snapshot, setup.module), setup) : []),
    [setup, snapshot],
  );
  /** Besoins qu’aucune page ne configure : une étape chacun, après les pages. */
  const loose = useMemo(
    () => setup?.steps.filter((item) => !groups.some((group) => group.needs.includes(item.key))) ?? [],
    [setup, groups],
  );
  const ids = useMemo(
    () => [
      INTRO,
      ...(naming ? [PAGES] : []),
      ...groups.map((group) => `${PAGE}${group.key}`),
      ...loose.map((item) => item.key),
      DONE,
    ],
    [naming, groups, loose],
  );

  useEffect(() => {
    if (current || !setup) return;
    const wanted = first && setup.steps.some((item) => item.key === first) ? stepOfNeed(groups, first) : undefined;
    const resumed = resumeStep(setup);
    setCurrent(wanted ?? (start === "intro" ? INTRO : resumed === DONE ? DONE : stepOfNeed(groups, resumed)));
  }, [current, setup, start, first, groups]);

  const clients = services.overview?.clients ?? [];
  const step = setup?.steps.find((candidate) => candidate.key === current);
  const page = current?.startsWith(PAGE) ? groups.find((group) => `${PAGE}${group.key}` === current) : undefined;
  /** Besoins configurés à l’étape affichée : ceux de la page, ou le besoin seul. */
  const stepNeeds = page ? (setup?.steps.filter((item) => page.needs.includes(item.key)) ?? []) : step ? [step] : [];
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
  /** Étapes entre la présentation et la fin : nommer les pages, une par page, puis un service chacune. */
  const stepCount = ids.length - 2;
  /** Une page est prête quand tous ses comptes essentiels le sont. */
  const pageState = (group: PageGroup): SetupStepState => {
    const own = setup.steps.filter((item) => group.needs.includes(item.key) && !item.optional);
    return own.find((item) => item.state !== "ready")?.state ?? "ready";
  };

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
  async function createService(item: SetupStep, page?: string) {
    const template = templateOf(modules, item.module, item.need);
    if (!template) return;
    setCreating(item.key);
    try {
      const saved = await createFromTemplate(template, { key: item.key, id: item.need, label: item.label }, services);
      if (templateNeedsAccount(template))
        onEdit({ kind: "account", client: saved, help: item.help || undefined, page });
    } catch (failure) {
      notify({ title: `${item.label} n’a pas pu être ajouté`, description: errorMessage(failure), tone: "error" });
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
        ...(naming ? [{ id: PAGES, title: "Vos pages", hint: "Les nommer" }] : []),
        ...groups.map((group) => ({
          id: `${PAGE}${group.key}`,
          title: group.title,
          hint: STEP_STATE[pageState(group)].label,
        })),
        ...loose.map((item) => ({
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
      {naming ? (
        <Text>
          Vous allez d’abord nommer {sections.length > 1 ? "ses pages" : "sa page"} dans le menu de gauche
          {total > 0 ? ", puis, page par page, ajouter et tester les comptes dont chacune se sert." : "."}
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
          variant="outline"
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
          <Button variant="outline" onClick={edit}>
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
    const pagePerAccount =
      sections.some((section) => section.perInstance === item.need || section.instance) ||
      Boolean(snapshot?.accountPages?.some((page) => page.module === item.module && page.need === item.need));
    if (!several) return "Un seul compte suffit pour ce service.";
    return pagePerAccount
      ? "Vous pouvez connecter plusieurs comptes : chacun aura sa propre page dans le menu."
      : "Vous pouvez connecter plusieurs comptes, et en ajouter d’autres plus tard.";
  };

  /** Ajoute à un compte existant une page qui existe pour chaque compte. */
  async function addPageTo(client: ClientItem, instance: ClientInstanceItem, entry: PageEntry) {
    const key = `${client.id}/${instance.id}`;
    try {
      await setAccountPages(client.id, instance.id, [...(snapshot?.accounts?.[key] ?? []), entry.reference]);
    } catch (failure) {
      notify({ title: "La page n’a pas été ajoutée", description: errorMessage(failure), tone: "error" });
    }
  }

  /**
   * Les comptes d’un besoin, et de quoi les ajouter et les tester. `entry` : la page existe pour chaque compte ; on
   * ne montre que les comptes qui l’ont, les autres se la voient proposer, et un compte ajouté la reçoit d’office.
   */
  const accountsOf = (item: SetupStep, entry?: PageEntry) => {
    const template = templateOf(modules, item.module, item.need);
    const client = item.client ? clients.find((candidate) => candidate.id === item.client) : undefined;
    const page = entry?.reference;
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
              onClick={() => void createService(item, page)}
            >
              {templateNeedsAccount(template) ? "Ajouter votre compte" : "Activer"}
            </Button>
          </SettingRow>
        </SettingRows>
      ) : (
        <Text tone="warning">{UNDESCRIBED}</Text>
      );
    const chosen = entry ? accountsWithPage(snapshot?.accounts, client.id, entry) : null;
    const shown = client.instances.filter((instance) => !chosen || chosen.has(instance.id));
    const others = chosen ? client.instances.filter((instance) => !chosen.has(instance.id)) : [];
    return (
      <>
        {client.status === "invalid" && client.instances.length === 0 ? (
          <Text tone="danger">{client.problem ?? UNDESCRIBED}</Text>
        ) : null}
        <SettingRows label={`Comptes ${client.label}`}>
          {shown.map((instance) => accountRow(client, instance))}
        </SettingRows>
        {others.length > 0 && entry ? (
          <SettingRows label={`Autres comptes ${client.label}`}>
            {others.map((instance) => (
              <SettingRow
                key={instance.id}
                title={instance.label}
                description={`N’a pas encore la page « ${entry.title} ».`}
              >
                <Button
                  variant="outline"
                  aria-label={`Ajouter la page ${entry.title} à ${instance.label}`}
                  onClick={() => void addPageTo(client, instance, entry)}
                >
                  Ajouter la page
                </Button>
              </SettingRow>
            ))}
          </SettingRows>
        ) : null}
        {client.simple ? null : (
          <div className="setup-flow__inline-actions">
            <Button
              variant={shown.length === 0 ? "primary" : "outline"}
              aria-label={`Ajouter un compte à ${client.label}`}
              onClick={() => onEdit({ kind: "account", client, help: item.help || undefined, page })}
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

  /** Étape d’une page : les comptes dont elle se sert, un bloc par service. */
  const pageStep = (group: PageGroup) => {
    const items = setup.steps.filter((item) => group.needs.includes(item.key));
    const earlier = groups.slice(0, groups.indexOf(group));
    return (
      <div className="setup-flow__body">
        <h3>Page « {group.title} »</h3>
        <Text>
          {items.length > 1
            ? `Cette page se sert de ${items.length} comptes : ${items.map((item) => item.label).join(", ")}.`
            : `Cette page se sert de votre compte ${items[0]?.label ?? ""}.`}
        </Text>
        {items.map((item) => {
          const before = earlier.find((other) => other.needs.includes(item.key));
          const entry = group.pages.find((candidate) => candidate.perInstance === item.key);
          return (
            <section key={item.key} className="setup-flow__account" aria-label={`Compte ${item.label}`}>
              <div className="setup-flow__step-head">
                <h4>Compte {item.label}</h4>
                {stepBadges(item)}
              </div>
              {before ? (
                <Text tone="muted">{`Le même compte que pour la page « ${before.title} » : rien à refaire s’il est prêt.`}</Text>
              ) : item.help ? (
                <Text tone="muted">{item.help}</Text>
              ) : null}
              {entry ? (
                <Text tone="muted">
                  {group.instancesAs === "tabs"
                    ? `La page « ${entry.title} » a un onglet par compte : chaque compte ajouté ici a le sien.`
                    : `La page « ${entry.title} » a une entrée du menu par compte : chaque compte ajouté ici a la sienne.`}
                </Text>
              ) : null}
              {accountsOf(item, entry)}
            </section>
          );
        })}
      </div>
    );
  };

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
                <button
                  type="button"
                  className="setup-flow__link"
                  onClick={() => setCurrent(stepOfNeed(groups, item.key))}
                >
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
  const ready = page ? pageState(page) === "ready" : !step || step.state === "ready" || step.optional;
  return (
    <div className="setup-flow">
      {header}
      <div className="setup-flow__layout">
        <aside className="setup-flow__steps">{stepper}</aside>
        <section
          className="setup-flow__main"
          aria-label={
            page
              ? `Page ${page.title}`
              : step
                ? step.label
                : current === INTRO
                  ? "Présentation"
                  : current === PAGES
                    ? "Vos pages"
                    : "Terminé"
          }
        >
          {current === INTRO ? (
            intro
          ) : current === PAGES && owner ? (
            <ModuleNaming module={owner} />
          ) : last ? (
            done
          ) : page ? (
            pageStep(page)
          ) : step ? (
            serviceStep(step)
          ) : null}
          <div className="setup-flow__footer">
            {index > 0 ? <Button onClick={() => go(-1)}>Précédent</Button> : null}
            <span className="setup-flow__spacer" />
            {!last && (page ? pageState(page) === "ready" : step?.state === "ready") && !setup.ready && onOpenModule ? (
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
              <Button variant={ready ? "primary" : "outline"} onClick={() => go(1)}>
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
