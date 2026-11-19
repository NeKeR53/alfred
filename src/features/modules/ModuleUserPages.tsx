/**
 * « Pages », dans la fiche d’un module (Réglages → Modules) : les pages de l’utilisateur qui viennent de ce module,
 * une ligne chacune, avec ses onglets en retrait, et sur chaque onglet le compte choisi pour chacun de ses besoins.
 * Le module fournit les modèles ; l’utilisateur ajoute des pages et des onglets à partir d’eux (le même modèle autant
 * de fois qu’il veut, avec d’autres comptes), les range au glisser, les renomme, change leurs comptes et les retire
 * depuis leur menu « ⋯ ». Un compte se choisit parmi tous ceux de l’espace qui sont du bon type, quel que soit le
 * module qui les a créés ; rien n’est deviné quand il y en a plusieurs.
 */
import {
  Button,
  FormField,
  MenuItem,
  Modal,
  OverflowMenu,
  RadioControl,
  SelectControl,
  SettingRow,
  SettingRows,
  Stack,
  Text,
  TextInput,
} from "@alfred/ui";
import { Boxes } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type {
  ModuleSummary,
  NewTab,
  PageTemplate,
  ResolvedPage,
  ResolvedSection,
  SectionTemplate,
  Snapshot,
} from "../../lib/types";
import { NamedIcon, SectionIcon } from "../../shell/icons";
import { applyLayoutChange, IconDialog, RenameDialog } from "../../shell/navigationEditing";
import { reorderSections, reorderTabs, setPageHidden, setSectionHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { useDragReorder } from "../../shell/useDragReorder";
import type { ClientInstanceItem, ClientItem, ClientNeedItem } from "../clients/api";
import type { ServiceEditing } from "../clients/ServiceEditor";
import { type ClientsController, STATUS } from "../clients/useClients";
import { DragHandle } from "../navigation/NavigationSettings";
import { errorMessage } from "../vault/api";
import { templateOfPage, userPages } from "./menuApi";

/** Clé `module/besoin` d’un besoin (`jira`, ou `autre-module/jira` pour une dépendance). */
export const needKey = (module: string, need: string) => (need.includes("/") ? need : `${module}/${need}`);

const NEW_ACCOUNT = "__nouveau__";

/** Un compte qu’on peut choisir pour un besoin : la valeur enregistrée, et de quoi le reconnaître. */
interface AccountOption {
  /** `instance` pour un compte du service du besoin, `client/instance` pour celui d’un autre service du même type. */
  value: string;
  client: ClientItem;
  instance: ClientInstanceItem;
}

interface Lookup {
  overview: ClientsController["overview"];
  needOf: (module: string, need: string) => ClientNeedItem | undefined;
  clientOf: (module: string, need: string) => ClientItem | undefined;
  helpOf: (module: string, need: string) => string | undefined;
  /** Comptes de l’espace du type voulu par le besoin : ceux de son service, puis ceux des services compatibles. */
  optionsOf: (module: string, need: string) => AccountOption[];
}

function useLookup(services: ClientsController, modules: ModuleSummary[], snapshot: Snapshot): Lookup {
  const overview = services.overview;
  const compatible = snapshot.compatibleClients;
  return useMemo(() => {
    const needOf = (module: string, need: string) =>
      overview?.needs.find((candidate) => candidate.key === needKey(module, need));
    const clientOf = (module: string, need: string) => {
      const found = needOf(module, need);
      return found?.client ? overview?.clients.find((client) => client.id === found.client) : undefined;
    };
    const helpOf = (module: string, need: string) => {
      const found = needOf(module, need);
      return (
        modules.find((candidate) => candidate.id === found?.module)?.clients.find((item) => item.id === found?.id)
          ?.help || undefined
      );
    };
    const optionsOf = (module: string, need: string) => {
      const own = clientOf(module, need);
      const ids = compatible?.[needKey(module, need)] ?? (own ? [own.id] : []);
      return ids.flatMap((id) => {
        const client = overview?.clients.find((candidate) => candidate.id === id);
        if (!client || client.simple) return [];
        return client.instances.map((instance) => ({
          value: client.id === own?.id ? instance.id : `${client.id}/${instance.id}`,
          client,
          instance,
        }));
      });
    };
    return { overview, needOf, clientOf, helpOf, optionsOf };
  }, [overview, modules, compatible]);
}

/** « Prod · Prefect · testé » : le compte, son service et son état. */
function optionLabel({ client, instance }: AccountOption): string {
  const state =
    instance.status === "ready"
      ? instance.lastTest?.ok
        ? "testé"
        : "connecté"
      : (STATUS[instance.status]?.label ?? instance.status).toLowerCase();
  return `${instance.label} · ${client.label} · ${state}`;
}

/** Titre d’une page de l’utilisateur : son icône dans sa couleur, et son nom. */
function EntryTitle({ section }: { section: ResolvedSection }) {
  return (
    <span className={`module-entry module-entry--section product-color--${section.color ?? "steel"}`}>
      <span className="module-entry__icon" aria-hidden="true">
        {section.icon || section.iconUrl ? <SectionIcon section={section} size={16} /> : <Boxes size={16} />}
      </span>
      {section.label}
    </span>
  );
}

function TabTitle({ page }: { page: ResolvedPage }) {
  return (
    <span className="module-entry module-entry--tab">
      {page.icon ? (
        <span className="module-entry__icon" aria-hidden="true">
          <NamedIcon name={page.icon} size={14} />
        </span>
      ) : null}
      {page.title}
    </span>
  );
}

/**
 * Choix d’un compte pour un besoin, parmi tous ceux de l’espace qui sont du bon type. Sans choix : « Choisir un
 * compte… » pour un besoin que la page suit, « Par défaut » sinon. « Ajouter un compte… » reste en bas de la liste.
 */
function AccountPicker({
  options,
  value,
  follows,
  label,
  onChange,
  disabled,
}: {
  options: AccountOption[];
  value: string;
  follows: boolean;
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const fallback = options.find((option) => !option.value.includes("/") && option.instance.default);
  return (
    <SelectControl
      aria-label={label}
      value={value}
      disabled={disabled}
      width="auto"
      onChange={(event) => onChange(event.target.value)}
    >
      {follows ? (
        <option value="" disabled>
          Choisir un compte…
        </option>
      ) : (
        <option value="">{fallback ? `Par défaut (${fallback.instance.label})` : "Par défaut"}</option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {optionLabel(option)}
        </option>
      ))}
      <option value={NEW_ACCOUNT}>Ajouter un compte…</option>
    </SelectControl>
  );
}

/** Besoins d’un modèle qui se choisissent : ceux d’un service à plusieurs comptes possibles. */
function choosableNeeds(template: PageTemplate | undefined, lookup: Lookup) {
  return (template?.needs ?? []).filter((need) => !lookup.clientOf(template?.module ?? "", need)?.simple);
}

/**
 * Ajouter une page (`mode: "page"`) ou un onglet (`mode: "tab"`) : choisir le modèle, le nom, éventuellement
 * l’icône, puis un compte pour chaque besoin, toujours explicitement. « Ajouter un compte… » en crée un qui devient
 * celui de l’onglet.
 */
function AddDialog({
  mode,
  module,
  snapshot,
  lookup,
  target,
  onClose,
  onNewAccount,
}: {
  mode: "page" | "tab";
  module: ModuleSummary;
  snapshot: Snapshot;
  lookup: Lookup;
  /** Pour un onglet : la page qui le reçoit. */
  target?: ResolvedSection;
  onClose: () => void;
  /** Un compte à créer pour un besoin de l’onglet créé (sa référence). */
  onNewAccount: (tab: string, module: string, need: string, accounts: Record<string, string>) => void;
}) {
  const templates = (snapshot.templates ?? []).filter((template) => template.module === module.id);
  const sections = (snapshot.sectionTemplates ?? []).filter((section) =>
    templates.some((template) => template.section === section.id),
  );
  /** Choix proposés : une section entière (tous ses modèles), ou un seul modèle. */
  const choices = useMemo(() => {
    const list: Array<{
      key: string;
      section: SectionTemplate;
      templates: PageTemplate[];
      label: string;
      hint?: string;
    }> = [];
    for (const section of sections) {
      const own = section.pages
        .map((reference) => templates.find((template) => template.reference === reference))
        .filter((template): template is PageTemplate => Boolean(template));
      if (mode === "page" && own.length > 0) {
        list.push({
          key: `section:${section.id}`,
          section,
          templates: own,
          label: section.label,
          hint: own.length > 1 ? `Onglets : ${own.map((template) => template.title).join(", ")}` : undefined,
        });
      }
      if (mode === "tab" || own.length > 1) {
        for (const template of own)
          list.push({
            key: `page:${template.reference}`,
            section,
            templates: [template],
            label: mode === "page" ? `${section.label} — ${template.title} seule` : template.title,
            hint: template.description || undefined,
          });
      }
    }
    return list;
  }, [mode, sections, templates]);
  const [choice, setChoice] = useState(choices[0]?.key ?? "");
  const chosen = choices.find((candidate) => candidate.key === choice);
  const needs = [...new Set((chosen?.templates ?? []).flatMap((template) => choosableNeeds(template, lookup)))];
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const follows = (need: string) => Boolean(chosen?.templates.some((template) => template.perInstance === need));
  /** Un besoin attend un choix tant qu’on n’a rien choisi : « Par défaut » est un choix, pas l’absence de choix. */
  const missing = needs.filter(
    (need) => lookup.clientOf(module.id, need) && (follows(need) ? !accounts[need] : !(need in accounts)),
  );
  const accountLabel = (need: string) =>
    lookup.optionsOf(module.id, need).find((option) => option.value === accounts[need])?.instance.label;
  // Nom proposé : celui du modèle ; s’il existe déjà au menu, avec le compte choisi.
  const baseName = mode === "page" ? (chosen?.section.label ?? "") : (chosen?.templates[0]?.title ?? "");
  const taken =
    mode === "page"
      ? snapshot.sections.some((section) => section.label === baseName)
      : Boolean(target?.pages.some((page) => page.title === baseName));
  const firstAccount = needs.map(accountLabel).find(Boolean);
  const suggested = taken && firstAccount ? `${baseName} ${firstAccount}` : baseName;
  const [name, setName] = useState<string>();
  const [icon, setIcon] = useState("");
  const [pending, setPending] = useState(false);
  const shownName = name ?? suggested;

  const confirm = async () => {
    if (!chosen || missing.length > 0) return;
    const fresh = needs.filter((need) => accounts[need] === NEW_ACCOUNT);
    const chosenAccounts: Record<string, string> = {};
    for (const need of needs) {
      const value = accounts[need];
      if (value && value !== NEW_ACCOUNT) chosenAccounts[need] = value;
    }
    const tabs: NewTab[] = chosen.templates.map((template) => ({
      page: template.reference,
      ...(mode === "tab" ? { label: shownName.trim() || undefined } : {}),
      accounts: Object.fromEntries(Object.entries(chosenAccounts).filter(([need]) => template.needs.includes(need))),
    }));
    setPending(true);
    try {
      let created: string | undefined;
      if (mode === "page") {
        const id = await userPages.addPage(chosen.section.id, tabs, shownName.trim() || undefined, icon.trim());
        created = firstTabOf(id);
      } else if (target) {
        created = await userPages.addTab(target.id, tabs[0]);
      }
      notify({
        title: mode === "page" ? `Page « ${shownName} » ajoutée au menu` : `Onglet « ${shownName} » ajouté`,
        tone: "success",
      });
      onClose();
      if (created && fresh[0]) onNewAccount(created, module.id, fresh[0], chosenAccounts);
    } catch (failure) {
      notify({
        title: mode === "page" ? "La page n’a pas été ajoutée" : "L’onglet n’a pas été ajouté",
        description: errorMessage(failure),
        tone: "error",
      });
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={pending}
      title={mode === "page" ? `Ajouter une page ${module.name}` : `Ajouter un onglet à « ${target?.label ?? ""} »`}
      description={
        mode === "page"
          ? "Choisissez le modèle, son nom et ses comptes. Le même modèle peut servir plusieurs fois, avec d’autres comptes."
          : "Choisissez le modèle de l’onglet, son nom et ses comptes."
      }
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>
            Annuler
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!chosen || missing.length > 0}
            onClick={() => void confirm()}
          >
            {mode === "page" ? "Ajouter la page" : "Ajouter l’onglet"}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <fieldset className="modules-choice">
          <legend className="modules-choice__legend">Modèle</legend>
          <Stack gap="none">
            {choices.map((candidate) => (
              <RadioControl
                key={candidate.key}
                name="modele"
                label={
                  candidate.hint ? (
                    <span className="modules-choice__option">
                      {candidate.label}
                      <span className="modules-choice__hint">{candidate.hint}</span>
                    </span>
                  ) : (
                    candidate.label
                  )
                }
                checked={choice === candidate.key}
                onChange={() => {
                  setChoice(candidate.key);
                  setName(undefined);
                }}
              />
            ))}
          </Stack>
        </fieldset>
        <FormField label="Nom">
          <TextInput value={shownName} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </FormField>
        {mode === "page" ? (
          <FormField label="Icône" hint="Facultatif : le nom d’une icône Lucide, par exemple flask-conical.">
            <TextInput
              value={icon}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setIcon(event.target.value)}
            />
          </FormField>
        ) : null}
        {needs.map((need) => {
          const label = lookup.needOf(module.id, need)?.label ?? need;
          if (!lookup.clientOf(module.id, need))
            return (
              <Text key={need} size="meta" tone="muted">
                {`Compte ${label} : le service n’est pas encore configuré ; la page attendra un compte.`}
              </Text>
            );
          return (
            <FormField key={need} label={`Compte ${label}`}>
              <AccountPicker
                options={lookup.optionsOf(module.id, need)}
                value={accounts[need] ?? ""}
                follows={follows(need)}
                label={`Compte ${label}`}
                onChange={(value) => setAccounts((current) => ({ ...current, [need]: value }))}
              />
            </FormField>
          );
        })}
      </Stack>
    </Modal>
  );
}

