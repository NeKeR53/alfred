/**
 * Parcours de configuration d’un module, de la page vers le compte, pour quelqu’un qui n’y connaît rien :
 *
 * 1. ce que le module apporte, en une phrase, avec un aperçu de ses pages ;
 * 2. « Quelles pages voulez-vous ? » : une carte par modèle de page, cochée une fois par défaut ; on en décoche, on
 *    en ajoute une deuxième d’un même modèle, on les renomme sur place ;
 * 3. une étape par page qui a besoin d’un compte : « À quel compte Prefect se connecter pour « Prefect » ? », en
 *    grandes cartes, les comptes déjà connectés de tout l’espace (y compris ceux d’un autre module), puis
 *    « Connecter un nouveau compte », qui ouvre l’assistant ;
 * 4. après le premier compte d’une page, « Vous avez un autre compte Prefect ? » : un onglet de plus dans la page ;
 * 5. la fin : le menu tel qu’il sera, et « Ouvrir … ».
 *
 * L’onboarding écrit les mêmes pages, onglets et comptes que la fiche du module (`space.menu.*`). Rien n’est
 * mémorisé : chaque étape se lit dans l’état réel, et la reprise repart de la première étape incomplète.
 */
import { ArrowLeft, Boxes, Check, Pencil, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Link, ProgressBar, StatusBadge, StepList, TextField, useConfirm } from "socle-ui";
import { Text } from "../../kit";
import type { ModuleSummary, ResolvedSection, Snapshot } from "../../lib/types";
import { NamedIcon, SectionIcon } from "../../shell/icons";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { type ClientItem, type FailureReason, testClient, validateClient } from "../clients/api";
import type { ClientsController } from "../clients/useClients";
import { templateOfPage, userPages } from "../modules/menuApi";
import { errorMessage } from "../vault/api";
import { AccountWizard, failureText } from "./AccountWizard";
import type { ModuleSetup } from "./api";
import {
  type AccountOption,
  type AccountState,
  accountState,
  currentOption,
  draftChanges,
  entriesOf,
  initialDrafts,
  mainNeed,
  type NeedPlan,
  needDone,
  nextLabel,
  optionsOf,
  ownClient,
  type PageDraft,
  type PagePlan,
  pageDone,
  planOf,
  primaryTabs,
  sectionChoices,
} from "./flow";
import "./setup.css";

const INTRO = "intro";
const PAGES = "pages";
const DONE = "fin";
const pageStep = (entry: string) => `page:${entry}`;
const accountStep = (key: string) => `compte:${key}`;

/** Ce que dit la carte d’un compte, selon son état. */
const CARD_STATE: Record<AccountState, { label: string; tone: "success" | "pending" | "danger" }> = {
  ready: { label: "Connecté", tone: "success" },
  untested: { label: "À vérifier", tone: "pending" },
  failed: { label: "La vérification a échoué", tone: "danger" },
  approve: { label: "À autoriser", tone: "pending" },
  secret: { label: "Mot de passe manquant", tone: "pending" },
  connect: { label: "À reconnecter", tone: "pending" },
  invalid: { label: "À corriger", tone: "danger" },
};

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};

/** Raison d’un échec gardé par Alfred, d’après son message (le dernier test n’en garde que le texte). */
export function reasonOf(message: string): FailureReason {
  if (/\(401\)/.test(message)) return "refused";
  if (/\(403\)/.test(message)) return "forbidden";
  if (/\((404|405)\)/.test(message)) return "notFound";
  if (/certificat|certificate/i.test(message)) return "certificate";
  if (/^(Connexion au service impossible|Délai dépassé)/.test(message)) return "unreachable";
  return "error";
}

/** Toutes les étapes du parcours, dans l’ordre, et ce qu’il reste à faire dans chacune. */
export function flowSteps(setup: ModuleSetup, snapshot: Snapshot, overview: ClientsController["overview"]) {
  const pages = sectionChoices(snapshot, setup.module).length > 0;
  const plans = entriesOf(snapshot, setup.module)
    .map((entry) => planOf(snapshot, entry, setup, overview))
    .filter((plan) => plan.needs.length > 0);
  // Un compte qu’une page du module demande se règle dans l’étape de cette page, même si l’utilisateur ne l’a pas
  // gardée : il n’en veut pas, on ne le lui redemande pas.
  const covered = new Set([
    ...plans.flatMap((plan) => plan.needs.map((need) => need.key)),
    ...(snapshot.templates ?? [])
      .filter((template) => template.module === setup.module)
      .flatMap((template) => template.needs.map((need) => (need.includes("/") ? need : `${template.module}/${need}`))),
  ]);
  // Un compte dont aucune page n’a besoin (fonctions seules, dépendance) a sa propre étape.
  const orphans = setup.steps.filter((step) => !step.optional && !covered.has(step.key));
  return {
    pages,
    plans,
    orphans,
    ids: [
      INTRO,
      ...(pages ? [PAGES] : []),
      ...plans.map((plan) => pageStep(plan.entry.id)),
      ...orphans.map((step) => accountStep(step.key)),
      DONE,
    ],
  };
}

