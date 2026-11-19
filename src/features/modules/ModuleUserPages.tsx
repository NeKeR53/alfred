/**
 * « Pages », dans la fiche d’un module (Réglages → Modules) : les pages de l’utilisateur qui viennent de ce module,
 * chacune avec ses onglets, et sous chaque onglet le compte choisi pour chacun de ses besoins. Le module fournit les
 * modèles ; l’utilisateur ajoute des pages et des onglets à partir d’eux (le même modèle autant de fois qu’il veut,
 * avec d’autres comptes), les renomme, change leurs comptes, les range et les retire.
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
  SwitchControl,
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
import { setPageHidden, setSectionHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { ClientItem, ClientNeedItem } from "../clients/api";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { errorMessage } from "../vault/api";
import { templateOfPage, userPages } from "./menuApi";

/** Clé `module/besoin` d’un besoin (`jira`, ou `autre-module/jira` pour une dépendance). */
export const needKey = (module: string, need: string) => (need.includes("/") ? need : `${module}/${need}`);

const NEW_ACCOUNT = "__nouveau__";

interface Lookup {
  overview: ClientsController["overview"];
  needOf: (module: string, need: string) => ClientNeedItem | undefined;
  clientOf: (module: string, need: string) => ClientItem | undefined;
  helpOf: (module: string, need: string) => string | undefined;
}

function useLookup(services: ClientsController, modules: ModuleSummary[]): Lookup {
  const overview = services.overview;
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
    return { overview, needOf, clientOf, helpOf };
  }, [overview, modules]);
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
 * Choix d’un compte pour un besoin. Un besoin dont la page montre un compte (`perInstance`) en a toujours un ; les
 * autres peuvent garder « Par défaut ». « Nouveau compte… » ouvre l’ajout d’un compte, qui sera celui choisi.
 */
