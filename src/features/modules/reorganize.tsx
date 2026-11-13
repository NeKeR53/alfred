/**
 * Fusionner deux modules locaux, ou scinder un module en déplaçant des pages choisies vers un nouveau module. Le
 * backend vérifie que l’opération est sûre (identifiants en double, webhooks, tables partagées…) et, sinon, la
 * refuse en disant pourquoi ; chaque opération est un commit de l’espace, annulable par l’historique.
 */

import {
  Button,
  CheckboxControl,
  Dialog,
  FeedbackBanner,
  FormField,
  SelectControl,
  Spinner,
  TextInput,
} from "@alfred/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { errorMessage } from "./api";

export interface SplitPlan {
  pages: string[];
  functions: string[];
  sharedFunctions: string[];
  sections: string[];
  tables: string[];
  problems: string[];
}

export const reorganizeApi = {
  merge: (source: string, target: string) =>
    invoke<{ module: string; commit: string | null }>("modules.merge", { source, target }),
  splitPlan: (module: string, pages: string[]) => invoke<SplitPlan>("modules.splitPlan", { module, pages }),
  split: (module: string, pages: string[], name: string) =>
    invoke<{ module: string; commit: string | null }>("modules.split", { module, pages, name }),
};

/** Pages d’un module : onglets, panneaux de droite et pages des Réglages. */
export function modulePages(snapshot: Snapshot | null | undefined, module: string): ResolvedPage[] {
  const pages = [
    ...(snapshot?.sections.flatMap((section) =>
      section.pages.flatMap((page) => [page, ...(page.panel ? [page.panel] : [])]),
    ) ?? []),
    ...(snapshot?.settingsPages ?? []),
  ];
  const seen = new Set<string>();
  return pages.filter((page) => {
    if (page.module !== module || seen.has(page.reference)) return false;
    seen.add(page.reference);
    return true;
  });
}

function isLocal(module: ModuleSummary) {
  return module.origin === null || module.origin.detached;
}

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

/** Fusion : le module choisi rejoint un autre module local, qui garde son nom. */
export function MergeDialog({
  module,
  modules,
  onClose,
  onMerged,
}: {
  module: ModuleSummary;
  modules: ModuleSummary[];
  onClose: () => void;
  onMerged: (target: ModuleSummary) => void;
}) {
  const targets = modules.filter((candidate) => candidate.id !== module.id && isLocal(candidate));
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = targets.find((candidate) => candidate.id === target);

  const apply = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await reorganizeApi.merge(module.id, chosen.id);
      onMerged(chosen);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Fusionner ${module.name}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <div className="form-actions">
          <Button onClick={close} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} loadingLabel="Fusion…" disabled={!chosen} onClick={apply}>
            Fusionner
          </Button>
        </div>
      )}
    >
      {targets.length === 0 ? (
        <p>Aucun autre module local : un module installé reste en lecture seule et n’accueille pas de fusion.</p>
      ) : (
        <>
          <FormField label="Module qui l’accueille">
            <SelectControl value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy}>
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </SelectControl>
          </FormField>
          <p>
            Pages, fonctions, sections, planifications, code partagé et migrations de « {module.name} » rejoignent «{" "}
            {chosen?.name ?? "…"} ». Ses tables gardent leurs données et prennent le préfixe du module d’accueil.
            L’opération s’annule depuis l’historique de l’espace.
          </p>
        </>
      )}
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
    </Modal>
  );
}

function Facts({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul className="modules-facts">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Scission : les pages cochées partent dans un nouveau module, avec ce qu’elles seules utilisent. */
export function SplitDialog({
  module,
  pages,
  onClose,
  onSplit,
}: {
  module: ModuleSummary;
  pages: ResolvedPage[];
  onClose: () => void;
  onSplit: (created: string, name: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selected.length === 0) {
      setPlan(null);
      return;
    }
    let active = true;
    setPlanning(true);
    reorganizeApi.splitPlan(module.id, selected).then(
      (next) => {
        if (!active) return;
        setPlan(next);
        setPlanning(false);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(errorMessage(failure));
        setPlanning(false);
      },
    );
    return () => {
      active = false;
    };
  }, [module.id, selected]);

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  const ready = plan !== null && plan.problems.length === 0 && name.trim() !== "" && !planning;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await reorganizeApi.split(module.id, selected, name.trim());
      onSplit(result.module, name.trim());
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Scinder ${module.name}`}
      busy={busy}
      onClose={onClose}
      actions={(close) => (
        <div className="form-actions">
          <Button onClick={close} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} loadingLabel="Scission…" disabled={!ready} onClick={apply}>
            Créer le module
          </Button>
        </div>
      )}
    >
      <FormField label="Nom du nouveau module">
        <TextInput value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </FormField>
      <fieldset className="modules-choice">
        <legend>Pages à déplacer</legend>
        {pages.map((page) => (
          <CheckboxControl
            key={page.reference}
            label={page.title}
            checked={selected.includes(page.id)}
            disabled={busy}
            onChange={(event) => toggle(page.id, event.target.checked)}
          />
        ))}
      </fieldset>
      {planning ? <Spinner label="Calcul de ce qui part avec ces pages" /> : null}
      {plan && !planning ? (
        <>
          <Facts
            title="Partent aussi"
            items={[
              ...plan.functions.map((id) => `Fonction ${id}`),
              ...plan.sections.map((id) => `Section ${id}`),
              ...plan.tables.map((id) => `Table ${id} (avec ses données)`),
            ]}
          />
          <Facts
            title="Restent dans le module, appelées par les pages déplacées"
            items={plan.sharedFunctions.map((id) => `Fonction ${id}`)}
          />
          {plan.problems.length ? (
            <FeedbackBanner tone="warning" appearance="contained">
              Scission impossible :
              <ul className="modules-facts">
                {plan.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </FeedbackBanner>
          ) : null}
        </>
      ) : null}
      {error ? (
        <FeedbackBanner tone="error" appearance="contained">
          {error}
        </FeedbackBanner>
      ) : null}
    </Modal>
  );
}
