import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Alert, Button, Checkbox, CheckboxGroup, Link, TextInput } from "socle-ui";
import {
  type CatalogModule,
  catalogAccesses,
  errorMessage,
  type Marketplace,
  marketplaceApi,
} from "../../features/modules/api";
import { useModuleUpdatesStore } from "../../features/modules/useModuleUpdates";
import { LoadingRows } from "../../features/space/SpaceSettings";
import { Stack, Text } from "../../kit";
import { useShell } from "../store";
import { useWelcome } from "./store";

/** Proposée, jamais imposée : le champ reste modifiable. */
export const SUGGESTED_MARKETPLACE = "https://github.com/NeKeR53/alfred.place.git";

interface Offer {
  marketplace: Marketplace;
  module: CatalogModule;
}

const keyOf = (offer: Offer) => `${offer.marketplace.id}/${offer.module.id}`;

/** Ce qui empêche d’importer ce module, ou `null`. */
function unavailable(module: CatalogModule): string | null {
  if (module.error) return "Illisible";
  if (module.installed || module.own) return null;
  if (module.conflict) return "Un module du même nom est déjà là";
  if (module.blocked) return module.blocked;
  return null;
}

const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Les accès d’un module en une ligne : les comptes par leur nom, le reste compté par genre. */
export function accessSummary(module: CatalogModule): string | null {
  const accesses = catalogAccesses(module);
  const of = (kind: string) => accesses.filter((access) => access.kind === kind);
  const parts = [
    of("client").length
      ? `${of("client").length > 1 ? "comptes" : "compte"} ${listNames(of("client").map((access) => access.label))}`
      : null,
    of("module").length ? `utilise ${listNames(of("module").map((access) => access.id))}` : null,
    of("tables").length ? `lit les données de ${listNames(of("tables").map((access) => access.id))}` : null,
    of("tool").length ? count(of("tool").length, "action pour l’agent", "actions pour l’agent") : null,
    of("schedule").length ? count(of("schedule").length, "relevé planifié", "relevés planifiés") : null,
    of("webhook").length ? count(of("webhook").length, "webhook", "webhooks") : null,
  ].filter(Boolean);
  return parts.length ? `Demande : ${parts.join(" · ")}` : null;
}

function listNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

/**
 * Vos modules : brancher un marketplace (une adresse git), puis cocher les modules à importer. L’étape relit à chaque
 * fois les marketplaces branchés et leur catalogue ; elle se passe avec « Plus tard ».
 */
