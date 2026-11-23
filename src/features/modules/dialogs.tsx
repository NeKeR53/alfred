import { useEffect, useRef, useState } from "react";
import { Button, Code, Dialog, RadioGroup, Select, TextArea, TextField } from "socle-ui";
import { Notice, Stack, Text } from "../../kit";
import type { ModuleSummary } from "../../lib/types";
import {
  accessKindLabel,
  type CatalogModule,
  catalogAccesses,
  type DependencyStep,
  errorMessage,
  type Marketplace,
  type ModuleAccess,
  type ModuleUpdate,
  marketplaceApi,
  type PublishProblem,
  publishProblems,
} from "./api";
import { Bullets, Facts } from "./lists";

function AccessList({ accesses }: { accesses: ModuleAccess[] }) {
  return (
    <Bullets
      items={accesses.map((access) => ({
        key: `${access.kind}:${access.id}`,
        content: `${accessKindLabel[access.kind]} : ${access.label}`,
      }))}
    />
  );
}

/** Dépendances posées avec le module : installées (et masquées du menu) ou mises à jour. */
function DependencySteps({ steps }: { steps: DependencyStep[] }) {
  if (steps.length === 0) return null;
  return (
    <section aria-label="Modules dont il dépend, du même marketplace">
      <Stack gap="xs">
        <Text weight="strong">Modules dont il dépend, du même marketplace</Text>
        <Bullets
          items={steps.map((step) => ({
            key: step.module,
            content: `${step.name} v${step.version} : ${
              step.action === "install"
                ? "importé avec lui, désactivé (à activer dans Réglages → Modules)"
                : "mis à jour avec lui (même version majeure)"
            }`,
          }))}
        />
      </Stack>
    </section>
  );
}

/** Lance l’opération d’une modale : attente, puis erreur gardée dans la modale si elle échoue. */
function useApply(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  return { busy, error, apply, setError };
}

const closeOn = (onClose: () => void) => (open: boolean) => {
  if (!open) onClose();
};

