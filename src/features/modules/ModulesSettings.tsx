import {
  Button,
  EmptyState,
  FeedbackBanner,
  FormControlGroup,
  FormField,
  MenuItem,
  OverflowMenu,
  Page,
  RefreshButton,
  Section,
  SelectControl,
  Spinner,
  StatusBadge,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModuleSummary } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import {
  type CatalogModule,
  catalogAccesses,
  errorMessage,
  type Marketplace,
  type ModuleUpdate,
  marketplaceApi,
} from "./api";
import { InstallDialog, PublishDialog, UninstallDialog, UpdateDialog } from "./dialogs";
import { MergeDialog, modulePages, SplitDialog } from "./reorganize";
import { countPendingUpdates, useModuleUpdatesStore } from "./useModuleUpdates";
import "./modules.css";

export { useModuleUpdates } from "./useModuleUpdates";

const NO_MODULES: ModuleSummary[] = [];

type Opened =
  | { kind: "update"; module: string }
  | { kind: "uninstall"; module: ModuleSummary }
  | { kind: "publish"; module: ModuleSummary }
  | { kind: "install"; module: CatalogModule }
  | { kind: "merge"; module: ModuleSummary }
  | { kind: "split"; module: ModuleSummary };

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function checkedAt(iso: string | null) {
  if (!iso) return "Jamais vérifié";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Jamais vérifié";
  return `Vérifié le ${date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
}

/** D’où vient un module : créé ici, installé (et depuis où), ou détaché de son marketplace. */
function originLabel(module: ModuleSummary, update: ModuleUpdate | undefined) {
  if (!module.origin) return "Local";
  if (module.origin.detached) return `Détaché de ${module.origin.marketplace} (v${module.origin.version})`;
  return `Installé depuis ${update?.marketplaceName ?? module.origin.marketplace}`;
}

/**
 * Entrée de menu dont l’action part dès la phase de capture. `OverflowMenu` ferme le menu pendant cette phase, et
 * dans une vraie fenêtre React le démonte avant la remontée du clic : un `onClick` ordinaire n’est alors jamais
 * appelé (les tests jsdom ne le voient pas, le clic y étant simulé d’un seul tenant).
 */
function MenuAction({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return <MenuItem onClickCapture={onSelect}>{children}</MenuItem>;
}

/** Onglet « Modules » des Réglages : modules de l’espace, marketplaces branchés, catalogue. */
export function ModulesSettings() {
  const modules = useShell((state) => state.snapshot?.modules) ?? NO_MODULES;
  const refreshSpace = useShell((state) => state.refresh);
  const updates = useModuleUpdatesStore((state) => state.updates);
  const checking = useModuleUpdatesStore((state) => state.checking);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);

  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogModule[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /** Opération en cours, pour désactiver ce qui la doublerait : `add`, `all`, `refresh:<id>`, `module:<id>`. */
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const addErrorId = useId();

  const updateOf = useMemo(() => new Map(updates.map((update) => [update.module, update])), [updates]);
  const pending = countPendingUpdates(updates);
  const current = marketplaces?.find((marketplace) => marketplace.id === selected) ?? marketplaces?.[0] ?? null;
  const currentId = current?.id ?? null;

  const loadMarketplaces = useCallback(async () => {
    try {
      setMarketplaces(await marketplaceApi.list());
    } catch (failure) {
      setMarketplaces([]);
      notify({ title: "Marketplaces illisibles", description: errorMessage(failure), tone: "error" });
    }
  }, []);

  const catalogRequest = useRef(0);
  const loadCatalog = useCallback(async (id: string | null) => {
    const request = ++catalogRequest.current;
    if (!id) {
      setCatalog(null);
      setCatalogError(null);
      return;
    }
    try {
      const entries = await marketplaceApi.modules(id);
      if (request !== catalogRequest.current) return;
      setCatalog(entries);
      setCatalogError(null);
    } catch (failure) {
      if (request !== catalogRequest.current) return;
      setCatalog([]);
      setCatalogError(errorMessage(failure));
    }
  }, []);

  /** Interroge les marketplaces distants, puis relit ce qui en dépend. */
  const checkNow = useCallback(async () => {
    try {
      await loadUpdates(true);
    } catch (failure) {
      notify({ title: "Vérification des mises à jour impossible", description: errorMessage(failure), tone: "error" });
    }
    await loadMarketplaces();
  }, [loadMarketplaces, loadUpdates]);

  // À l’ouverture : l’état connu s’affiche tout de suite, la vérification réseau suit.
  useEffect(() => {
    void (async () => {
      await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
      await checkNow();
    })();
  }, [checkNow, loadMarketplaces, loadUpdates]);

  // Le catalogue suit le marketplace choisi, et se relit quand les modules de l’espace ou le clone changent.
  const catalogKey = `${currentId ?? ""}|${current?.lastChecked ?? ""}|${modules.map((module) => `${module.id}@${module.origin?.version ?? ""}`).join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalogKey` résume ce qui périme le catalogue affiché.
  useEffect(() => {
    void loadCatalog(currentId);
  }, [catalogKey, currentId, loadCatalog]);

  /** Après une opération qui change l’espace : la navigation et l’état des modules se relisent sans attendre. */
  const afterSpaceChange = async () => {
    await Promise.all([refreshSpace().catch(() => undefined), loadUpdates(false).catch(() => undefined)]);
  };

  const run = async (key: string, action: () => Promise<void>, failureTitle: string) => {
    setBusy(key);
    try {
      await action();
    } catch (failure) {
      notify({ title: failureTitle, description: errorMessage(failure), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const updateAll = () =>
    run(
      "all",
      async () => {
        const result = await marketplaceApi.updateAll();
        await afterSpaceChange();
        if (result.updated.length > 0) {
          notify({
            title: `${plural(result.updated.length, "module")} mis à jour`,
            description: result.updated.map((entry) => `${entry.name} v${entry.to}`).join(", "),
            tone: "success",
          });
        }
        for (const failure of result.failed) {
          notify({ title: `Mise à jour de ${failure.name} impossible`, description: failure.message, tone: "error" });
        }
        if (result.updated.length === 0 && result.failed.length === 0) notify({ title: "Tout est déjà à jour" });
      },
      "Mise à jour impossible",
    );

  const togglePin = (module: ModuleSummary, pinned: boolean) =>
    run(
      `module:${module.id}`,
      async () => {
        await marketplaceApi.pin(module.id, pinned);
        await afterSpaceChange();
        notify({
          title: pinned ? `${module.name} figé sur la v${module.version}` : `${module.name} libéré`,
          description: pinned
            ? "Ses mises à jour restent signalées, mais « Tout mettre à jour » le laisse de côté."
            : "« Tout mettre à jour » le prend de nouveau en compte.",
          tone: "success",
        });
      },
      "Changement impossible",
    );

  const detach = async (module: ModuleSummary) => {
    const accepted = await confirm({
      title: `Détacher ${module.name} ?`,
      message:
        "Le module devient local et modifiable. Il garde la trace de son origine, mais ne recevra plus aucune mise à jour de son marketplace.",
      confirmLabel: "Détacher",
    });
    if (!accepted) return;
    await run(
      `module:${module.id}`,
      async () => {
        await marketplaceApi.detach(module.id);
        await afterSpaceChange();
        notify({ title: `${module.name} détaché`, description: "Il est maintenant modifiable.", tone: "success" });
      },
      "Détachement impossible",
    );
  };

  const addMarketplace = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy("add");
    setAddError(null);
    try {
      const added = await marketplaceApi.add(url.trim());
      setUrl("");
      setSelected(added.id);
      await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
      notify({ title: `Marketplace ${added.name} branché`, tone: "success" });
    } catch (failure) {
      setAddError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const removeMarketplace = async (marketplace: Marketplace) => {
    const installed = updates.filter((update) => update.marketplace === marketplace.id).length;
    const accepted = await confirm({
      title: `Retirer ${marketplace.name} ?`,
      message:
        installed > 0
          ? `${plural(installed, "module installé", "modules installés")} depuis ce marketplace ${installed > 1 ? "restent" : "reste"} dans l’espace, sans source : plus de mise à jour tant qu’il n’est pas rebranché.`
          : "Son catalogue ne sera plus proposé. Aucun module de l’espace n’en dépend.",
      confirmLabel: "Retirer",
      tone: "danger",
    });
    if (!accepted) return;
    await run(
      `refresh:${marketplace.id}`,
      async () => {
        await marketplaceApi.remove(marketplace.id);
        await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
        notify({ title: `Marketplace ${marketplace.name} retiré` });
      },
      "Retrait impossible",
    );
  };

  const refreshMarketplace = (marketplace: Marketplace) =>
    run(
      `refresh:${marketplace.id}`,
      async () => {
        try {
          await marketplaceApi.refresh(marketplace.id);
        } finally {
          // L’échec aussi s’inscrit sur le marketplace : la liste doit le montrer.
          await Promise.all([loadMarketplaces(), loadUpdates(false).catch(() => undefined)]);
        }
        notify({ title: `${marketplace.name} est à jour`, tone: "success" });
      },
      `Rafraîchissement de ${marketplace.name} impossible`,
    );

  const openedUpdate = opened?.kind === "update" ? updateOf.get(opened.module) : undefined;

  return (
    <Page>
      <Section
        title="Modules de l’espace"
        description="Ce que contient l’espace : les modules créés ici et ceux installés depuis un marketplace, en lecture seule."
        actions={
          <>
            {checking ? <Spinner label="Vérification des mises à jour" /> : null}
            <RefreshButton label="Vérifier les mises à jour" disabled={checking} onClick={() => void checkNow()} />
            {pending > 0 ? (
              <Button
                variant="primary"
                loading={busy === "all"}
                disabled={busy !== null}
                onClick={() => void updateAll()}
              >
                Tout mettre à jour ({pending})
              </Button>
            ) : null}
          </>
        }
      >
        {modules.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucun module"
            description="Demander une page à l’agent crée un module local. Un module partagé s’installe depuis le catalogue, plus bas."
          />
        ) : (
          <ul className="modules-list" aria-label="Modules de l’espace">
            {modules.map((module) => {
              const update = updateOf.get(module.id);
              const installed = module.origin !== null && !module.origin.detached;
              const working = busy === `module:${module.id}`;
              return (
                <li key={module.id}>
                  <div className="modules-list__main">
                    <div className="modules-list__title">
                      <span>{module.name}</span>
                      <span className="modules-list__version">v{module.version}</span>
                      {update?.available ? (
                        <StatusBadge tone="warning" size="compact">
                          Mise à jour disponible : v{update.available}
                        </StatusBadge>
                      ) : null}
                      {update?.pinned ? <StatusBadge size="compact">Figé</StatusBadge> : null}
                      {update?.locallyModified ? (
                        <StatusBadge
                          tone="warning"
                          size="compact"
                          title="Le dossier du module diffère de ce qui a été installé."
                        >
                          Modifié sur place
                        </StatusBadge>
                      ) : null}
                      {update?.sourceMissing ? (
                        <StatusBadge tone="danger" size="compact" title={`Marketplace d’origine : ${update.source}`}>
                          Sans source
                        </StatusBadge>
                      ) : null}
                      {update?.withdrawn ? (
                        <StatusBadge tone="danger" size="compact">
                          Retiré du marketplace
                        </StatusBadge>
                      ) : null}
                    </div>
                    <p className="modules-list__meta">
                      {originLabel(module, update)} · {plural(module.pages, "page")} ·{" "}
                      {plural(module.functions, "fonction")}
                      {installed ? " · lecture seule" : ""}
                    </p>
                    {update?.sourceMissing ? (
                      <p className="modules-list__meta">
                        Son marketplace ({update.source}) n’est plus branché : le rebrancher pour recevoir les mises à
                        jour, ou détacher le module.
                      </p>
                    ) : null}
                  </div>
                  <div className="modules-list__actions">
                    {update?.available ? (
                      <Button disabled={busy !== null} onClick={() => setOpened({ kind: "update", module: module.id })}>
                        Mettre à jour
                      </Button>
                    ) : null}
                    {working ? <Spinner label={`Opération en cours sur ${module.name}`} /> : null}
                    <OverflowMenu label={`Actions du module ${module.name}`} disabled={busy !== null}>
                      {installed ? (
                        <>
                          <MenuAction onSelect={() => void togglePin(module, !module.origin?.pinned)}>
                            {module.origin?.pinned ? "Libérer" : "Figer sur cette version"}
                          </MenuAction>
                          <MenuAction onSelect={() => void detach(module)}>Détacher…</MenuAction>
                        </>
                      ) : (
                        <>
                          <MenuAction onSelect={() => setOpened({ kind: "publish", module })}>Publier…</MenuAction>
                          <MenuAction onSelect={() => setOpened({ kind: "merge", module })}>Fusionner avec…</MenuAction>
                          <MenuAction onSelect={() => setOpened({ kind: "split", module })}>Scinder…</MenuAction>
                        </>
                      )}
                      <MenuAction onSelect={() => setOpened({ kind: "uninstall", module })}>
                        {installed ? "Désinstaller…" : "Supprimer…"}
                      </MenuAction>
                    </OverflowMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Marketplaces"
        description="Dépôts git qui partagent des modules. Alfred y accède avec les identifiants git déjà configurés sur ce poste."
      >
        <form onSubmit={addMarketplace}>
          <FormControlGroup>
            <FormField label="Adresse git du marketplace">
              <TextInput
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setAddError(null);
                }}
                placeholder="git@exemple.fr:equipe/modules.git"
                spellCheck={false}
                autoCapitalize="off"
                disabled={busy === "add"}
                aria-invalid={addError ? true : undefined}
                aria-describedby={addError ? addErrorId : undefined}
              />
            </FormField>
            <Button
              type="submit"
              loading={busy === "add"}
              loadingLabel="Clonage…"
              disabled={!url.trim() || busy !== null}
            >
              Brancher
            </Button>
          </FormControlGroup>
          {/* Sous le groupe entier : le bouton reste aligné sur le champ quand le message apparaît. */}
          {addError ? (
            <p id={addErrorId} role="alert" className="modules-list__meta modules-list__meta--danger modules-add-error">
              {addError}
            </p>
          ) : null}
        </form>
        {marketplaces === null ? (
          <Spinner label="Chargement des marketplaces" />
        ) : marketplaces.length === 0 ? (
          <EmptyState
            size="compact"
            title="Aucun marketplace branché"
            description="Brancher le dépôt git d’une équipe pour installer ses modules ou y publier les vôtres."
          />
        ) : (
          <ul className="modules-list" aria-label="Marketplaces branchés">
            {marketplaces.map((marketplace) => (
              <li key={marketplace.id}>
                <div className="modules-list__main">
                  <div className="modules-list__title">
                    <span>{marketplace.name}</span>
                    {marketplace.error ? (
                      <StatusBadge tone="danger" size="compact">
                        Inaccessible
                      </StatusBadge>
                    ) : null}
                  </div>
                  <p className="modules-list__meta">
                    {marketplace.url} · {checkedAt(marketplace.lastChecked)}
                  </p>
                  {marketplace.error ? (
                    <p className="modules-list__meta modules-list__meta--danger">{marketplace.error}</p>
                  ) : null}
                </div>
                <div className="modules-list__actions">
                  <RefreshButton
                    label={`Rafraîchir ${marketplace.name}`}
                    loading={busy === `refresh:${marketplace.id}`}
                    disabled={busy !== null}
                    onClick={() => void refreshMarketplace(marketplace)}
                  />
                  <Button disabled={busy !== null} onClick={() => void removeMarketplace(marketplace)}>
                    Retirer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {current ? (
        <Section
          title={`Catalogue — ${current.name}`}
          description="Modules proposés par ce marketplace, avec ce qu’ils contiennent et les accès qu’ils demandent."
          actions={
            marketplaces && marketplaces.length > 1 ? (
              <SelectControl
                aria-label="Marketplace affiché"
                value={current.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {marketplaces.map((marketplace) => (
                  <option key={marketplace.id} value={marketplace.id}>
                    {marketplace.name}
                  </option>
                ))}
              </SelectControl>
            ) : undefined
          }
        >
          {catalogError ? (
            <FeedbackBanner tone="error" appearance="contained">
              {catalogError}
            </FeedbackBanner>
          ) : catalog === null ? (
            <Spinner label="Chargement du catalogue" />
          ) : catalog.length === 0 ? (
            <EmptyState
              size="compact"
              title="Aucun module dans ce marketplace"
              description="Publier un module local depuis la liste des modules de l’espace pour le partager ici."
            />
          ) : (
            <ul className="modules-list" aria-label={`Modules proposés par ${current.name}`}>
              {catalog.map((entry) => {
                const accesses = catalogAccesses(entry);
                return (
                  <li key={entry.id}>
                    <div className="modules-list__main">
                      <div className="modules-list__title">
                        <span>{entry.name}</span>
                        {entry.version ? <span className="modules-list__version">v{entry.version}</span> : null}
                        {entry.installed ? (
                          <StatusBadge tone="success" size="compact">
                            Installé{entry.installed !== entry.version ? ` (v${entry.installed})` : ""}
                          </StatusBadge>
                        ) : null}
                      </div>
                      {entry.error ? (
                        <p className="modules-list__meta modules-list__meta--danger">{entry.error}</p>
                      ) : (
                        <>
                          {entry.description ? <p className="modules-list__meta">{entry.description}</p> : null}
                          <p className="modules-list__meta">
                            {plural(entry.pages?.length ?? 0, "page")} ·{" "}
                            {plural(entry.functions?.length ?? 0, "fonction")} ·{" "}
                            {accesses.length > 0
                              ? `demande ${accesses.map((access) => access.label).join(", ")}`
                              : "aucun accès demandé"}
                          </p>
                          {entry.conflict ? (
                            <p className="modules-list__meta">
                              Un module « {entry.id} » existe déjà dans l’espace sans venir de ce marketplace : le
                              supprimer pour installer celui-ci.
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="modules-list__actions">
                      {entry.error || entry.installed ? null : (
                        <Button
                          disabled={busy !== null || entry.conflict}
                          onClick={() => setOpened({ kind: "install", module: entry })}
                        >
                          Installer
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ) : null}

      {openedUpdate ? (
        <UpdateDialog
          update={openedUpdate}
          onClose={() => setOpened(null)}
          onConfirm={async () => {
            const result = await marketplaceApi.update(openedUpdate.module);
            setOpened(null);
            await afterSpaceChange();
            notify({
              title: `${openedUpdate.name} mis à jour`,
              description: `v${result.from} → v${result.to}`,
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "uninstall" ? (
        <UninstallDialog
          module={opened.module}
          onClose={() => setOpened(null)}
          onConfirm={async (deleteData) => {
            await marketplaceApi.uninstall(opened.module.id, deleteData);
            setOpened(null);
            await afterSpaceChange();
            notify({
              title: `${opened.module.name} retiré de l’espace`,
              description: deleteData ? "Ses données sont supprimées." : "Ses données sont conservées.",
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "publish" ? (
        <PublishDialog
          module={opened.module}
          marketplaces={marketplaces ?? []}
          onClose={() => setOpened(null)}
          onPublished={(version, marketplace) => {
            setOpened(null);
            notify({
              title: `${opened.module.name} v${version} publié`,
              description: `Sur ${marketplace.name}.`,
              tone: "success",
            });
            void afterSpaceChange();
            void loadCatalog(currentId);
          }}
        />
      ) : null}
      {opened?.kind === "install" && current ? (
        <InstallDialog
          module={opened.module}
          marketplace={current}
          onClose={() => setOpened(null)}
          onConfirm={async () => {
            await marketplaceApi.install(current.id, opened.module.id);
            setOpened(null);
            await afterSpaceChange();
            notify({
              title: `${opened.module.name} installé`,
              description: "Il apparaît dans la navigation, en lecture seule.",
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "merge" ? (
        <MergeDialog
          module={opened.module}
          modules={modules}
          onClose={() => setOpened(null)}
          onMerged={(target) => {
            setOpened(null);
            void afterSpaceChange();
            notify({
              title: `${opened.module.name} fusionné dans ${target.name}`,
              description: "Annulable depuis l’historique de l’espace.",
              tone: "success",
            });
          }}
        />
      ) : null}
      {opened?.kind === "split" ? (
        <SplitDialog
          module={opened.module}
          pages={modulePages(useShell.getState().snapshot, opened.module.id)}
          onClose={() => setOpened(null)}
          onSplit={(_created, name) => {
            setOpened(null);
            void afterSpaceChange();
            notify({
              title: `Module ${name} créé`,
              description: `Pages reprises de ${opened.module.name}. Annulable depuis l’historique de l’espace.`,
              tone: "success",
            });
          }}
        />
      ) : null}
      {confirmDialog}
    </Page>
  );
}