export function ModulesStep({ footer, onDone }: { footer: (primary: ReactNode) => ReactNode; onDone: () => void }) {
  const loadUpdates = useModuleUpdatesStore((state) => state.load);
  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState(SUGGESTED_MARKETPLACE);
  const [addError, setAddError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const load = useCallback(async () => {
    setReadError(null);
    try {
      const list = await marketplaceApi.list();
      setMarketplaces(list);
      const catalogs = await Promise.all(
        list.map(async (marketplace) => {
          const modules = await marketplaceApi.modules(marketplace.id);
          return modules.map((module) => ({ marketplace, module }));
        }),
      );
      setOffers(catalogs.flat());
    } catch (failure) {
      setMarketplaces((current) => current ?? []);
      setOffers([]);
      setReadError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showForm = marketplaces !== null && (marketplaces.length === 0 || adding);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      await marketplaceApi.add(url.trim());
      setAdding(false);
      setUrl("");
      await load();
    } catch (failure) {
      setAddError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  /** Modules déjà là : cochés et grisés, jamais importés de nouveau. */
  const present = (offers ?? []).filter((offer) => offer.module.installed || offer.module.own).map(keyOf);

  const chosen = (offers ?? []).filter((offer) => selected.has(keyOf(offer)));

  const importChosen = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (chosen.length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    setFailures({});
    const failed: Record<string, string> = {};
    const imported: Array<{ id: string; name: string }> = [];
    // L’un après l’autre : chaque import écrit son commit dans l’espace.
    for (const offer of chosen) {
      try {
        await marketplaceApi.install(offer.marketplace.id, offer.module.id);
        imported.push({ id: offer.module.id, name: offer.module.name });
      } catch (failure) {
        failed[keyOf(offer)] = errorMessage(failure);
      }
    }
    await Promise.all([
      useShell
        .getState()
        .refresh()
        .catch(() => undefined),
      loadUpdates(false).catch(() => undefined),
    ]);
    useWelcome.setState((state) => ({
      imported: [...state.imported, ...imported.filter((module) => !state.imported.some(({ id }) => id === module.id))],
    }));
    setBusy(false);
    if (Object.keys(failed).length === 0) {
      onDone();
      return;
    }
    // Ce qui est passé reste importé ; on reste sur l’étape pour dire ce qui a échoué.
    setFailures(failed);
    setSelected(new Set(Object.keys(failed)));
    await load();
  };

  const primary = showForm ? (
    <Button type="submit" form={formId} variant="primary" isPending={busy} isDisabled={!url.trim()}>
      Ajouter le marketplace
    </Button>
  ) : (
    <Button type="submit" form={formId} variant="primary" isPending={busy} isDisabled={offers === null}>
      {chosen.length === 0
        ? "Continuer"
        : chosen.length === 1
          ? "Importer 1 module"
          : `Importer ${chosen.length} modules`}
    </Button>
  );

  const several = (marketplaces?.length ?? 0) > 1;

  return (
    <>
      {marketplaces === null ? (
        <LoadingRows label="Lecture des marketplaces" rows={3} />
      ) : showForm ? (
        <form id={formId} noValidate onSubmit={(event) => void add(event)}>
          <Stack gap="sm">
            <TextInput
              label="Adresse git du marketplace"
              isRequired
              value={url}
              autoFocus
              isDisabled={busy}
              placeholder={SUGGESTED_MARKETPLACE}
              error={addError ?? undefined}
              description={
                url.trim() === SUGGESTED_MARKETPLACE
                  ? "C’est une suggestion : le marketplace public d’Alfred. Mettez celle de votre équipe si vous en avez une."
                  : "L’adresse du dépôt git où votre équipe partage ses modules."
              }
              onChange={(value) => {
                setUrl(value);
                setAddError(null);
              }}
            />
            {marketplaces.length > 0 ? (
              <Text size="meta">
                <Link onPress={() => setAdding(false)}>Revenir aux modules</Link>
              </Text>
            ) : null}
          </Stack>
        </form>
      ) : (
        <form id={formId} noValidate onSubmit={(event) => void importChosen(event)}>
          <Stack gap="md">
            <Text size="meta" tone="muted">
              Branché : {marketplaces.map((marketplace) => marketplace.name).join(", ")} ·{" "}
              <Link
                onPress={() => {
                  setAdding(true);
                  setUrl("");
                }}
              >
                Ajouter un autre marketplace
              </Link>
            </Text>
            {readError ? (
              <Alert
                tone="danger"
                title="Le catalogue n’a pas pu être lu"
                action={{ label: "Réessayer", onPress: () => void load() }}
              >
                {readError}
              </Alert>
            ) : null}
            {offers === null ? (
              <LoadingRows label="Lecture du catalogue" rows={3} />
            ) : offers.length === 0 && !readError ? (
              <Text size="meta" tone="muted">
                Ce marketplace ne propose encore aucun module.
              </Text>
            ) : (
              <CheckboxGroup
                label="Modules proposés"
                hideLabel
                isDisabled={busy}
                value={[...present, ...selected]}
                onChange={(keys) => setSelected(new Set(keys.filter((key) => !present.includes(key))))}
              >
                {offers.map((offer) => {
                  const key = keyOf(offer);
                  const { module } = offer;
                  const already = Boolean(module.installed || module.own);
                  const blocked = unavailable(module);
                  const details = [
                    already ? "Déjà là" : blocked ? `Indisponible : ${blocked}` : null,
                    module.description,
                    accessSummary(module),
                    several ? `Depuis ${offer.marketplace.name}` : null,
                  ].filter(Boolean);
                  return (
                    <Checkbox
                      key={key}
                      value={key}
                      isDisabled={already || Boolean(blocked)}
                      description={details.join(" · ") || undefined}
                      error={failures[key] ? `Import impossible : ${failures[key]}` : undefined}
                    >
                      {module.name}
                    </Checkbox>
                  );
                })}
              </CheckboxGroup>
            )}
            {chosen.length > 0 ? (
              <Text size="meta" tone="muted">
                {chosen.length > 1
                  ? `${listNames(chosen.map((offer) => offer.module.name))} arriveront en lecture seule et recevront les mises à jour du marketplace. Je vous guiderai ensuite pour les configurer.`
                  : `${chosen[0].module.name} arrivera en lecture seule et recevra les mises à jour du marketplace. Je vous guiderai ensuite pour le configurer.`}
              </Text>
            ) : null}
          </Stack>
        </form>
      )}
      {footer(primary)}
    </>
  );
}
