import {
  Button,
  Dialog,
  Disclosure,
  FeedbackBanner,
  FormActions,
  FormField,
  RadioControl,
  SelectControl,
  TextArea,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
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

/**
 * Modale de l’écran Modules : titre, corps défilant, actions en bas. Échap, le fond et « Annuler » la ferment, sauf
 * pendant l’opération qu’elle a lancée.
 */
function Modal({
  title,
  busy,
  onClose,
  children,
  actions,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Reçoit la fermeture à brancher sur « Annuler ». */
  actions: (close: () => void) => ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <Dialog
      ref={dialog}
      className="modules-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
    >
      <h2 id={titleId} className="modules-dialog__title">
        {title}
      </h2>
      <div className="modules-dialog__body">{children}</div>
      {actions(() => dialog.current?.close())}
    </Dialog>
  );
}

function AccessList({ accesses }: { accesses: ModuleAccess[] }) {
  return (
    <ul className="modules-facts">
      {accesses.map((access) => (
        <li key={`${access.kind}:${access.id}`}>
          {accessKindLabel[access.kind]} : {access.label}
        </li>
      ))}
    </ul>
  );
}

/** Dépendances posées avec le module : installées (et masquées du menu) ou mises à jour. */
function DependencySteps({ steps }: { steps: DependencyStep[] }) {
  if (steps.length === 0) return null;
  return (
    <section>
      <h3>Modules dont il dépend, du même marketplace</h3>
      <ul className="modules-facts">
        {steps.map((step) => (
          <li key={step.module}>
            {step.name} v{step.version} :{" "}
            {step.action === "install"
              ? "importé avec lui, désactivé (à activer dans Réglages → Modules)"
              : "mis à jour avec lui (même version majeure)"}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Éléments montrés d’emblée dans une liste de la fiche ; les suivants se déplient. */
const SHOWN_FACTS = 6;

/**
 * Liste de la fiche d’un module (pages, fonctions…) : un élément par ligne, coupé au besoin (en entier au survol), et
 * au-delà de quelques-uns un repli « … et N autres » : un module peut avoir beaucoup de fonctions.
 */
function Facts({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  const row = (item: string) => (
    <li key={item} className="modules-facts__item" title={item}>
      {item}
    </li>
  );
  const shown = items.length > SHOWN_FACTS + 1 ? items.slice(0, SHOWN_FACTS) : items;
  const rest = items.slice(shown.length);
  return (
    <section>
      <h3>
        {title} <span className="modules-facts__count">· {items.length}</span>
      </h3>
      <ul className="modules-facts modules-facts--compact">{shown.map(row)}</ul>
      {rest.length > 0 ? (
        <Disclosure appearance="subtle" label={`… et ${rest.length} autres`} lazy>
          <ul className="modules-facts modules-facts--compact">{rest.map(row)}</ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { changes } = update;
  const unchanged =
    changes.pagesAdded.length +
      changes.pagesRemoved.length +
      changes.functionsAdded.length +
      changes.functionsRemoved.length ===
    0;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Mettre à jour ${update.name}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <FormActions
          onCancel={close}
          onSubmit={apply}
          submitLabel="Mettre à jour"
          pendingLabel="Mise à jour…"
          pending={busy}
          disabled={Boolean(update.blocked)}
        />
      )}
    >
      <p>
        Version {update.current} → {update.available}
        {update.marketplaceName ? `, depuis ${update.marketplaceName}` : ""}. Le contenu du module est remplacé ; ses
        données sont conservées. La mise à jour s’annule depuis l’historique de l’espace de travail.
      </p>
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
      {update.blocked ? (
        <FeedbackBanner tone="error" appearance="contained">
          {update.blocked}
        </FeedbackBanner>
      ) : null}
      <DependencySteps steps={update.dependencies ?? []} />
      {update.locallyModified ? (
        <FeedbackBanner tone="warning" appearance="contained">
          Ce module a été modifié sur place depuis son import. La mise à jour écrase ces modifications ; le détacher
          d’abord pour les garder.
        </FeedbackBanner>
      ) : null}
      {changes.newAccesses.length > 0 ? (
        <FeedbackBanner tone="warning" appearance="contained">
          <strong>Cette version demande de nouveaux accès</strong>
          <AccessList accesses={changes.newAccesses} />
        </FeedbackBanner>
      ) : null}
      <section>
        <h3>Notes de version</h3>
        {update.notes ? <pre className="modules-notes">{update.notes}</pre> : <p>Aucune note pour cette version.</p>}
      </section>
      <Facts title="Pages ajoutées" items={changes.pagesAdded} />
      <Facts title="Pages retirées" items={changes.pagesRemoved} />
      <Facts title="Fonctions ajoutées" items={changes.functionsAdded} />
      <Facts title="Fonctions retirées" items={changes.functionsRemoved} />
      {unchanged ? <p>Aucune page ni fonction ajoutée ou retirée.</p> : null}
      {update.pinned ? <p>Ce module est figé : il le restera, sur la nouvelle version.</p> : null}
    </Modal>
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
  const group = useId();
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installed = module.origin !== null && !module.origin.detached;
  const verb = installed ? "Retirer" : "Supprimer";

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(deleteData);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={installed ? `Retirer ${module.name} de l’espace de travail` : `Supprimer ${module.name}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <div className="form-actions">
          <Button onClick={close} disabled={busy}>
            Annuler
          </Button>
          <Button variant="danger" loading={busy} loadingLabel="Suppression…" onClick={apply}>
            {verb}
          </Button>
        </div>
      )}
    >
      <p>
        {installed
          ? "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Il pourra être importé de nouveau depuis son marketplace."
          : (module.published ?? []).length > 0
            ? "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Les versions déjà publiées restent sur leur marketplace ; ce qui n’a pas été publié ne se retrouvera que par l’historique de l’espace de travail."
            : "Ses pages, ses fonctions et ses services (avec leurs comptes) quittent l’espace de travail, sauf les services qu’un autre module utilise encore. Ce module n’existe qu’ici : il ne pourra être retrouvé que par l’historique de l’espace de travail."}
      </p>
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
      <fieldset className="modules-choice">
        <legend>Données enregistrées par ce module</legend>
        <RadioControl
          name={group}
          label="Garder les données (elles resserviront si le module revient)"
          checked={!deleteData}
          onChange={() => setDeleteData(false)}
        />
        <RadioControl
          name={group}
          label="Supprimer les données (définitif)"
          checked={deleteData}
          onChange={() => setDeleteData(true)}
        />
      </fieldset>
    </Modal>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accesses = catalogAccesses(module);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Importer ${module.name} v${module.version}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <FormActions
          onCancel={close}
          onSubmit={apply}
          submitLabel="Importer"
          pendingLabel="Import…"
          pending={busy}
          disabled={Boolean(module.blocked)}
        />
      )}
    >
      <p>
        Depuis le marketplace {marketplace.name}, dans cet espace de travail. Le module arrive en lecture seule et
        recevra les mises à jour de ce marketplace ; pour l’adapter, il faudra le détacher.
      </p>
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
      {module.blocked ? (
        <FeedbackBanner tone="error" appearance="contained">
          {module.blocked}
        </FeedbackBanner>
      ) : null}
      {module.description ? <p>{module.description}</p> : null}
      <DependencySteps steps={module.dependencies ?? []} />
      <section>
        <h3>Accès demandés</h3>
        {accesses.length > 0 ? (
          <>
            <AccessList accesses={accesses} />
            {accesses.some((access) => access.kind === "client") ? (
              <p>Un client demandé reste à relier à un client de l’espace de travail avant de servir.</p>
            ) : null}
          </>
        ) : (
          <p>Ce module ne demande aucun accès.</p>
        )}
      </section>
      <Facts title="Pages" items={(module.pages ?? []).map((page) => page.title)} />
      <Facts
        title="Fonctions"
        items={(module.functions ?? []).map((fn) => (fn.description ? `${fn.id} — ${fn.description}` : fn.id))}
      />
    </Modal>
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
  const formId = useId();
  const [target, setTarget] = useState(marketplaces[0]?.id ?? "");
  const [version, setVersion] = useState("");
  const [published, setPublished] = useState<string | null | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<PublishProblem[]>([]);
  /** Une version saisie à la main n’est plus remplacée par la proposition. */
  const typed = useRef(false);

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const marketplace = marketplaces.find((candidate) => candidate.id === target);
    if (!marketplace || !version.trim()) return;
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const result = await marketplaceApi.publish(module.id, marketplace.id, version.trim(), notes.trim());
      onPublished(result.version, marketplace);
    } catch (failure) {
      setError(errorMessage(failure));
      setProblems(publishProblems(failure));
      setBusy(false);
    }
  };

  const hint =
    published === undefined
      ? "Recherche de la dernière version publiée…"
      : published
        ? `Dernière version publiée : ${published}. La nouvelle doit être supérieure.`
        : "Pas encore publié sur ce marketplace.";

  return (
    <Modal
      title={`Publier ${module.name}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <FormActions
          onCancel={close}
          form={formId}
          submitLabel="Publier"
          pendingLabel="Vérification et envoi…"
          pending={busy}
          disabled={!target || !version.trim()}
        />
      )}
    >
      {marketplaces.length === 0 ? (
        <FeedbackBanner
          tone="info"
          appearance="contained"
          action={<Button onClick={onManage}>Ajouter un marketplace</Button>}
        >
          Aucun marketplace n’est branché. Un marketplace est le catalogue de modules partagé de votre équipe :
          ajoutez-le dans Réglages › Marketplace avant de publier.
        </FeedbackBanner>
      ) : (
        <p>
          Alfred vérifie que chaque page et fonction compile et qu’aucun secret ni chemin de ce poste ne part, puis
          envoie le module au marketplace. Une dépendance sans version minimale part avec celle de cet espace de travail
          : qui importe le module recevra la même version majeure.
        </p>
      )}
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          <strong>{error}</strong>
          {problems.length > 0 ? (
            <ul className="modules-facts modules-facts--plain" aria-label="Problèmes à corriger">
              {problems.map((problem) => (
                <li key={`${problem.file}:${problem.line ?? ""}:${problem.message}`}>
                  <code>
                    {problem.file}
                    {problem.line ? `:${problem.line}` : ""}
                  </code>{" "}
                  — {problem.message}
                </li>
              ))}
            </ul>
          ) : null}
        </FeedbackBanner>
      ) : null}
      <form id={formId} className="modules-form" onSubmit={submit}>
        <FormField label="Marketplace de destination">
          <SelectControl value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy} required>
            {marketplaces.map((marketplace) => (
              <option key={marketplace.id} value={marketplace.id}>
                {marketplace.name}
              </option>
            ))}
          </SelectControl>
        </FormField>
        <FormField label="Version" hint={target ? hint : undefined}>
          <TextInput
            value={version}
            onChange={(event) => {
              typed.current = true;
              setVersion(event.target.value);
            }}
            placeholder="1.0.0"
            inputMode="decimal"
            spellCheck={false}
            disabled={busy}
            required
          />
        </FormField>
        <FormField label="Notes de version" hint="Ce qui change pour ceux qui installeront ou mettront à jour.">
          <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} disabled={busy} />
        </FormField>
      </form>
    </Modal>
  );
}