/** Détail d’une mise à jour avant de l’appliquer : notes, changements, nouveaux accès, modifications locales. */
export function UpdateDialog({
  update,
  onClose,
  onConfirm,
}: {
  update: ModuleUpdate;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { busy, error, apply } = useApply(onConfirm);
  const { changes } = update;
  const unchanged =
    changes.pagesAdded.length +
      changes.pagesRemoved.length +
      changes.functionsAdded.length +
      changes.functionsRemoved.length ===
    0;
  return (
    <Dialog
      isOpen
      size="lg"
      title={`Mettre à jour ${update.name}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={Boolean(update.blocked)} onPress={() => void apply()}>
            Mettre à jour
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text>
          {`Version ${update.current} → ${update.available}${update.marketplaceName ? `, depuis ${update.marketplaceName}` : ""}. Le contenu du module est remplacé ; ses données sont conservées. La mise à jour s’annule depuis l’historique de l’espace de travail.`}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {update.blocked ? <Notice tone="danger">{update.blocked}</Notice> : null}
        <DependencySteps steps={update.dependencies ?? []} />
        {update.locallyModified ? (
          <Notice tone="warning">
            Ce module a été modifié sur place depuis son import. La mise à jour écrase ces modifications ; le détacher
            d’abord pour les garder.
          </Notice>
        ) : null}
        {changes.newAccesses.length > 0 ? (
          <Notice tone="warning" title="Cette version demande de nouveaux accès">
            <AccessList accesses={changes.newAccesses} />
          </Notice>
        ) : null}
        <section aria-label="Notes de version">
          <Stack gap="xs">
            <Text weight="strong">Notes de version</Text>
            {update.notes ? <Code block>{update.notes}</Code> : <Text>Aucune note pour cette version.</Text>}
          </Stack>
        </section>
        <Facts title="Pages ajoutées" items={changes.pagesAdded} count />
        <Facts title="Pages retirées" items={changes.pagesRemoved} count />
        <Facts title="Fonctions ajoutées" items={changes.functionsAdded} count />
        <Facts title="Fonctions retirées" items={changes.functionsRemoved} count />
        {unchanged ? <Text>Aucune page ni fonction ajoutée ou retirée.</Text> : null}
        {update.pinned ? <Text>Ce module est figé : il le restera, sur la nouvelle version.</Text> : null}
      </Stack>
    </Dialog>
  );
}

/** Retrait d’un module importé, ou suppression d’un module développé ici ; l’utilisateur décide du sort de ses données. */
export function UninstallDialog({
  module,
  onClose,
  onConfirm,
}: {
  module: ModuleSummary;
  onClose: () => void;
  onConfirm: (deleteData: boolean) => Promise<void>;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const { busy, error, apply } = useApply(() => onConfirm(deleteData));
  const installed = module.origin !== null && !module.origin.detached;
  const verb = installed ? "Retirer" : "Supprimer";
  return (
    <Dialog
      isOpen
      title={installed ? `Retirer ${module.name} de l’espace de travail` : `Supprimer ${module.name}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button variant="danger" isPending={busy} onPress={() => void apply()}>
            {verb}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text>
          {installed
            ? "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Il pourra être importé de nouveau depuis son marketplace."
            : (module.published ?? []).length > 0
              ? "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Les versions déjà publiées restent sur leur marketplace ; ce qui n’a pas été publié ne se retrouvera que par l’historique de l’espace de travail."
              : "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Ce module n’existe qu’ici : il ne pourra être retrouvé que par l’historique de l’espace de travail."}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <RadioGroup
          label="Données enregistrées par ce module"
          value={deleteData ? "delete" : "keep"}
          isDisabled={busy}
          onChange={(value) => setDeleteData(value === "delete")}
        >
          <RadioGroup.Option value="keep">
            Garder les données (elles resserviront si le module revient)
          </RadioGroup.Option>
          <RadioGroup.Option value="delete">Supprimer les données (définitif)</RadioGroup.Option>
        </RadioGroup>
      </Stack>
    </Dialog>
  );
}

/** Confirmation d’import : ce que le module contient, les modules dont il dépend et les accès qu’il demande. */
export function InstallDialog({
  module,
  marketplace,
  onClose,
  onConfirm,
}: {
  module: CatalogModule;
  marketplace: Marketplace;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { busy, error, apply } = useApply(onConfirm);
  const accesses = catalogAccesses(module);
  return (
    <Dialog
      isOpen
      size="lg"
      title={`Importer ${module.name} v${module.version}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={Boolean(module.blocked)} onPress={() => void apply()}>
            Importer
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text>
          {`Depuis le marketplace ${marketplace.name}, dans cet espace de travail. Le module arrive en lecture seule et recevra les mises à jour de ce marketplace ; pour l’adapter, il faudra le détacher.`}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {module.blocked ? <Notice tone="danger">{module.blocked}</Notice> : null}
        {module.description ? <Text>{module.description}</Text> : null}
        <DependencySteps steps={module.dependencies ?? []} />
        <section aria-label="Accès demandés">
          <Stack gap="xs">
            <Text weight="strong">Accès demandés</Text>
            {accesses.length > 0 ? (
              <>
                <AccessList accesses={accesses} />
                {accesses.some((access) => access.kind === "client") ? (
                  <Text>Un client demandé reste à relier à un client de l’espace de travail avant de servir.</Text>
                ) : null}
              </>
            ) : (
              <Text>Ce module ne demande aucun accès.</Text>
            )}
          </Stack>
        </section>
        <Facts title="Pages" items={(module.pages ?? []).map((page) => page.title)} count />
        <Facts
          title="Fonctions"
          items={(module.functions ?? []).map((fn) => (fn.description ? `${fn.id} — ${fn.description}` : fn.id))}
          count
        />
      </Stack>
    </Dialog>
  );
}

/**
 * Publication d’un module développé dans l’espace de travail (ou détaché) vers un marketplace : marketplace cible,
 * version, notes ; liste les problèmes si refusée.
 */
export function PublishDialog({
  module,
  marketplaces,
  onManage,
  onClose,
  onPublished,
}: {
  module: ModuleSummary;
  marketplaces: Marketplace[];
  /** Ouvre la rubrique Marketplace, où l’on en ajoute un. */
  onManage: () => void;
  onClose: () => void;
  onPublished: (version: string, marketplace: Marketplace) => void;
}) {
  const [target, setTarget] = useState(marketplaces[0]?.id ?? "");
  const [version, setVersion] = useState("");
  const [published, setPublished] = useState<string | null | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [problems, setProblems] = useState<PublishProblem[]>([]);
  /** Une version saisie à la main n’est plus remplacée par la proposition. */
  const typed = useRef(false);
  const { busy, error, apply } = useApply(async () => {
    const marketplace = marketplaces.find((candidate) => candidate.id === target);
    if (!marketplace || !version.trim()) return;
    setProblems([]);
    try {
      const result = await marketplaceApi.publish(module.id, marketplace.id, version.trim(), notes.trim());
      onPublished(result.version, marketplace);
    } catch (failure) {
      setProblems(publishProblems(failure));
      throw failure;
    }
  });

  useEffect(() => {
    if (!target) return;
    let current = true;
    setPublished(undefined);
    marketplaceApi
      .suggestVersion(module.id, target)
      .then((suggestion) => {
        if (!current) return;
        setPublished(suggestion.published);
        if (!typed.current) setVersion(suggestion.version);
      })
      .catch(() => {
        // Proposition indisponible : la version se saisit à la main, la publication revérifiera.
        if (current) setPublished(null);
      });
    return () => {
      current = false;
    };
  }, [module.id, target]);

  const hint =
    published === undefined
      ? "Recherche de la dernière version publiée…"
      : published
        ? `Dernière version publiée : ${published}. La nouvelle doit être supérieure.`
        : "Pas encore publié sur ce marketplace.";

  return (
    <Dialog
      isOpen
      title={`Publier ${module.name}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={!target || !version.trim()}
            onPress={() => void apply()}
          >
            Publier
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {marketplaces.length === 0 ? (
          <Notice tone="info" action={<Button onPress={onManage}>Ajouter un marketplace</Button>}>
            Aucun marketplace n’est branché : ajoutez celui de votre équipe pour publier.
          </Notice>
        ) : (
          <Text>Alfred vérifie que tout compile et qu’aucun secret ni chemin de ce poste ne part, puis l’envoie.</Text>
        )}
        {error ? (
          <Notice tone="danger" title={error}>
            {problems.length > 0 ? (
              <Bullets
                label="Problèmes à corriger"
                items={problems.map((problem) => ({
                  key: `${problem.file}:${problem.line ?? ""}:${problem.message}`,
                  content: (
                    <>
                      <Code>{`${problem.file}${problem.line ? `:${problem.line}` : ""}`}</Code> — {problem.message}
                    </>
                  ),
                }))}
              />
            ) : null}
          </Notice>
        ) : null}
        <Select
          label="Marketplace de destination"
          isRequired
          isDisabled={busy}
          value={target || null}
          options={marketplaces.map((marketplace) => ({ id: marketplace.id, label: marketplace.name }))}
          onChange={(id) => setTarget(id ?? "")}
        />
        <TextField
          label="Version"
          isRequired
          isDisabled={busy}
          description={target ? hint : undefined}
          placeholder="1.0.0"
          value={version}
          onChange={(value) => {
            typed.current = true;
            setVersion(value);
          }}
        />
        <TextArea
          label="Notes de version"
          description="Ce qui change pour ceux qui installeront ou mettront à jour."
          isDisabled={busy}
          minRows={4}
          value={notes}
          onChange={setNotes}
        />
      </Stack>
    </Dialog>
  );
}