/** Premier onglet d’une page qui vient d’être créée (pour lui donner un compte nouveau) : la vue est déjà à jour. */
function firstTabOf(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return useShell.getState().snapshot?.sections.find((section) => section.id === id)?.pages[0]?.reference;
}

type Dialog =
  | { kind: "add-page" }
  | { kind: "add-tab"; section: ResolvedSection }
  | { kind: "rename"; target: string; initial: string; what: string }
  | { kind: "icon"; section: ResolvedSection };

/** Classes d’une ligne qu’on glisse : celle qu’on déplace, et l’endroit où elle tombera. */
function dragClasses(drag: { draggedId?: string; dropTarget?: { id: string; placement: string } }, id: string) {
  return `sortable-row${drag.draggedId === id ? " is-dragging" : ""}${drag.dropTarget?.id === id ? ` is-drop-${drag.dropTarget.placement}` : ""}`;
}

/** Une entrée de menu « ⋯ » : l’action part dès la capture, le menu se ferme avant la remontée du clic. */
function Item({ label, run, disabled }: { label: string; run: () => void; disabled?: boolean }) {
  return (
    <MenuItem disabled={disabled} onClickCapture={run}>
      {label}
    </MenuItem>
  );
}

export function ModuleUserPages({
  module,
  modules,
  snapshot,
  entries,
  services,
  onEdit,
  loading,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  snapshot: Snapshot;
  /** Pages du menu qui viennent du module. */
  entries: ResolvedSection[];
  services: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Module désactivé : ses pages ne s’affichent pas, quel que soit leur réglage. */
  disabled?: boolean;
  /** Comptes pas encore lus (ou illisibles) : ce qui s’affiche à la place des choix de compte. */
  loading?: ReactNode;
}) {
  const lookup = useLookup(services, modules, snapshot);
  const [dialog, setDialog] = useState<Dialog>();
  const templates = snapshot.templates ?? [];
  const templateOf = (page: ResolvedPage) => templates.find((template) => template.reference === templateOfPage(page));
  const offered = templates.some((template) => template.module === module.id);

  const act = async (title: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (failure) {
      notify({ title, description: errorMessage(failure), tone: "error" });
    }
  };
  const newAccount = (tab: string, owner: string, need: string, accounts: Record<string, string>) => {
    const client = lookup.clientOf(owner, need);
    if (client) onEdit({ kind: "account", client, help: lookup.helpOf(owner, need), assign: { tab, need, accounts } });
  };
  const setAccount = (page: ResolvedPage, need: string, value: string) => {
    if (value === NEW_ACCOUNT) {
      newAccount(page.reference, page.module, need, page.accounts ?? {});
      return;
    }
    const accounts = { ...(page.accounts ?? {}) };
    if (value) accounts[need] = value;
    else delete accounts[need];
    void act("Le compte n’a pas été changé", () => userPages.configure(page.reference, { accounts }));
  };

  /** Comptes d’un onglet : un choix par besoin, ou ce qu’il manque. */
  const accountsOf = (page: ResolvedPage) => {
    const template = templateOf(page);
    const needs = choosableNeeds(template, lookup);
    if (needs.length === 0) return null;
    if (loading) return loading;
    return needs.map((need) => {
      const label = lookup.needOf(page.module, need)?.label ?? need;
      const options = lookup.optionsOf(page.module, need);
      if (!lookup.clientOf(page.module, need) && options.length === 0)
        return (
          <Text key={need} size="meta" tone="muted">
            {`${label} : service à configurer, plus bas.`}
          </Text>
        );
      return (
        <AccountPicker
          key={need}
          options={options}
          value={page.accounts?.[need] ?? ""}
          follows={template?.perInstance === need}
          label={`Compte ${label} de ${page.title}`}
          onChange={(value) => setAccount(page, need, value)}
        />
      );
    });
  };

  // Ranger les pages au glisser : elles prennent, dans l’ordre du menu, les places qu’occupaient celles du module.
  const items = useMemo(() => entries.map((section) => ({ id: section.id, section })), [entries]);
  const drag = useDragReorder(items, (order, moved) =>
    applyLayoutChange((current) => {
      const mine = new Set(order);
      const queue = [...order];
      const full = current.sections.map((section) =>
        mine.has(section.id) ? (queue.shift() ?? section.id) : section.id,
      );
      return reorderSections(current, full, moved);
    }),
  );

  return (
    <>
      <ul className="module-pages-list" aria-label={`Pages ${module.name}`}>
        {entries.length === 0 ? (
          <li>
            <Text size="meta" tone="muted">
              Aucune page de ce module dans le menu.
            </Text>
          </li>
        ) : null}
        {drag.orderedItems.map(({ section }, index) => (
          <li
            key={section.id}
            className={dragClasses(drag, section.id)}
            data-sortable-scope={drag.scopeId}
            data-sortable-id={section.id}
          >
            <EntryRows
              section={section}
              module={module}
              first={index === 0}
              last={index === drag.orderedItems.length - 1}
              offered={offered}
              accountsOf={accountsOf}
              onDialog={setDialog}
              act={act}
              handle={
                <DragHandle
                  subject={`la page ${section.label}`}
                  onPointerDown={(event) => {
                    const row = event.currentTarget.closest<HTMLElement>("li");
                    if (row) drag.startDrag(event, section.id, row);
                  }}
                />
              }
            />
          </li>
        ))}
      </ul>
      {offered ? (
        <div className="module-groups__footer">
          <Button variant="secondary" onClick={() => setDialog({ kind: "add-page" })}>
            Ajouter une page
          </Button>
        </div>
      ) : null}
      {dialog?.kind === "add-page" || dialog?.kind === "add-tab" ? (
        <AddDialog
          mode={dialog.kind === "add-page" ? "page" : "tab"}
          module={module}
          snapshot={snapshot}
          lookup={lookup}
          target={dialog.kind === "add-tab" ? dialog.section : undefined}
          onClose={() => setDialog(undefined)}
          onNewAccount={newAccount}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog
          title={`Renommer ${dialog.what} « ${dialog.initial} »`}
          initial={dialog.initial}
          onClose={() => setDialog(undefined)}
          onSubmit={(value) =>
            void act("Le nom n’a pas été changé", () => userPages.configure(dialog.target, { label: value }))
          }
        />
      ) : null}
      {dialog?.kind === "icon" ? (
        <IconDialog
          section={dialog.section.label}
          initial={dialog.section.iconUrl ? "" : (dialog.section.icon ?? "")}
          logo={dialog.section.iconUrl}
          onClose={() => setDialog(undefined)}
          onSubmit={(value) =>
            void act("L’icône n’a pas été changée", () => userPages.configure(dialog.section.id, { icon: value }))
          }
        />
      ) : null}
    </>
  );
}

