/**
 * Fusionner deux modules locaux, ou scinder un module en déplaçant des pages choisies vers un nouveau module. Le
 * backend vérifie que l’opération est sûre (identifiants en double, webhooks, tables partagées…) et, sinon, la
 * refuse en disant pourquoi ; chaque opération est un commit de l’espace, annulable par l’historique.
 */

import { useEffect, useState } from "react";
import { Button, Checkbox, CheckboxGroup, Dialog, ProgressBar, Select, TextField } from "socle-ui";
import { Notice, Stack, Text } from "../../kit";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { errorMessage } from "./api";
import { Bullets, Facts } from "./lists";

const closeOn = (onClose: () => void) => (open: boolean) => {
  if (!open) onClose();
};

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
    <Dialog
      isOpen
      title={`Fusionner ${module.name}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={!chosen} onPress={() => void apply()}>
            Fusionner
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {targets.length === 0 ? (
          <Text>
            Aucun autre module local : un module installé reste en lecture seule et n’accueille pas de fusion.
          </Text>
        ) : (
          <>
            <Select
              label="Module qui l’accueille"
              isDisabled={busy}
              value={target || null}
              options={targets.map((candidate) => ({ id: candidate.id, label: candidate.name }))}
              onChange={(id) => setTarget(id ?? "")}
            />
            <Text>
              {`Pages, fonctions, sections, planifications, code partagé et migrations de « ${module.name} » rejoignent « ${chosen?.name ?? "…"} ». Ses tables gardent leurs données et prennent le préfixe du module d’accueil. L’opération s’annule depuis l’historique de l’espace de travail.`}
            </Text>
          </>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Stack>
    </Dialog>
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
    <Dialog
      isOpen
      title={`Scinder ${module.name}`}
      isBusy={busy}
      onOpenChange={closeOn(onClose)}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={!ready} onPress={() => void apply()}>
            Créer le module
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <TextField label="Nom du nouveau module" isRequired isDisabled={busy} value={name} onChange={setName} />
        <CheckboxGroup label="Pages à déplacer" isDisabled={busy} value={selected} onChange={setSelected}>
          {pages.map((page) => (
            <Checkbox key={page.reference} value={page.id}>
              {page.title}
            </Checkbox>
          ))}
        </CheckboxGroup>
        {planning ? <ProgressBar label="Calcul de ce qui part avec ces pages" /> : null}
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
              <Notice tone="warning" title="Scission impossible :">
                <Bullets items={plan.problems.map((problem) => ({ key: problem, content: problem }))} />
              </Notice>
            ) : null}
          </>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Stack>
    </Dialog>
  );
}
