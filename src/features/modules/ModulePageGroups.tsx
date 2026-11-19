/**
 * « Pages », dans la fiche d’un module (Réglages → Modules) : page d’abord, puis ses comptes. Un groupe par entrée du
 * menu, avec son titre, son interrupteur et ses onglets ; dessous, les comptes dont la page se sert, avec de quoi en
 * ajouter, les connecter et les tester. Un compte qui sert à plusieurs pages reste un seul compte : il s’affiche sous
 * chacune, avec la mention des autres. Une page par compte (`perInstance`) ne montre que les comptes qui l’ont ajoutée ;
 * « Ajouter un compte » y fait choisir un compte existant ou en créer un. « Ajouter une page » propose les pages par
 * compte du module, pour un autre compte.
 */
import {
  Button,
  MenuButton,
  MenuItem,
  Modal,
  RadioControl,
  SettingRow,
  SettingRows,
  Stack,
  SwitchControl,
  Text,
} from "@alfred/ui";
import { Boxes } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { NamedIcon, SectionIcon } from "../../shell/icons";
import { applyLayoutChange } from "../../shell/navigationEditing";
import { setPageHidden, setSectionHidden } from "../../shell/navigationLayout";
import { notify } from "../../shell/notifications";
import { type ClientItem, type ClientNeedItem, setAccountPages } from "../clients/api";
import { templateOf } from "../clients/fromTemplate";
import { ServiceBlock } from "../clients/ServiceBlock";
import type { ServiceEditing } from "../clients/ServiceEditor";
import type { ClientsController } from "../clients/useClients";
import { errorMessage } from "../vault/api";
import { listing } from "./ModulePages";
import { accountsWithPage, baseOf, otherGroupsUsing, type PageEntry, type PageGroup } from "./pageGroups";

/** Ajout d’une page par compte : la page, et le service dont elle suit les comptes. */
interface Adding {
  page: PageEntry;
  need: ClientNeedItem;
  client: ClientItem;
}

/** Titre d’un groupe : l’entrée du menu, son icône dans sa couleur ; ou l’endroit où la page est rangée. */
function GroupTitle({ group }: { group: PageGroup }) {
  const { section } = group;
  if (!section) return <span className="module-entry module-entry--section">{group.title}</span>;
  return (
    <span className={`module-entry module-entry--section product-color--${section.color ?? "steel"}`}>
      <span className="module-entry__icon" aria-hidden="true">
        {section.icon ? <SectionIcon section={section} size={16} /> : <Boxes size={16} />}
      </span>
      {group.title}
    </span>
  );
}

