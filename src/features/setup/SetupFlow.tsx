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
import { Boxes, Plus } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  InlineEdit,
  Link,
  List,
  Modal,
  PageSection,
  ProgressBar,
  ProgressIndicator,
  RadioButtonGroup,
  useConfirm,
} from "socle-ui";
import { Row, Stack, Text } from "../../kit";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { SectionIcon } from "../../shell/icons";
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

/** Compte choisi qui n’est pas prêt : ce qu’il lui manque, et le geste qui le termine (comme un nouveau clic). */
const PENDING_ACTION: Partial<Record<AccountState, { text: string; action: string }>> = {
  untested: { text: "Ce compte n’a pas encore été vérifié.", action: "Vérifier" },
  failed: { text: "La vérification de ce compte a échoué.", action: "Vérifier" },
  approve: { text: "Ce compte attend votre accord avant de servir.", action: "Autoriser" },
  secret: { text: "Il manque le mot de passe de ce compte.", action: "Compléter" },
  connect: { text: "Ce compte doit être reconnecté.", action: "Reconnecter" },
  invalid: { text: "Ce compte est à corriger.", action: "Compléter" },
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
  title,
  setup,
  modules,
  services,
  start,
  step: wanted,
  onClose,
  onOpenSection,
}: {
  /** Titre de la modale : « Configurer … ». */
  title: string;
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

  /** La modale du parcours : les étapes et l’étape en cours, puis le pied (« Terminer plus tard », l’action). */
  const frame = (body: ReactNode, footer?: ReactNode, description?: string) => (
    <Modal
      isOpen
      size="lg"
      title={title}
      description={description}
      footer={footer}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {body}
    </Modal>
  );

  // Les comptes illisibles n’empêchent pas de présenter le module ni de choisir ses pages.
  if (!setup || !snapshot || !flow || !current || (overview === undefined && !services.error))
    return frame(<ProgressBar label="Chargement de la configuration" />);

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

  /** Sous le titre de la modale : où l’on en est. */
  const description =
    shown === INTRO
      ? "Quelques minutes suffisent. Vous pouvez vous arrêter et reprendre plus tard."
      : `Étape ${index + 1} sur ${ids.length}`;

  const stepper = (
    <ProgressIndicator
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
    />
  );

  /**
   * Choix d’un compte : un bouton radio par compte du bon type (son adresse, son état), puis « Connecter un nouveau
   * compte ». Un compte en échec, ou choisi mais pas prêt, a son encart sous le groupe.
   */
  const cards = (
    need: Pick<NeedPlan, "key" | "label" | "optional">,
    list: AccountOption[],
    selected: AccountOption | undefined,
    onPick: (option: AccountOption) => void,
    onNew: () => void,
    several = false,
  ) => {
    const rows = list.map((option) => {
      const key = keyOf(option);
      const state = accountState(option.instance);
      // Un échec d’avant la reprise se lit dans le dernier test du compte.
      const failure =
        failures[key] ??
        (state === "failed" && option.instance.lastTest
          ? { reason: reasonOf(option.instance.lastTest.message), message: option.instance.lastTest.message }
          : undefined);
      const badge = checking === key ? "Je vérifie…" : CARD_STATE[state].label;
      const name =
        option.instance.label || (option.client.simple ? `Votre compte ${option.client.label}` : option.instance.id);
      const detail = [
        hostOf(option.instance.effectiveUrl),
        option.shared ? `déjà utilisé par ${option.client.label}` : "",
        badge,
      ]
        .filter(Boolean)
        .join(" · ");
      return { option, key, state, failure, name, detail };
    });
    const selectedKey = selected ? keyOf(selected) : null;
    const chosen = rows.find((row) => row.key === selectedKey);
    const pending = chosen && !chosen.failure && checking !== chosen.key ? PENDING_ACTION[chosen.state] : undefined;
    return (
      <Stack gap="sm">
        <RadioButtonGroup
          label={`Compte ${need.label}`}
          hideLabel={!several}
          isRequired={!need.optional}
          value={selectedKey}
          isDisabled={checking !== undefined}
          onChange={(value) => {
            const row = rows.find((candidate) => candidate.key === value);
            if (row) onPick(row.option);
          }}
        >
          {rows.map((row) => (
            <RadioButtonGroup.Option key={row.key} value={row.key} description={row.detail}>
              {row.name}
            </RadioButtonGroup.Option>
          ))}
        </RadioButtonGroup>
        {rows
          .filter((row) => row.failure && checking !== row.key)
          .map((row) => (
            <Alert
              key={row.key}
              tone="danger"
              title={row.name}
              action={{
                label: "Modifier ce compte",
                onPress: () => setSub({ view: "wizard", need: need.key, editing: row.option }),
              }}
            >
              {failureText(
                row.failure?.reason,
                row.option.instance.authType ?? undefined,
                hostOf(row.option.instance.effectiveUrl),
                row.failure?.message ?? "",
              )}
            </Alert>
          ))}
        {chosen && pending ? (
          <Alert
            tone="warning"
            title={chosen.name}
            action={{ label: pending.action, onPress: () => onPick(chosen.option) }}
          >
            {pending.text}
          </Alert>
        ) : null}
        <Row>
          <Button
            icon={<Plus size={16} aria-hidden="true" />}
            isDisabled={checking !== undefined}
            aria-label={several ? `Connecter un nouveau compte ${need.label}` : undefined}
            onPress={onNew}
          >
            Connecter un nouveau compte
          </Button>
        </Row>
      </Stack>
    );
  };

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
    <PageSection title={setup.name}>
      <Stack>
        <Text>{setup.welcome || setup.description || `${setup.name} ajoute ses pages à votre menu.`}</Text>
        {flow.pages ? (
          <>
            <Text tone="muted">Vous aurez ces pages dans le menu de gauche :</Text>
            <List
              label="Aperçu des pages"
              selectionMode="none"
              leading="icon"
              items={sectionChoices(snapshot, setup.module).map(({ section, templates }) => ({
                id: section.id,
                title: section.label,
                subtitle: templates[0]?.description || undefined,
                visual: sectionVisual(section, 16),
              }))}
            />
          </>
        ) : null}
      </Stack>
    </PageSection>
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
          <PageSection
            title={sub.editing ? `Votre compte ${need.label}` : `Connecter un compte ${need.label}`}
            description={
              sub.extra
                ? `Il aura son propre onglet dans « ${page.entry.label} ».`
                : `Pour la page « ${page.entry.label} ».`
            }
          >
            {wizard(page, need, sub, back)}
          </PageSection>
        );
      }
    }
    if (sub.view === "another" || sub.view === "extra") {
      const need = page.needs.find((item) => item.key === sub.need);
      if (need && sub.view === "another")
        return (
          <PageSection
            title={`Vous avez un autre compte ${need.label} ?`}
            description={`Chaque compte peut avoir son onglet dans « ${page.entry.label} » : par exemple Prod et Recette, côte à côte.`}
          >
            <Row>
              <Button onPress={() => setSub({ view: "extra", need: need.key })}>
                Ajouter un onglet pour un autre compte
              </Button>
            </Row>
          </PageSection>
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
          <PageSection
            title={`Quel autre compte ${need.label} ?`}
            description={`Il aura son propre onglet dans « ${page.entry.label} ».`}
          >
            {cards(
              need,
              list,
              undefined,
              (option) => void pick(page, need, option, true),
              () => setSub({ view: "wizard", need: need.key, extra: true }),
            )}
          </PageSection>
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
      <PageSection
        title={
          several || !only
            ? `À quels comptes se connecter pour « ${page.entry.label} » ?`
            : `À quel compte ${only.label} se connecter pour « ${page.entry.label} » ?`
        }
        description="Choisissez un compte déjà connecté, ou connectez-en un nouveau."
      >
        <Stack gap="lg">
          {page.needs.map((need) => {
            const list = options(need.key);
            return (
              <Fragment key={need.key}>
                {cards(
                  need,
                  list,
                  currentOption(need, list),
                  (option) => void pick(page, need, option),
                  () => setSub({ view: "wizard", need: need.key }),
                  several,
                )}
              </Fragment>
            );
          })}
          {others.length > 0 ? (
            <Text size="meta" tone="muted">
              Autres onglets de cette page : {others.map((tab) => tab.title).join(", ")}.
            </Text>
          ) : null}
        </Stack>
      </PageSection>
    );
  };

  function wizardScreen(page: PagePlan, need: NeedPlan) {
    const extra = sub.view === "extra";
    return (
      <PageSection
        title={extra ? `Connecter un autre compte ${need.label}` : `Connecter votre compte ${need.label}`}
        description={
          extra ? `Il aura son propre onglet dans « ${page.entry.label} ».` : `Pour la page « ${page.entry.label} ».`
        }
      >
        {wizard(
          page,
          need,
          { view: "wizard", need: need.key, extra },
          extra ? () => setSub({ view: "choose" }) : undefined,
        )}
      </PageSection>
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
    const purpose = `${setup.name} s’en sert pour travailler à votre place.`;
    if (sub.view === "wizard" || sticky.current === stuck)
      return (
        <PageSection title={`Connecter votre compte ${label}`} description={purpose}>
          {wizard(
            undefined,
            need,
            sub.view === "wizard" ? sub : { view: "wizard", need: key },
            list.length > 0 ? () => setSub({ view: "choose" }) : undefined,
          )}
        </PageSection>
      );
    return (
      <PageSection title={`Quel compte ${label} utiliser ?`} description={purpose}>
        {cards(
          need,
          list,
          list.find((option) => !option.shared && option.instance.default),
          (option) => void pick(undefined, undefined, option),
          () => setSub({ view: "wizard", need: key }),
        )}
      </PageSection>
    );
  };

  const entries = entriesOf(snapshot, setup.module);
  const open = plans.filter((candidate) => !pageDone(candidate, snapshot, overview));
  const done = (
    <PageSection
      title={open.length === 0 ? "C’est prêt" : "Presque prêt"}
      description={
        entries.length === 0
          ? `${setup.name} n’a ajouté aucune page à votre menu.`
          : "Voici votre menu, avec ses nouvelles pages :"
      }
    >
      <Stack>
        {open.length > 0 ? (
          <Alert tone="warning" title="Il reste un compte à choisir">
            Pour{" "}
            {open.map((candidate, position) => (
              <Fragment key={candidate.entry.id}>
                {position > 0 ? ", " : ""}
                <Link onPress={() => go(pageStep(candidate.entry.id))}>{candidate.entry.label}</Link>
              </Fragment>
            ))}
            . Ces pages vous le rappelleront.
          </Alert>
        ) : null}
        {entries.length > 0 ? (
          <MenuPreview snapshot={snapshot} highlighted={new Set(entries.map((entry) => entry.id))} />
        ) : null}
      </Stack>
    </PageSection>
  );

  // Pied de l’étape : un seul bouton principal.
  const pageReady = plan ? pageDone(plan, snapshot, overview) : false;
  const firstEntry = entries.find((entry) => !entry.hidden) ?? entries[0];
  let action: React.ReactNode;
  if (shown === INTRO) {
    action = (
      <Button variant="primary" onPress={next}>
        Commencer
      </Button>
    );
  } else if (shown === PAGES) {
    const chosen = drafts?.filter((draft) => draft.checked).length ?? 0;
    action = (
      <Button variant="primary" isPending={applying} onPress={() => void applyPages()}>
        {chosen === 0 ? "Continuer sans page" : "Continuer"}
      </Button>
    );
  } else if (shown === DONE) {
    action = firstEntry ? (
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
    action = (
      <Button variant="primary" onPress={next}>
        Non, c’est tout
      </Button>
    );
  } else if ((plan || orphan) && sub.view !== "choose") {
    // L’assistant d’un compte a ses propres boutons.
    action = null;
  } else {
    const ready = plan ? pageReady : orphan ? orphan.state === "ready" : true;
    action = (
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

  return frame(
    <Stack gap="lg">
      {stepper}
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
    </Stack>,
    <>
      <Button variant="subtle" onPress={onClose}>
        Terminer plus tard
      </Button>
      {action !== null && index > 0 && !(plan && sub.view !== "choose") ? (
        <Button onPress={previous}>Précédent</Button>
      ) : null}
      {action}
    </>,
    description,
  );
}

/** Icône d’une page du menu, pour un aperçu. */
function sectionVisual(section: { icon?: string | null; iconUrl?: string | null }, size: number) {
  return section.icon || section.iconUrl ? <SectionIcon section={section} size={size} /> : <Boxes size={size} />;
}

/** « Quelles pages voulez-vous ? » : une case par page, puis leurs noms, à changer ou à doubler. */
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
  /** Une page de plus pour le même modèle, cochée, avec un nom libre (« Jira 2 »). */
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
  const kept = drafts.filter((draft) => draft.checked);
  return (
    <Stack gap="lg">
      <PageSection
        title="Quelles pages voulez-vous ?"
        description="Elles iront dans le menu de gauche. Vous pourrez en changer plus tard."
      >
        <CheckboxGroup
          label="Pages proposées"
          hideLabel
          isDisabled={disabled}
          value={kept.map((draft) => draft.key)}
          onChange={(keys) => onChange(drafts.map((draft) => ({ ...draft, checked: keys.includes(draft.key) })))}
        >
          {drafts.map((draft) => {
            const description = [
              draft.templates[0]?.description,
              draft.templates.length > 1 ? `Onglets : ${draft.templates.map((item) => item.title).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Checkbox key={draft.key} value={draft.key} description={description || undefined}>
                {draft.label || draft.section.label}
              </Checkbox>
            );
          })}
        </CheckboxGroup>
      </PageSection>
      {kept.length > 0 ? (
        <PageSection title="Noms dans le menu" description="Renommez une page, ou ajoutez-en une autre du même modèle.">
          <Stack gap="sm">
            {kept.map((draft) => (
              <Row key={draft.key} wrap>
                <InlineEdit
                  label={`Nom de la page ${draft.section.label}`}
                  value={draft.label}
                  isRequired
                  isDisabled={disabled}
                  isEditing={renaming === draft.key}
                  onEditingChange={(editing) => setRenaming(editing ? draft.key : undefined)}
                  onSave={(label) => update(draft.key, { label })}
                />
                <Button
                  size="sm"
                  variant="subtle"
                  isDisabled={disabled}
                  aria-label={`Renommer la page ${draft.label}`}
                  onPress={() => setRenaming(draft.key)}
                >
                  Renommer
                </Button>
                {kept.filter((other) => other.section.id === draft.section.id).at(-1)?.key === draft.key ? (
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
              </Row>
            ))}
          </Stack>
        </PageSection>
      ) : null}
    </Stack>
  );
}

/** Le menu de gauche tel qu’il sera, les pages du module marquées « Nouveau », avec leurs onglets. */
function MenuPreview({ snapshot, highlighted }: { snapshot: Snapshot; highlighted: Set<string> }) {
  const visible = snapshot.sections.filter((section) => !section.hidden || highlighted.has(section.id));
  return (
    <List
      label="Aperçu du menu"
      selectionMode="none"
      leading="icon"
      items={visible.map((section) => {
        const mine = highlighted.has(section.id);
        return {
          id: section.id,
          title: section.label,
          subtitle: mine && section.pages.length > 1 ? section.pages.map((page) => page.title).join(", ") : undefined,
          status: mine ? { label: "Nouveau", tone: "info" as const } : undefined,
          visual: sectionVisual(section, 16),
        };
      })}
    />
  );
}