function AccountPicker({
  client,
  value,
  follows,
  label,
  onChange,
  disabled,
}: {
  client: ClientItem;
  value: string;
  follows: boolean;
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const fallback = client.instances.find((instance) => instance.default) ?? client.instances[0];
  return (
    <SelectControl
      aria-label={label}
      value={value || (follows ? (fallback?.id ?? "") : "")}
      disabled={disabled}
      width="auto"
      onChange={(event) => onChange(event.target.value)}
    >
      {follows || client.instances.length === 0 ? null : (
        <option value="">{fallback ? `Par défaut (${fallback.label})` : "Par défaut"}</option>
      )}
      {client.instances.map((instance) => (
        <option key={instance.id} value={instance.id}>
          {instance.label}
        </option>
      ))}
      <option value={NEW_ACCOUNT}>Nouveau compte…</option>
    </SelectControl>
  );
}

/** Besoins d’un modèle qui se choisissent : ceux dont le service a plusieurs comptes possibles. */
function choosableNeeds(template: PageTemplate | undefined, lookup: Lookup) {
  return (template?.needs ?? []).filter((need) => {
    const client = lookup.clientOf(template?.module ?? "", need);
    return !client?.simple;
  });
}

/**
 * Ajouter une page (`mode: "page"`) ou un onglet (`mode: "tab"`) : choisir le modèle, le nom, éventuellement
 * l’icône, puis un compte pour chaque besoin. Un besoin sans compte peut en recevoir un nouveau dans la foulée.
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
  const accountOf = (need: string) => {
    if (need in accounts) return accounts[need];
    const client = lookup.clientOf(module.id, need);
    const follows = chosen?.templates.some((template) => template.perInstance === need);
    return follows
      ? (client?.instances.find((instance) => instance.default)?.id ?? client?.instances[0]?.id ?? "")
      : "";
  };
  const accountLabel = (need: string) =>
    lookup.clientOf(module.id, need)?.instances.find((instance) => instance.id === accountOf(need))?.label;
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
    if (!chosen) return;
    const fresh = needs.filter((need) => accountOf(need) === NEW_ACCOUNT);
    const chosenAccounts: Record<string, string> = {};
    for (const need of needs) {
      const value = accountOf(need);
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
          <Button variant="primary" loading={pending} disabled={!chosen} onClick={() => void confirm()}>
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
          const client = lookup.clientOf(module.id, need);
          const label = lookup.needOf(module.id, need)?.label ?? need;
          if (!client)
            return (
              <Text key={need} size="meta" tone="muted">
                {`Compte ${label} : le service n’est pas encore configuré ; la page attendra un compte.`}
              </Text>
            );
          const follows = Boolean(chosen?.templates.some((template) => template.perInstance === need));
          return (
            <FormField key={need} label={`Compte ${label}`}>
              <AccountPicker
                client={client}
                value={accountOf(need)}
                follows={follows}
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

export function ModuleUserPages({
  module,
  modules,
  snapshot,
  entries,
  services,
  onEdit,
  disabled,
  loading,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  snapshot: Snapshot;
  /** Pages du menu qui viennent du module. */
  entries: ResolvedSection[];
  services: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Module désactivé : ses pages ne s’affichent pas, quel que soit leur interrupteur. */
  disabled: boolean;
  /** Comptes pas encore lus (ou illisibles) : ce qui s’affiche à la place des choix de compte. */
  loading?: ReactNode;
}) {
  const lookup = useLookup(services, modules);
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
      const client = lookup.clientOf(page.module, need);
      const label = lookup.needOf(page.module, need)?.label ?? need;
      if (!client)
        return (
          <Text key={need} size="meta" tone="muted">
            {`${label} : service à configurer, plus bas.`}
          </Text>
        );
      if (client.instances.length === 0)
        return (
          <Button
            key={need}
            variant="secondary"
            aria-label={`Ajouter un compte ${label} pour ${page.title}`}
            onClick={() => newAccount(page.reference, page.module, need, page.accounts ?? {})}
          >
            {`Ajouter un compte ${label}`}
          </Button>
        );
      return (
        <AccountPicker
          key={need}
          client={client}
          value={page.accounts?.[need] ?? ""}
          follows={template?.perInstance === need}
          label={`Compte ${label} de ${page.title}`}
          disabled={disabled}
          onChange={(value) => setAccount(page, need, value)}
        />
      );
    });
  };

  const toggle = (label: string, checked: boolean, off: boolean, onChange: (shown: boolean) => void) => (
    <SwitchControl
      label=""
      aria-label={`Afficher ${label} dans le menu`}
      checked={checked}
      disabled={off}
      onChange={(event) => onChange(event.target.checked)}
    />
  );

  return (
    <>
      <div className="module-groups">
        {entries.length === 0 ? (
          <Text size="meta" tone="muted">
            Aucune page de ce module dans le menu.
          </Text>
        ) : null}
        {entries.map((section, index) => {
          const removable = !section.pages.some((page) => page.module !== module.id);
          return (
            <section key={section.id} className="module-group" aria-label={`Page ${section.label}`}>
              <SettingRows label={`Page ${section.label}`}>
                <SettingRow
                  title={<EntryTitle section={section} />}
                  description={
                    section.pages.length > 1
                      ? `${section.pages.length} onglets.`
                      : section.pages.length === 0
                        ? "Aucun onglet."
                        : undefined
                  }
                >
                  {toggle(section.label, !section.hidden, disabled, (shown) => {
                    void applyLayoutChange((current) => setSectionHidden(current, section.id, !shown));
                  })}
                  <OverflowMenu label={`Actions de la page ${section.label}`} size="small">
                    <MenuItem
                      onClickCapture={() =>
                        setDialog({ kind: "rename", target: section.id, initial: section.label, what: "la page" })
                      }
                    >
                      Renommer…
                    </MenuItem>
                    <MenuItem onClickCapture={() => setDialog({ kind: "icon", section })}>Changer l’icône…</MenuItem>
                    {offered ? (
                      <MenuItem onClickCapture={() => setDialog({ kind: "add-tab", section })}>
                        Ajouter un onglet…
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      disabled={index === 0}
                      onClickCapture={() =>
                        void act("La page n’a pas été déplacée", () => userPages.move(section.id, -1))
                      }
                    >
                      Monter
                    </MenuItem>
                    <MenuItem
                      disabled={index === entries.length - 1}
                      onClickCapture={() =>
                        void act("La page n’a pas été déplacée", () => userPages.move(section.id, 1))
                      }
                    >
                      Descendre
                    </MenuItem>
                    {removable ? (
                      <MenuItem
                        onClickCapture={() =>
                          void act("La page n’a pas été retirée", async () => {
                            await userPages.remove(section.id);
                            notify({ title: `Page « ${section.label} » retirée du menu`, tone: "success" });
                          })
                        }
                      >
                        Retirer du menu
                      </MenuItem>
                    ) : null}
                  </OverflowMenu>
                </SettingRow>
                {section.pages.map((page, position) => (
                  <div key={page.reference} className="setting-row--nested">
                    <SettingRow
                      title={<TabTitle page={page} />}
                      description={
                        [page.panel ? `Avec le panneau « ${page.panel.title} » à droite.` : null, page.waiting ?? null]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                    >
                      {accountsOf(page)}
                      {toggle(page.title, !page.hidden, disabled || section.hidden, (shown) => {
                        void applyLayoutChange((current) => setPageHidden(current, page.reference, !shown));
                      })}
                      <OverflowMenu label={`Actions de l’onglet ${page.title}`} size="small">
                        <MenuItem
                          onClickCapture={() =>
                            setDialog({ kind: "rename", target: page.reference, initial: page.title, what: "l’onglet" })
                          }
                        >
                          Renommer…
                        </MenuItem>
                        <MenuItem
                          disabled={position === 0}
                          onClickCapture={() =>
                            void act("L’onglet n’a pas été déplacé", () => userPages.move(page.reference, -1))
                          }
                        >
                          Monter
                        </MenuItem>
                        <MenuItem
                          disabled={position === section.pages.length - 1}
                          onClickCapture={() =>
                            void act("L’onglet n’a pas été déplacé", () => userPages.move(page.reference, 1))
                          }
                        >
                          Descendre
                        </MenuItem>
                        {page.module === module.id ? (
                          <MenuItem
                            onClickCapture={() =>
                              void act("L’onglet n’a pas été retiré", async () => {
                                await userPages.remove(page.reference);
                                notify({ title: `Onglet « ${page.title} » retiré`, tone: "success" });
                              })
                            }
                          >
                            Retirer l’onglet
                          </MenuItem>
                        ) : null}
                      </OverflowMenu>
                    </SettingRow>
                  </div>
                ))}
              </SettingRows>
            </section>
          );
        })}
      </div>
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
