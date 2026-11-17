import {
  Button,
  EmptyState,
  FormControlGroup,
  FormField,
  RefreshButton,
  Section,
  Spinner,
  StatusBadge,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage, type Marketplace, type ModulePublication, marketplaceApi } from "./api";
import { useModuleUpdatesStore } from "./useModuleUpdates";
import "./modules.css";

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function checkedAt(iso: string | null) {
  if (!iso) return "Jamais vérifié";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Jamais vérifié";
  return `Vérifié le ${date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
}

/**
 * Marketplaces branchés sur ce poste (rubrique Marketplace, écran « Sources ») : les catalogues de modules partagés
 * (dépôts git), communs à tous les espaces de travail. `onChanged` prévient le catalogue qu’un marketplace a été
 * ajouté, rafraîchi ou retiré.
 */
export function MarketplaceSources({ onChanged, actions }: { onChanged?: () => void; actions?: ReactNode }) {
  const updates = useModuleUpdatesStore((state) => state.updates);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);
  const spaceOpen = useShell((state) => Boolean(state.snapshot));
  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [publications, setPublications] = useState<ModulePublication[]>([]);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /** Opération en cours : `add` ou `refresh:<id>`. */
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const addErrorId = useId();

  const load = useCallback(async () => {
    try {
      setMarketplaces(await marketplaceApi.list());
    } catch (failure) {
      setMarketplaces([]);
      notify({ title: "Marketplaces illisibles", description: errorMessage(failure), tone: "error" });
    }
    setPublications(await marketplaceApi.publications().catch(() => []));
  }, []);

  useEffect(() => {
    void load();
    void loadUpdates(false).catch(() => undefined);
  }, [load, loadUpdates]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy("add");
    setAddError(null);
    try {
      const added = await marketplaceApi.add(url.trim());
      setUrl("");
      await Promise.all([load(), loadUpdates(false).catch(() => undefined)]);
      onChanged?.();
      notify({ title: `Marketplace ${added.name} ajouté`, tone: "success" });
    } catch (failure) {
      setAddError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (marketplace: Marketplace) => {
    const imported = updates.filter((update) => update.marketplace === marketplace.id).length;
    const accepted = await confirm({
      title: `Retirer ${marketplace.name} ?`,
      message:
        imported > 0
          ? `Il est retiré pour tous vos espaces de travail. ${plural(imported, "module importé", "modules importés")} dans cet espace de travail ${imported > 1 ? "restent" : "reste"}, sans mise à jour tant que le marketplace n’est pas ajouté de nouveau.`
          : "Il est retiré pour tous vos espaces de travail. Ses modules ne seront plus proposés ; vos espaces de travail gardent ce qu’ils en ont importé.",
      confirmLabel: "Retirer",
      tone: "danger",
    });
    if (!accepted) return;
    setBusy(`refresh:${marketplace.id}`);
    try {
      await marketplaceApi.remove(marketplace.id);
      await Promise.all([load(), loadUpdates(false).catch(() => undefined)]);
      onChanged?.();
      notify({ title: `Marketplace ${marketplace.name} retiré` });
    } catch (failure) {
      notify({ title: "Retrait impossible", description: errorMessage(failure), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (marketplace: Marketplace) => {
    setBusy(`refresh:${marketplace.id}`);
    try {
      try {
        await marketplaceApi.refresh(marketplace.id);
      } finally {
        // L’échec aussi s’inscrit sur le marketplace : la liste doit le montrer.
        await Promise.all([load(), loadUpdates(false).catch(() => undefined)]);
        onChanged?.();
      }
      notify({ title: `${marketplace.name} est à jour`, tone: "success" });
    } catch (failure) {
      notify({
        title: `Rafraîchissement de ${marketplace.name} impossible`,
        description: errorMessage(failure),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  /** Ce que l’espace de travail ouvert a fait avec ce marketplace : modules importés, modules publiés. */
  const usage = (marketplace: Marketplace) => {
    if (!spaceOpen) return null;
    const imported = updates.filter((update) => update.marketplace === marketplace.id).length;
    const published = publications.filter((publication) => publication.marketplace === marketplace.id).length;
    if (imported === 0 && published === 0) return "Rien d’importé ni de publié depuis cet espace de travail";
    return [
      imported > 0 ? `${plural(imported, "module importé", "modules importés")}` : null,
      published > 0 ? `${plural(published, "module publié", "modules publiés")}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
      .concat(" dans cet espace de travail");
  };

  return (
    <>
      <Section
        title="Marketplaces branchés"
        description="Chaque marketplace est un dépôt git de modules partagés, commun à tous vos espaces de travail. Alfred s’y connecte avec les accès git de ce poste."
        actions={actions}
      >
        <form onSubmit={add}>
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
              loadingLabel="Ajout…"
              disabled={!url.trim() || busy !== null}
            >
              Ajouter
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
            title="Aucun marketplace"
            description="Ajoutez l’adresse du marketplace de votre équipe pour importer ses modules ou y publier les vôtres."
          />
        ) : (
          <ul className="modules-list" aria-label="Marketplaces">
            {marketplaces.map((marketplace) => {
              const used = usage(marketplace);
              return (
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
                    {used ? <p className="modules-list__meta">{used}</p> : null}
                    {marketplace.error ? (
                      <p className="modules-list__meta modules-list__meta--danger">{marketplace.error}</p>
                    ) : null}
                  </div>
                  <div className="modules-list__actions">
                    <RefreshButton
                      label={`Rafraîchir ${marketplace.name}`}
                      loading={busy === `refresh:${marketplace.id}`}
                      disabled={busy !== null}
                      onClick={() => void refresh(marketplace)}
                    />
                    <Button disabled={busy !== null} onClick={() => void remove(marketplace)}>
                      Retirer
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {confirmDialog}
    </>
  );
}