/** Étape de la reprise : la première page (ou le premier compte) qui n’est pas prête, sinon la fin ; `need`, celle d’un compte précis. */
export function resumeStep(
  setup: ModuleSetup,
  snapshot: Snapshot,
  overview: ClientsController["overview"],
  need?: string,
): string {
  const { plans, orphans } = flowSteps(setup, snapshot, overview);
  const open = plans.filter((plan) => !pageDone(plan, snapshot, overview));
  const lonely = orphans.filter((step) => step.state !== "ready");
  if (need) {
    const page = open.find((plan) => plan.needs.some((item) => item.key === need));
    if (page) return pageStep(page.entry.id);
    if (lonely.some((step) => step.key === need)) return accountStep(need);
  }
  if (open[0]) return pageStep(open[0].entry.id);
  if (lonely[0]) return accountStep(lonely[0].key);
  return DONE;
}

/** Ce qui se passe dans l’étape d’une page : choisir, connecter un nouveau compte, ou un autre compte de plus. */
type Sub =
  | { view: "choose" }
  | { view: "wizard"; need: string; extra?: boolean; editing?: AccountOption }
  | { view: "another"; need: string }
  | { view: "extra"; need: string };

export function SetupFlow({
  setup,
  modules,
  services,
  start,
  step: wanted,
  onClose,
  onOpenSection,
}: {
  setup: ModuleSetup | undefined;
  modules: ModuleSummary[];
  services: ClientsController;
  /** `intro` juste après l’installation ; `resume` pour reprendre à la première étape incomplète. */
  start: "intro" | "resume";
  /** Compte (`module/besoin`) qui manque à une page : le parcours s’ouvre sur l’étape de cette page. */
  step?: string;
  onClose: () => void;
  /** Ferme le parcours et ouvre une page du menu. */
  onOpenSection: (id: string) => void;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const overview = services.overview;
  const [current, setCurrent] = useState<string>();
  const [sub, setSub] = useState<Sub>({ view: "choose" });
  const [drafts, setDrafts] = useState<PageDraft[]>();
  const [applying, setApplying] = useState(false);
  /** Compte en cours de vérification (`client#instance`), et dernier échec de chaque compte. */
  const [checking, setChecking] = useState<string>();
  const [failures, setFailures] = useState<Record<string, { reason?: FailureReason | null; message: string }>>({});
  /**
   * Assistant ouvert d’office faute de compte à proposer : il reste ouvert quand le compte qu’il vient de créer
   * apparaît dans la liste, jusqu’à ce qu’il ait fini.
   */
  const sticky = useRef<string | undefined>(undefined);
  /** Pages pour lesquelles « Vous avez un autre compte ? » a déjà été posé. */
  const asked = useRef(new Set<string>());
  const confirm = useConfirm();

  const flow = useMemo(
    () => (setup && snapshot ? flowSteps(setup, snapshot, overview) : undefined),
    [setup, snapshot, overview],
  );

  useEffect(() => {
    if (current || !setup || !snapshot || (overview === undefined && !services.error)) return;
    setCurrent(start === "intro" && !wanted ? INTRO : resumeStep(setup, snapshot, overview, wanted));
  }, [current, setup, snapshot, overview, services.error, start, wanted]);
  useEffect(() => {
    if (snapshot && setup && drafts === undefined) setDrafts(initialDrafts(snapshot, setup.module));
  }, [snapshot, setup, drafts]);

  // Les comptes illisibles n’empêchent pas de présenter le module ni de choisir ses pages.
  if (!setup || !snapshot || !flow || !current || (overview === undefined && !services.error))
    return <ProgressBar label="Chargement de la configuration" />;

  const { ids, plans, orphans } = flow;
  // Une page retirée entre-temps : on reprend à l’étape suivante qui existe encore.
  const shown = ids.includes(current) ? current : resumeStep(setup, snapshot, overview);
  const index = ids.indexOf(shown);
  const go = (id: string) => {
    sticky.current = undefined;
    setSub({ view: "choose" });
    setCurrent(id);
  };
  const next = () => go(ids[Math.min(ids.length - 1, index + 1)] ?? DONE);
  const previous = () => go(ids[Math.max(0, index - 1)] ?? INTRO);
  const plan = plans.find((candidate) => pageStep(candidate.entry.id) === shown);
  const orphan = orphans.find((candidate) => accountStep(candidate.key) === shown);
  const options = (key: string) => optionsOf(snapshot, overview, key);
  const keyOf = (option: AccountOption) => `${option.client.id}#${option.instance.id}`;

  /** Teste un compte et garde l’échec pour l’afficher sur sa carte. Rend vrai s’il répond. */
  async function verify(option: AccountOption): Promise<boolean> {
    const key = keyOf(option);
    setChecking(key);
    try {
      const result = await testClient(option.client.id, option.client.simple ? undefined : option.instance.id);
      setFailures((all) => {
        const { [key]: _, ...rest } = all;
        return result.ok ? rest : { ...rest, [key]: { reason: result.reason, message: result.message } };
      });
      return result.ok;
    } catch (failure) {
      setFailures((all) => ({ ...all, [key]: { message: errorMessage(failure) } }));
      return false;
    } finally {
      setChecking(undefined);
      await services.load();
    }
  }

  /** Donne le compte aux onglets de la page qui ont ce besoin (ceux qui n’ont pas déjà un autre compte). */
  async function assign(need: NeedPlan, value: string) {
    for (const tab of primaryTabs(need)) {
      const accounts = { ...(tab.accounts ?? {}) };
      if (value) accounts[need.need] = value;
      else delete accounts[need.need];
      if ((tab.accounts?.[need.need] ?? "") === value) continue;
      await userPages.configure(tab.reference, { accounts });
    }
  }

  /** Un onglet de plus dans la page, pour un autre compte ; le premier onglet prend alors le nom de son compte. */
  async function addTabFor(page: PagePlan, need: NeedPlan, option: AccountOption) {
    const [first] = need.tabs;
    if (!first) return;
    const template = snapshot?.templates?.find((item) => item.reference === templateOfPage(first));
    const firstAccount = currentOption(need, options(need.key));
    await userPages.addTab(page.entry.id, {
      page: templateOfPage(first),
      label: option.instance.label,
      accounts: option.value ? { [need.need]: option.value } : {},
    });
    if (firstAccount && template && first.title === template.title)
      await userPages.configure(first.reference, { label: firstAccount.instance.label });
    notify({ title: `Onglet « ${option.instance.label} » ajouté à « ${page.entry.label} »`, tone: "success" });
  }

  /** Après le premier compte d’une page, une seule fois : « Vous avez un autre compte … ? ». */
  function afterAccount(page: PagePlan, need: NeedPlan) {
    const main = mainNeed(page);
    const own = ownClient(overview, need.key);
    if (main?.key === need.key && !asked.current.has(page.entry.id) && !own?.simple) {
      asked.current.add(page.entry.id);
      setSub({ view: "another", need: need.key });
    } else setSub({ view: "choose" });
  }

  /** Clic sur la carte d’un compte : il devient celui de la page, après ce qu’il lui manque (accord, test, connexion). */
  async function pick(page: PagePlan | undefined, need: NeedPlan | undefined, option: AccountOption, extra = false) {
    const state = accountState(option.instance);
    if (state === "secret" || state === "invalid") {
      if (need) setSub({ view: "wizard", need: need.key, extra, editing: option });
      return;
    }
    try {
      if (state === "approve") {
        const accepted = await confirm({
          title: `Autoriser Alfred à utiliser le compte « ${option.instance.label || option.client.label} » ?`,
          message: `Ce compte a été préparé sans vous. Alfred enverra ses identifiants à ${hostOf(option.instance.effectiveUrl) || "son adresse"}, et à elle seule.`,
          confirmLabel: "Autoriser",
        });
        if (!accepted) return;
        await validateClient(option.client);
        await services.load();
      }
      if (page && need) {
        if (extra) await addTabFor(page, need, option);
        else await assign(need, option.value);
      }
      if (state === "connect") {
        await services.connect({ client: option.client, instance: option.client.simple ? undefined : option.instance });
        return;
      }
      const ok = state === "ready" || (await verify(option));
      if (ok && page && need) {
        // Un onglet de plus : on redemande, pour un troisième compte.
        if (extra) setSub({ view: "another", need: need.key });
        else afterAccount(page, need);
      }
    } catch (failure) {
      notify({ title: "Le compte n’a pas été choisi", description: errorMessage(failure), tone: "error" });
    }
  }

  const header = (
    <div className="setup-flow__header">
      <Button variant="subtle" icon={<ArrowLeft size={16} aria-hidden="true" />} onPress={onClose}>
        Terminer plus tard
      </Button>
      <Text tone="muted">
        {shown === INTRO
          ? "Quelques minutes suffisent. Vous pouvez vous arrêter et reprendre plus tard."
          : `Étape ${index + 1} sur ${ids.length}`}
      </Text>
    </div>
  );

  const stepper = (
    <StepList
      label={`Étapes de la configuration de ${setup.name}`}
      steps={ids.map((id) => {
        if (id === INTRO) return { id, title: "Présentation" };
        if (id === PAGES) return { id, title: "Vos pages" };
        if (id === DONE) return { id, title: "Terminé" };
        const page = plans.find((candidate) => pageStep(candidate.entry.id) === id);
        if (page)
          return {
            id,
            title: page.entry.label,
            description: pageDone(page, snapshot, overview) ? "Prête" : "Compte à choisir",
          };
        const lone = orphans.find((candidate) => accountStep(candidate.key) === id);
        return {
          id,
          title: `Compte ${lone?.label ?? ""}`,
          description: lone?.state === "ready" ? "Prêt" : "À connecter",
        };
      })}
      current={shown}
      onSelect={go}
      orientation="vertical"
    />
  );

  /** Grandes cartes : les comptes du bon type, puis « Connecter un nouveau compte ». */
  const cards = (
    need: Pick<NeedPlan, "key" | "label">,
    list: AccountOption[],
    selected: AccountOption | undefined,
    onPick: (option: AccountOption) => void,
    onNew: () => void,
  ) => (
    <fieldset className="setup-cards" aria-label={`Comptes ${need.label}`}>
      {list.map((option) => {
        const key = keyOf(option);
        const state = accountState(option.instance);
        // Un échec d’avant la reprise se lit dans le dernier test du compte.
        const failure =
          failures[key] ??
          (state === "failed" && option.instance.lastTest
            ? { reason: reasonOf(option.instance.lastTest.message), message: option.instance.lastTest.message }
            : undefined);
        const isSelected = selected !== undefined && keyOf(selected) === key;
        const badge = checking === key ? { label: "Je vérifie…", tone: "pending" as const } : CARD_STATE[state];
        const name =
          option.instance.label || (option.client.simple ? `Votre compte ${option.client.label}` : option.instance.id);
        return (
          <div key={key} className="setup-card-wrap">
            <button
              type="button"
              className={`setup-card${isSelected ? " is-selected" : ""}`}
              aria-pressed={isSelected}
              aria-label={`${name}, ${badge.label}`}
              disabled={checking !== undefined}
              onClick={() => onPick(option)}
            >
              <span className="setup-card__mark" aria-hidden="true">
                {isSelected ? <Check size={14} /> : null}
              </span>
              <span className="setup-card__text">
                <strong>{name}</strong>
                <small>
                  {[
                    hostOf(option.instance.effectiveUrl),
                    option.shared ? `déjà utilisé par ${option.client.label}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </button>
            {failure && checking !== key ? (
              <div className="setup-card__problem">
                <Text size="meta" tone="danger">
                  {failureText(
                    failure.reason,
                    option.instance.authType ?? undefined,
                    hostOf(option.instance.effectiveUrl),
                    failure.message,
                  )}
                </Text>
                <Button
                  variant="subtle"
                  size="sm"
                  onPress={() => setSub({ view: "wizard", need: need.key, editing: option })}
                >
                  Modifier ce compte
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      <button type="button" className="setup-card setup-card--new" onClick={onNew} disabled={checking !== undefined}>
        <span className="setup-card__mark" aria-hidden="true">
          <Plus size={14} />
        </span>
        <span className="setup-card__text">
          <strong>Connecter un nouveau compte</strong>
          <small>Je vous guide pas à pas.</small>
        </span>
      </button>
    </fieldset>
  );

  const helpOf = (key: string) => {
    const [owner, id] = key.split("/");
    return modules.find((module) => module.id === owner)?.clients.find((item) => item.id === id)?.help || undefined;
  };

  /** L’assistant d’un nouveau compte (ou d’un compte à compléter) pour un besoin de la page. */
  const wizard = (
    page: PagePlan | undefined,
    need: NeedPlan,
    mode: Extract<Sub, { view: "wizard" }>,
    back?: () => void,
  ) => (
    <AccountWizard
      key={`${need.key}:${mode.editing ? keyOf(mode.editing) : "nouveau"}:${mode.extra ? "onglet" : ""}`}
      plan={need}
      modules={modules}
      services={services}
      client={mode.editing?.client ?? ownClient(overview, need.key)}
      editing={mode.editing?.instance}
      help={helpOf(need.key)}
      onSaved={async (client: ClientItem, instance: string) => {
        if (!page) return;
        const own = ownClient(overview, need.key);
        const value = client.simple ? "" : !own || own.id === client.id ? instance : `${client.id}/${instance}`;
        const option = client.instances.find((item) => item.id === instance);
        if (mode.extra && option) await addTabFor(page, need, { value, client, instance: option, shared: false });
        else await assign(need, value);
      }}
      onConnected={() => {
        sticky.current = undefined;
        notify({ title: `Compte ${need.label} connecté`, tone: "success" });
        if (page && !mode.extra) afterAccount(page, need);
        else if (page && mode.extra) setSub({ view: "another", need: need.key });
        else setSub({ view: "choose" });
      }}
      onBack={back}
    />
  );

  const intro = (
    <div className="setup-flow__body">
      <h3>{setup.name}</h3>
      <Text>{setup.welcome || setup.description || `${setup.name} ajoute ses pages à votre menu.`}</Text>
      {flow.pages ? (
        <>
          <Text tone="muted">Vous aurez ces pages dans le menu de gauche :</Text>
          <ul className="setup-preview" aria-label="Aperçu des pages">
            {sectionChoices(snapshot, setup.module).map(({ section, templates }) => (
              <li key={section.id}>
                <span className="setup-preview__icon" aria-hidden="true">
                  {section.icon || section.iconUrl ? <SectionIcon section={section} size={16} /> : <Boxes size={16} />}
                </span>
                <span>
                  <strong>{section.label}</strong>
                  {templates[0]?.description ? <small>{templates[0].description}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );

  const pagesStep = drafts ? (
    <PagesChoice drafts={drafts} onChange={setDrafts} disabled={applying} />
  ) : (
    <ProgressBar label="Chargement des pages" />
  );

  /** Enregistre les cartes au menu : retraits, noms, ajouts, chacun comme depuis la fiche du module. */
  async function applyPages() {
    if (!drafts || !snapshot) return;
    const { remove, rename, add } = draftChanges(drafts, snapshot);
    setApplying(true);
    try {
      for (const entry of remove) await userPages.remove(entry);
      for (const { entry, label } of rename) await userPages.configure(entry, { label });
      for (const page of add) await userPages.addPage(page.section, page.tabs, page.label);
      const fresh = useShell.getState().snapshot;
      if (fresh && setup) {
        setDrafts(initialDrafts(fresh, setup.module));
        const after = flowSteps(setup, fresh, overview);
        const at = after.ids.indexOf(PAGES);
        go(after.ids[at + 1] ?? DONE);
      }
    } catch (failure) {
      notify({ title: "Vos pages n’ont pas été enregistrées", description: errorMessage(failure), tone: "error" });
    } finally {
      setApplying(false);
    }
  }

  /** Étape d’une page : une question par compte dont elle a besoin. */
  const pageView = (page: PagePlan) => {
    if (sub.view === "wizard") {
      const need = page.needs.find((item) => item.key === sub.need);
      if (need) {
        const list = options(need.key);
        const back =
          list.length > 0 || sub.editing
            ? () => setSub(sub.extra ? { view: "extra", need: need.key } : { view: "choose" })
            : undefined;
        return (
          <div className="setup-flow__body">
            <h3>{sub.editing ? `Votre compte ${need.label}` : `Connecter un compte ${need.label}`}</h3>
            <Text tone="muted">
              {sub.extra
                ? `Il aura son propre onglet dans « ${page.entry.label} ».`
                : `Pour la page « ${page.entry.label} ».`}
            </Text>
            {wizard(page, need, sub, back)}
          </div>
        );
      }
    }
    if (sub.view === "another" || sub.view === "extra") {
      const need = page.needs.find((item) => item.key === sub.need);
      if (need && sub.view === "another")
        return (
          <div className="setup-flow__body">
            <h3>Vous avez un autre compte {need.label} ?</h3>
            <Text>
              Chaque compte peut avoir son onglet dans « {page.entry.label} » : par exemple Prod et Recette, côte à
              côte.
            </Text>
            <div className="setup-flow__inline-actions">
              <Button onPress={() => setSub({ view: "extra", need: need.key })}>
                Ajouter un onglet pour un autre compte
              </Button>
            </div>
          </div>
        );
      if (need) {
        const used = new Set(need.tabs.map((tab) => tab.accounts?.[need.need]).filter(Boolean));
        const first = currentOption(need, options(need.key));
        const list = options(need.key).filter((option) => !used.has(option.value) && option.value !== first?.value);
        const stuck = `${shown}|${need.key}|onglet`;
        if (list.length === 0 || sticky.current === stuck) {
          sticky.current = stuck;
          return wizardScreen(page, need);
        }
        return (
          <div className="setup-flow__body">
            <h3>Quel autre compte {need.label} ?</h3>
            <Text tone="muted">Il aura son propre onglet dans « {page.entry.label} ».</Text>
            {cards(
              need,
              list,
              undefined,
              (option) => void pick(page, need, option, true),
              () => setSub({ view: "wizard", need: need.key, extra: true }),
            )}
          </div>
        );
      }
    }
    const several = page.needs.length > 1;
    const [only] = page.needs;
    // Aucun compte du bon type dans l’espace : l’assistant s’ouvre tout de suite.
    const stuck = only ? `${shown}|${only.key}|` : undefined;
    if (!several && only && (options(only.key).length === 0 || sticky.current === stuck)) {
      sticky.current = stuck;
      return wizardScreen(page, only);
    }
    const others = page.entry.pages.filter((tab) =>
      page.needs.some((need) => tab.accounts?.[need.need] && !primaryTabs(need).includes(tab)),
    );
    return (
      <div className="setup-flow__body">
        <h3>
          {several || !only
            ? `À quels comptes se connecter pour « ${page.entry.label} » ?`
            : `À quel compte ${only.label} se connecter pour « ${page.entry.label} » ?`}
        </h3>
        <Text tone="muted">Choisissez un compte déjà connecté, ou connectez-en un nouveau.</Text>
        {page.needs.map((need) => {
          const list = options(need.key);
          return (
            <div key={need.key} className="setup-flow__question">
              {several ? (
                <h4>
                  Compte {need.label}
                  {need.optional ? <span className="setup-flow__optional"> (facultatif)</span> : null}
                </h4>
              ) : null}
              {cards(
                need,
                list,
                currentOption(need, list),
                (option) => void pick(page, need, option),
                () => setSub({ view: "wizard", need: need.key }),
              )}
            </div>
          );
        })}
        {others.length > 0 ? (
          <Text size="meta" tone="muted">
            Autres onglets de cette page : {others.map((tab) => tab.title).join(", ")}.
          </Text>
        ) : null}
      </div>
    );
  };

  function wizardScreen(page: PagePlan, need: NeedPlan) {
    const extra = sub.view === "extra";
    return (
      <div className="setup-flow__body">
        <h3>{extra ? `Connecter un autre compte ${need.label}` : `Connecter votre compte ${need.label}`}</h3>
        <Text tone="muted">
          {extra ? `Il aura son propre onglet dans « ${page.entry.label} ».` : `Pour la page « ${page.entry.label} ».`}
        </Text>
        {wizard(
          page,
          need,
          { view: "wizard", need: need.key, extra },
          extra ? () => setSub({ view: "choose" }) : undefined,
        )}
      </div>
    );
  }

  /** Un compte dont aucune page n’a besoin : seulement le choisir ou le connecter, et le vérifier. */
  const orphanView = (key: string, label: string) => {
    const need: NeedPlan = {
      key,
      module: key.split("/")[0] ?? "",
      need: key.split("/")[1] ?? key,
      label,
      optional: false,
      tabs: [],
      followed: false,
    };
    const list = options(key);
    const stuck = `${shown}|${key}|`;
    if (list.length === 0) sticky.current = stuck;
    if (sub.view === "wizard" || sticky.current === stuck)
      return (
        <div className="setup-flow__body">
          <h3>Connecter votre compte {label}</h3>
          <Text tone="muted">{setup.name} s’en sert pour travailler à votre place.</Text>
          {wizard(
            undefined,
            need,
            sub.view === "wizard" ? sub : { view: "wizard", need: key },
            list.length > 0 ? () => setSub({ view: "choose" }) : undefined,
          )}
        </div>
      );
    return (
      <div className="setup-flow__body">
        <h3>Quel compte {label} utiliser ?</h3>
        <Text tone="muted">{setup.name} s’en sert pour travailler à votre place.</Text>
        {cards(
          need,
          list,
          list.find((option) => !option.shared && option.instance.default),
          (option) => void pick(undefined, undefined, option),
          () => setSub({ view: "wizard", need: key }),
        )}
      </div>
    );
  };

  const entries = entriesOf(snapshot, setup.module);
  const open = plans.filter((candidate) => !pageDone(candidate, snapshot, overview));
  const done = (
    <div className="setup-flow__body">
      <h3>{open.length === 0 ? "C’est prêt" : "Presque prêt"}</h3>
      <Text>
        {entries.length === 0
          ? `${setup.name} n’a ajouté aucune page à votre menu.`
          : "Voici votre menu, avec ses nouvelles pages :"}
      </Text>
      {entries.length > 0 ? (
        <MenuPreview snapshot={snapshot} highlighted={new Set(entries.map((entry) => entry.id))} />
      ) : null}
      {open.length > 0 ? (
        <Text tone="muted">
          Il reste un compte à choisir pour{" "}
          {open.map((candidate, position) => (
            <span key={candidate.entry.id}>
              {position > 0 ? ", " : ""}
              <Link onPress={() => go(pageStep(candidate.entry.id))}>{candidate.entry.label}</Link>
            </span>
          ))}
          . Ces pages vous le rappelleront.
        </Text>
      ) : null}
    </div>
  );

  // Pied de l’étape : un seul bouton principal.
  const pageReady = plan ? pageDone(plan, snapshot, overview) : false;
  const firstEntry = entries.find((entry) => !entry.hidden) ?? entries[0];
  let footer: React.ReactNode;
  if (shown === INTRO) {
    footer = (
      <Button variant="primary" onPress={next}>
        Commencer
      </Button>
    );
  } else if (shown === PAGES) {
    const chosen = drafts?.filter((draft) => draft.checked).length ?? 0;
    footer = (
      <Button variant="primary" isPending={applying} onPress={() => void applyPages()}>
        {chosen === 0 ? "Continuer sans page" : "Continuer"}
      </Button>
    );
  } else if (shown === DONE) {
    footer = firstEntry ? (
      <>
        <Button onPress={onClose}>Fermer</Button>
        <Button variant="primary" onPress={() => onOpenSection(firstEntry.id)}>
          {`Ouvrir « ${firstEntry.label} »`}
        </Button>
      </>
    ) : (
      <Button variant="primary" onPress={onClose}>
        Terminer
      </Button>
    );
  } else if (plan && sub.view === "another") {
    footer = (
      <Button variant="primary" onPress={next}>
        Non, c’est tout
      </Button>
    );
  } else if (plan && sub.view !== "choose") {
    footer = null;
  } else if (orphan && sub.view !== "choose") {
    footer = null;
  } else {
    const ready = plan ? pageReady : orphan ? orphan.state === "ready" : true;
    footer = (
      <Button
        variant={ready ? "primary" : "secondary"}
        onPress={() => {
          const main = plan ? mainNeed(plan) : undefined;
          // Le premier compte de la page est là : avant de passer, une autre question.
          if (
            plan &&
            main &&
            ready &&
            !asked.current.has(plan.entry.id) &&
            !ownClient(overview, main.key)?.simple &&
            needDone(main, options(main.key))
          ) {
            asked.current.add(plan.entry.id);
            setSub({ view: "another", need: main.key });
          } else next();
        }}
      >
        {ready ? "Continuer" : "Passer pour l’instant"}
      </Button>
    );
  }

  return (
    <div className="setup-flow">
      {header}
      <div className="setup-flow__layout">
        <aside className="setup-flow__steps">{stepper}</aside>
        <section
          className="setup-flow__main"
          aria-label={
            shown === INTRO
              ? "Présentation"
              : shown === PAGES
                ? "Vos pages"
                : shown === DONE
                  ? "Terminé"
                  : (plan?.entry.label ?? orphan?.label ?? "")
          }
        >
          {shown === INTRO
            ? intro
            : shown === PAGES
              ? pagesStep
              : shown === DONE
                ? done
                : plan
                  ? pageView(plan)
                  : orphan
                    ? orphanView(orphan.key, orphan.label)
                    : null}
          {footer !== null ? (
            <div className="setup-flow__footer">
              {index > 0 && !(plan && sub.view !== "choose") ? <Button onPress={previous}>Précédent</Button> : null}
              <span className="setup-flow__spacer" />
              {footer}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** « Quelles pages voulez-vous ? » : une carte par page, à cocher, à renommer, ou à doubler. */
function PagesChoice({
  drafts,
  onChange,
  disabled,
}: {
  drafts: PageDraft[];
  onChange: (drafts: PageDraft[]) => void;
  disabled: boolean;
}) {
  const [renaming, setRenaming] = useState<string>();
  const update = (key: string, change: Partial<PageDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  /** Une carte de plus pour le même modèle, cochée, avec un nom libre (« Jira 2 »). */
  const addCopy = (model: PageDraft) => {
    const own = drafts.filter((draft) => draft.section.id === model.section.id);
    const after = drafts.indexOf(own.at(-1) ?? model) + 1;
    onChange([
      ...drafts.slice(0, after),
      {
        key: `${model.section.id}#${drafts.length}`,
        section: model.section,
        templates: model.templates,
        label: own.some((draft) => draft.checked || draft.entry)
          ? nextLabel(
              model.section.label,
              drafts.map((draft) => draft.label),
            )
          : model.section.label,
        checked: true,
      },
      ...drafts.slice(after),
    ]);
  };
  return (
    <div className="setup-flow__body">
      <h3>Quelles pages voulez-vous ?</h3>
      <Text tone="muted">Elles iront dans le menu de gauche. Vous pourrez en changer plus tard.</Text>
      <ul className="setup-pages" aria-label="Pages proposées">
        {drafts.map((draft) => {
          const description = draft.templates[0]?.description;
          const tabs =
            draft.templates.length > 1 ? `Onglets : ${draft.templates.map((item) => item.title).join(", ")}` : "";
          return (
            <li key={draft.key} className={`setup-page${draft.checked ? " is-checked" : ""}`}>
              <label className="setup-page__check">
                <input
                  type="checkbox"
                  checked={draft.checked}
                  disabled={disabled}
                  aria-label={`Garder la page ${draft.label}`}
                  onChange={(event) => update(draft.key, { checked: event.target.checked })}
                />
              </label>
              <span className="setup-page__icon" aria-hidden="true">
                {draft.section.icon || draft.section.iconUrl ? (
                  <SectionIcon section={draft.section} size={18} />
                ) : (
                  <NamedIcon name="boxes" size={18} />
                )}
              </span>
              <span className="setup-page__text">
                {renaming === draft.key ? (
                  <TextField
                    label={`Nom de la page ${draft.section.label}`}
                    hideLabel
                    value={draft.label}
                    autoFocus
                    autoComplete="off"
                    onChange={(value) => update(draft.key, { label: value })}
                    onBlur={() => setRenaming(undefined)}
                  />
                ) : (
                  <span className="setup-page__name">
                    <strong>{draft.label || draft.section.label}</strong>
                    <IconButton
                      label={`Renommer la page ${draft.label}`}
                      icon={<Pencil size={14} aria-hidden="true" />}
                      isDisabled={disabled}
                      onPress={() => setRenaming(draft.key)}
                    />
                  </span>
                )}
                {description ? <small>{description}</small> : null}
                {tabs ? <small>{tabs}</small> : null}
              </span>
              {drafts.filter((other) => other.section.id === draft.section.id).at(-1)?.key === draft.key ? (
                <Button
                  size="sm"
                  icon={<Plus size={14} aria-hidden="true" />}
                  isDisabled={disabled}
                  aria-label={`Une autre page « ${draft.section.label} »`}
                  onPress={() => addCopy(draft)}
                >
                  Une autre
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Le menu de gauche tel qu’il sera, les pages du module en évidence avec leurs onglets. */
function MenuPreview({ snapshot, highlighted }: { snapshot: Snapshot; highlighted: Set<string> }) {
  const visible = snapshot.sections.filter((section) => !section.hidden || highlighted.has(section.id));
  return (
    <ul className="setup-menu" aria-label="Aperçu du menu">
      {visible.map((section: ResolvedSection) => {
        const mine = highlighted.has(section.id);
        return (
          <li key={section.id} className={mine ? "is-new" : undefined}>
            <span className="setup-menu__row">
              <span className="setup-menu__icon" aria-hidden="true">
                {section.icon || section.iconUrl ? <SectionIcon section={section} size={15} /> : <Boxes size={15} />}
              </span>
              {section.label}
              {mine ? <span className="setup-menu__new">Nouveau</span> : null}
            </span>
            {mine && section.pages.length > 1 ? (
              <ul>
                {section.pages.map((page) => (
                  <li key={page.reference}>{page.title}</li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