function PageTitle({ page }: { page: PageEntry }) {
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

/** Comptes du service qui n’ont pas encore la page. */
function accountsWithout(snapshot: Snapshot, adding: Adding) {
  const chosen = accountsWithPage(snapshot.accounts, adding.client.id, adding.page) ?? new Set<string>();
  return adding.client.instances.filter((instance) => !chosen.has(instance.id));
}

/**
 * Pour quel compte ajouter une page par compte : un compte existant qui ne l’a pas, ou un nouveau compte, créé dans
 * la foulée, qui la reçoit dès sa création.
 */
function AccountChoice({
  adding,
  snapshot,
  onClose,
  onNew,
}: {
  adding: Adding;
  snapshot: Snapshot;
  onClose: () => void;
  onNew: () => void;
}) {
  const free = accountsWithout(snapshot, adding);
  const [choice, setChoice] = useState<string>(free[0]?.id ?? "nouveau");
  const [pending, setPending] = useState(false);
  const label = adding.client.label;
  const confirm = async () => {
    if (choice === "nouveau") {
      onNew();
      return;
    }
    const key = `${adding.client.id}/${choice}`;
    const instance = adding.client.instances.find((candidate) => candidate.id === choice);
    setPending(true);
    try {
      const pages = [...(snapshot.accounts?.[key] ?? []), adding.page.reference];
      await setAccountPages(adding.client.id, choice, pages);
      notify({ title: `Page « ${adding.page.title} » ajoutée pour ${instance?.label ?? choice}`, tone: "success" });
      onClose();
    } catch (failure) {
      notify({ title: "La page n’a pas été ajoutée", description: errorMessage(failure), tone: "error" });
      setPending(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={pending}
      title={`Ajouter « ${adding.page.title} » pour un compte`}
      description={`La page existe pour chaque compte ${label} : choisissez celui qu’elle montrera.`}
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>
            Annuler
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void confirm()}>
            {choice === "nouveau" ? "Continuer" : "Ajouter"}
          </Button>
        </>
      }
    >
      <fieldset className="modules-choice">
        <legend className="visually-hidden">Compte {label}</legend>
        <Stack gap="none">
          {free.map((instance) => (
            <RadioControl
              key={instance.id}
              name="compte"
              label={instance.label}
              checked={choice === instance.id}
              onChange={() => setChoice(instance.id)}
            />
          ))}
          <RadioControl
            name="compte"
            label={`Un nouveau compte ${label}…`}
            checked={choice === "nouveau"}
            onChange={() => setChoice("nouveau")}
          />
        </Stack>
      </fieldset>
    </Modal>
  );
}

export function ModulePageGroups({
  module,
  modules,
  snapshot,
  groups,
  services,
  onEdit,
  disabled,
  loading,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  snapshot: Snapshot;
  groups: PageGroup[];
  services: ClientsController;
  onEdit: (editing: ServiceEditing) => void;
  /** Module désactivé : ses pages ne s’affichent pas, quel que soit leur interrupteur. */
  disabled: boolean;
  /** Comptes pas encore lus (ou illisibles) : ce qui s’affiche à leur place sous chaque page. */
  loading?: ReactNode;
}) {
  const [adding, setAdding] = useState<Adding>();
  const overview = services.overview;
  const needOf = (key: string) => overview?.needs.find((need) => need.key === key);
  const clientOf = (need: ClientNeedItem | undefined) =>
    need?.client ? overview?.clients.find((client) => client.id === need.client) : undefined;
  const helpOf = (need: ClientNeedItem) =>
    modules.find((candidate) => candidate.id === need.module)?.clients.find((item) => item.id === need.id)?.help ||
    undefined;

  /** Page par compte : ajoute-la à un compte (choisi, ou créé s’il n’y en a aucun). */
  const addFor = (page: PageEntry) => {
    const need = page.perInstance ? needOf(page.perInstance) : undefined;
    const client = clientOf(need);
    if (!need || !client) return;
    if (client.instances.length === 0) {
      onEdit({ kind: "account", client, help: helpOf(need), page: page.reference });
      return;
    }
    setAdding({ page, need, client });
  };
  const addTo = async (page: PageEntry, client: ClientItem, instance: string, name: string) => {
    const key = `${client.id}/${instance}`;
    try {
      await setAccountPages(client.id, instance, [...(snapshot.accounts?.[key] ?? []), page.reference]);
      notify({ title: `Page « ${page.title} » ajoutée pour ${name}`, tone: "success" });
    } catch (failure) {
      notify({ title: "La page n’a pas été ajoutée", description: errorMessage(failure), tone: "error" });
    }
  };
  const removeFrom = async (page: PageEntry, client: ClientItem, instance: string, name: string) => {
    const key = `${client.id}/${instance}`;
    try {
      await setAccountPages(
        client.id,
        instance,
        (snapshot.accounts?.[key] ?? []).filter((reference) => reference !== page.reference),
      );
      notify({ title: `Page « ${page.title} » retirée pour ${name}`, tone: "success" });
    } catch (failure) {
      notify({ title: "La page n’a pas été retirée", description: errorMessage(failure), tone: "error" });
    }
  };

  /** Interrupteur à droite d’une ligne : le titre de la ligne est son libellé. */
  const toggle = (label: string, checked: boolean, off: boolean, onChange: (shown: boolean) => void) => (
    <SwitchControl
      label=""
      aria-label={`Afficher ${label} dans le menu`}
      checked={checked}
      disabled={off}
      onChange={(event) => onChange(event.target.checked)}
    />
  );

  /** Où le compte apparaît, pour une page par compte : son entrée ou son onglet. */
  const placeOf = (group: PageGroup, instance: string) => {
    if (group.instancesAs === "tabs") {
      const tabs = (group.section ? snapshot.sections.filter((section) => section.id === group.section?.id) : [])
        .flatMap((section) => section.pages)
        .filter((page) => page.instance === instance)
        .map((page) => `« ${page.title} »`);
      if (tabs.length > 0) return `${tabs.length > 1 ? "Onglets" : "Onglet"} ${listing(tabs)} dans « ${group.title} »`;
    }
    const copy = snapshot.sections.find(
      (section) =>
        section.module === module.id &&
        section.instance === instance &&
        (section.instanceOf ?? baseOf(section.id)) === group.key,
    );
    return copy ? `Entrée « ${copy.label} » dans le menu` : undefined;
  };

  /** Comptes d’un besoin sous une page : tous ses comptes, ou ceux qui ont ajouté la page par compte. */
  const accounts = (group: PageGroup, needKey: string, page?: PageEntry) => {
    const need = needOf(needKey);
    if (!need) return null;
    const client = clientOf(need);
    const shared = otherGroupsUsing(groups, needKey, group.key).map((other) => `« ${other.title} »`);
    const several = group.pages.filter((candidate) => candidate.perInstance === needKey).length > 1;
    const chosen = page && client ? accountsWithPage(snapshot.accounts, client.id, page) : null;
    const purpose = [
      page
        ? group.instancesAs === "tabs"
          ? `Un onglet par compte : ajoutez un compte pour qu’il ait sa page.`
          : `Une entrée du menu par compte : ajoutez un compte pour qu’il ait sa page.`
        : null,
      shared.length > 0
        ? `Le même compte sert aussi ${shared.length > 1 ? "aux pages" : "à la page"} ${listing(shared)}.`
        : null,
      need.module !== module.id ? `Service de ${need.moduleName}, installé avec ce module.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <ServiceBlock
        key={`${needKey}:${page?.reference ?? ""}`}
        need={need}
        client={client}
        template={templateOf(modules, need.module, need.id)}
        help={helpOf(need)}
        controller={services}
        onEdit={(editing) => onEdit(page && !editing.instance ? { ...editing, page: page.reference } : editing)}
        titled
        heading={several && page ? `Comptes ${need.label} — ${page.title}` : `Compte ${need.label}`}
        purpose={purpose || undefined}
        describeInstance={
          page
            ? (instance) =>
                chosen?.has(instance) ? placeOf(group, instance) : `N’a pas encore la page « ${page.title} ».`
            : undefined
        }
        rowButton={
          page && client
            ? (instance) =>
                chosen?.has(instance.id) ? null : (
                  <Button
                    variant="secondary"
                    aria-label={`Ajouter la page ${page.title} à ${instance.label}`}
                    onClick={() => void addTo(page, client, instance.id, instance.label)}
                  >
                    Ajouter la page
                  </Button>
                )
            : undefined
        }
        rowActions={
          page && client
            ? (instance) =>
                chosen?.has(instance.id)
                  ? [
                      {
                        label: "Retirer de cette page",
                        run: () => void removeFrom(page, client, instance.id, instance.label),
                      },
                    ]
                  : []
            : undefined
        }
      />
    );
  };

  /** Pages par compte du module, à ajouter pour un autre compte. */
  const offered = groups.flatMap((group) =>
    group.pages.filter((page) => page.perInstance && (clientOf(needOf(page.perInstance))?.instances.length ?? 0) > 0),
  );

  return (
    <>
      <div className="module-groups">
        {groups.map((group) => {
          const { section } = group;
          const only = group.pages.length === 1 ? group.pages[0] : undefined;
          const describe = (page: PageEntry | undefined) =>
            [
              group.place
                ? group.place === "Réglages"
                  ? "Dans les Réglages."
                  : `Onglet dans « ${group.place} ».`
                : null,
              page && page.title !== group.title && !group.place ? `Page « ${page.title} ».` : null,
              page?.panel ? `Avec le panneau « ${page.panel.title} » à droite.` : null,
              group.pages.length > 1 ? `${group.pages.length} onglets.` : null,
              section?.waiting && group.pages.every((candidate) => !candidate.needs.length) ? section.waiting : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined;
          // Les comptes : une fois par besoin commun à la page, puis une fois par page qui existe pour chaque compte.
          const common = group.needs.filter((need) => !group.pages.some((page) => page.perInstance === need));
          const perAccount = group.pages.filter((page) => page.perInstance);
          return (
            <section key={group.key} className="module-group" aria-label={`Page ${group.title}`}>
              <SettingRows label={`Page ${group.title}`}>
                {section ? (
                  <SettingRow title={<GroupTitle group={group} />} description={describe(only)}>
                    {toggle(group.title, !section.hidden && !(only?.hidden ?? false), disabled, (shown) => {
                      void applyLayoutChange((current) => setSectionHidden(current, section.id, !shown));
                      if (shown && only?.hidden)
                        void applyLayoutChange((current) => setPageHidden(current, only.layoutReference, false));
                    })}
                  </SettingRow>
                ) : null}
                {group.pages.length > 1 || !section
                  ? group.pages.map((page) => (
                      <div key={page.reference} className={section ? "setting-row--nested" : undefined}>
                        <SettingRow
                          title={section ? <PageTitle page={page} /> : <PageTitle page={page} />}
                          description={
                            !section
                              ? describe(page)
                              : page.panel
                                ? `Avec le panneau « ${page.panel.title} » à droite.`
                                : undefined
                          }
                        >
                          {toggle(
                            page.title,
                            !page.hidden,
                            disabled || Boolean(section?.hidden),
                            (shown) =>
                              void applyLayoutChange((current) => setPageHidden(current, page.layoutReference, !shown)),
                          )}
                        </SettingRow>
                      </div>
                    ))
                  : null}
              </SettingRows>
              {loading && group.needs.length > 0 ? (
                <div className="module-group__accounts">{loading}</div>
              ) : common.length > 0 || perAccount.length > 0 ? (
                <div className="module-group__accounts">
                  {common.map((need) => accounts(group, need))}
                  {perAccount.map((page) => (page.perInstance ? accounts(group, page.perInstance, page) : null))}
                </div>
              ) : groups.some((other) => other.needs.length > 0) ? (
                // Seulement quand d’autres pages du module en ont : sinon, la phrase se répéterait pour rien.
                <Text size="meta" tone="muted">
                  N’a besoin d’aucun compte.
                </Text>
              ) : null}
            </section>
          );
        })}
      </div>
      {offered.length > 0 ? (
        <div className="module-groups__footer">
          <MenuButton label="Ajouter une page" variant="secondary">
            {offered.map((page) => (
              <MenuItem key={page.reference} onClickCapture={() => addFor(page)}>
                {`${page.title} pour un autre compte…`}
              </MenuItem>
            ))}
          </MenuButton>
        </div>
      ) : null}
      {adding ? (
        <AccountChoice
          adding={adding}
          snapshot={snapshot}
          onClose={() => setAdding(undefined)}
          onNew={() => {
            const { client, need, page } = adding;
            setAdding(undefined);
            onEdit({ kind: "account", client, help: helpOf(need), page: page.reference });
          }}
        />
      ) : null}
    </>
  );
}