/** Une page de l’utilisateur : sa ligne, puis ses onglets en retrait, qui se rangent au glisser entre eux. */
function EntryRows({
  section,
  module,
  first,
  last,
  offered,
  accountsOf,
  onDialog,
  act,
  handle,
}: {
  section: ResolvedSection;
  module: ModuleSummary;
  first: boolean;
  last: boolean;
  offered: boolean;
  accountsOf: (page: ResolvedPage) => ReactNode;
  onDialog: (dialog: Dialog) => void;
  act: (title: string, work: () => Promise<unknown>) => Promise<void>;
  handle: ReactNode;
}) {
  const items = useMemo(() => section.pages.map((page) => ({ id: page.reference, page })), [section.pages]);
  const drag = useDragReorder(items, (order, moved) =>
    applyLayoutChange((current) => reorderTabs(current, section.id, order, moved)),
  );
  const removable = !section.pages.some((page) => page.module !== module.id);
  const facts = [
    section.hidden ? "Masquée du menu." : null,
    section.pages.length > 1 ? `${section.pages.length} onglets.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <SettingRows label={`Page ${section.label}`}>
      <SettingRow
        title={
          <span className="module-pages-list__title">
            {handle}
            <EntryTitle section={section} />
          </span>
        }
        description={facts || undefined}
      >
        <OverflowMenu label={`Actions de la page ${section.label}`} size="small">
          <Item
            label="Renommer…"
            run={() => onDialog({ kind: "rename", target: section.id, initial: section.label, what: "la page" })}
          />
          <Item label="Changer l’icône…" run={() => onDialog({ kind: "icon", section })} />
          {offered ? <Item label="Ajouter un onglet…" run={() => onDialog({ kind: "add-tab", section })} /> : null}
          <Item
            label={section.hidden ? "Afficher dans le menu" : "Masquer du menu"}
            run={() => void applyLayoutChange((current) => setSectionHidden(current, section.id, !section.hidden))}
          />
          <Item
            label="Monter"
            disabled={first}
            run={() => void act("La page n’a pas été déplacée", () => userPages.move(section.id, -1))}
          />
          <Item
            label="Descendre"
            disabled={last}
            run={() => void act("La page n’a pas été déplacée", () => userPages.move(section.id, 1))}
          />
          {removable ? (
            <Item
              label="Retirer du menu"
              run={() =>
                void act("La page n’a pas été retirée", async () => {
                  await userPages.remove(section.id);
                  notify({ title: `Page « ${section.label} » retirée du menu`, tone: "success" });
                })
              }
            />
          ) : null}
        </OverflowMenu>
      </SettingRow>
      {drag.orderedItems.map(({ page }, position) => (
        <div
          key={page.reference}
          className={`setting-row--nested ${dragClasses(drag, page.reference)}`}
          data-sortable-scope={drag.scopeId}
          data-sortable-id={page.reference}
        >
          <SettingRow
            title={
              <span className="module-pages-list__title">
                {section.pages.length > 1 ? (
                  <DragHandle
                    subject={`l’onglet ${page.title}`}
                    onPointerDown={(event) => {
                      const row = event.currentTarget.closest<HTMLElement>(".setting-row--nested");
                      if (row) drag.startDrag(event, page.reference, row);
                    }}
                  />
                ) : null}
                <TabTitle page={page} />
              </span>
            }
            description={
              [
                page.hidden ? "Masqué du menu." : null,
                page.panel ? `Avec le panneau « ${page.panel.title} » à droite.` : null,
                page.waiting ?? null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
            {accountsOf(page)}
            <OverflowMenu label={`Actions de l’onglet ${page.title}`} size="small">
              <Item
                label="Renommer…"
                run={() => onDialog({ kind: "rename", target: page.reference, initial: page.title, what: "l’onglet" })}
              />
              <Item
                label={page.hidden ? "Afficher dans le menu" : "Masquer du menu"}
                run={() => void applyLayoutChange((current) => setPageHidden(current, page.reference, !page.hidden))}
              />
              <Item
                label="Monter"
                disabled={position === 0}
                run={() => void act("L’onglet n’a pas été déplacé", () => userPages.move(page.reference, -1))}
              />
              <Item
                label="Descendre"
                disabled={position === section.pages.length - 1}
                run={() => void act("L’onglet n’a pas été déplacé", () => userPages.move(page.reference, 1))}
              />
              {page.module === module.id ? (
                <Item
                  label="Retirer l’onglet"
                  run={() =>
                    void act("L’onglet n’a pas été retiré", async () => {
                      await userPages.remove(page.reference);
                      notify({ title: `Onglet « ${page.title} » retiré`, tone: "success" });
                    })
                  }
                />
              ) : null}
            </OverflowMenu>
          </SettingRow>
        </div>
      ))}
    </SettingRows>
  );
}
