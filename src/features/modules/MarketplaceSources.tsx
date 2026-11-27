import { RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Accordion, type Action, Button, Code, type SettingsSection, TextInput } from "socle-ui";
import { Row, Stack } from "../../kit";
import { useLastKnown } from "../../shell/lastKnown";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage, type Marketplace, type ModulePublication, marketplaceApi } from "./api";
import { useModuleUpdatesStore } from "./useModuleUpdates";

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
 * Marketplaces branchés sur ce poste (rubrique Marketplace, écran « Sources »), en une section : les catalogues de
 * modules partagés (dépôts git), communs à tous les espaces de travail. `onChanged` prévient le catalogue qu’un
 * marketplace a été ajouté, rafraîchi ou retiré. `active` faux : l’écran n’est pas affiché, rien n’est lu.
 */
export function useMarketplaceSourcesSection({
  active,
  onChanged,
  back,
}: {
  active: boolean;
  onChanged?: () => void;
  back?: Action;
}): SettingsSection | null {
  const updates = useModuleUpdatesStore((state) => state.updates);
  const loadUpdates = useModuleUpdatesStore((state) => state.load);
  const spaceOpen = useShell((state) => Boolean(state.snapshot));
  const [marketplaces, setMarketplaces] = useLastKnown<Marketplace[] | null>("marketplace/sources", null);
  const [publications, setPublications] = useLastKnown<ModulePublication[]>("marketplace/publications", []);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setMarketplaces(await marketplaceApi.list());
    } catch (failure) {
      setMarketplaces([]);
      notify({ title: "Marketplaces illisibles", description: errorMessage(failure), tone: "error" });
    }
    setPublications(await marketplaceApi.publications().catch(() => []));
  }, [setPublications, setMarketplaces]);

  useEffect(() => {
    if (!active) return;
    void load();
    void loadUpdates(false).catch(() => undefined);
  }, [active, load, loadUpdates]);

  if (!active) return null;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
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
      setAdding(false);
    }
  };

  const remove = async (marketplace: Marketplace) => {
    try {
      await marketplaceApi.remove(marketplace.id);
      await Promise.all([load(), loadUpdates(false).catch(() => undefined)]);
      onChanged?.();
      notify({ title: `Marketplace ${marketplace.name} retiré` });
    } catch (failure) {
      notify({ title: "Retrait impossible", description: errorMessage(failure), tone: "error" });
    }
  };

  const refresh = async (marketplace: Marketplace) => {
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

  const gitOutputs = (marketplaces ?? []).filter((marketplace) => marketplace.error && marketplace.errorDetail);

  return {
    id: "sources",
    title: "Marketplaces branchés",
    description:
      "Chaque marketplace est un dépôt git de modules partagés, commun à tous vos espaces de travail. Alfred s’y connecte avec les accès git de ce poste.",
    actions: back ? [back] : undefined,
    emptyMessage:
      marketplaces === null
        ? "Chargement des marketplaces…"
        : "Aucun marketplace. Ajoutez l’adresse du marketplace de votre équipe pour importer ses modules ou y publier les vôtres.",
    settings: (marketplaces ?? []).map((marketplace) => {
      const imported = updates.filter((update) => update.marketplace === marketplace.id).length;
      return {
        type: "item" as const,
        id: marketplace.id,
        label: marketplace.name,
        description: [
          `${marketplace.url} · ${checkedAt(marketplace.lastChecked)}`,
          usage(marketplace),
          marketplace.error,
        ]
          .filter(Boolean)
          .join(" · "),
        tags: marketplace.error ? [{ label: "Inaccessible", tone: "danger" as const }] : undefined,
        actions: [
          {
            id: "refresh",
            label: `Rafraîchir ${marketplace.name}`,
            icon: <RefreshCw size={16} aria-hidden="true" />,
            onPress: () => refresh(marketplace),
          },
          {
            id: "remove",
            label: `Retirer ${marketplace.name}`,
            danger: true,
            confirm: {
              title: `Retirer ${marketplace.name} ?`,
              message:
                imported > 0
                  ? `Il est retiré pour tous vos espaces de travail. ${plural(imported, "module importé", "modules importés")} dans cet espace de travail ${imported > 1 ? "restent" : "reste"}, sans mise à jour tant que le marketplace n’est pas ajouté de nouveau.`
                  : "Il est retiré pour tous vos espaces de travail. Ses modules ne seront plus proposés ; vos espaces de travail gardent ce qu’ils en ont importé.",
              confirmLabel: "Retirer",
            },
            onPress: () => remove(marketplace),
          },
        ],
      };
    }),
    content: (
      <Stack gap="md">
        {gitOutputs.map((marketplace) => (
          <Accordion key={marketplace.id} title={`Message de git (${marketplace.name})`}>
            <Code block>{marketplace.errorDetail}</Code>
          </Accordion>
        ))}
        <form noValidate onSubmit={add}>
          <Row gap="sm">
            <TextInput
              label="Adresse git du marketplace"
              isRequired
              placeholder="git@exemple.fr:equipe/modules.git"
              autoComplete="off"
              isDisabled={adding}
              error={addError ?? undefined}
              value={url}
              onChange={(value) => {
                setUrl(value);
                setAddError(null);
              }}
            />
            <Button type="submit" isPending={adding} isDisabled={!url.trim()}>
              Ajouter
            </Button>
          </Row>
        </form>
      </Stack>
    ),
  };
}
