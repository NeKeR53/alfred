import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { FeedbackBanner } from "../components/FeedbackBanner";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { KeyValueList, Page, Section, Text } from "../components/page";
import { type Action, ActionBar } from "./actions";
import { FormattedValue, type StatusMap, type ValueOptions } from "./format";
import { useFrameServices, useReloadOnPeerChange } from "./services";
import { useLoad } from "./useLoad";

/** Une ligne de la fiche : libellé à gauche, valeur formatée selon son type à droite. */
export interface DetailField extends ValueOptions {
  label: string;
  value: unknown;
  /** La ligne est masquée quand la valeur est vide (au lieu d’afficher « — »). */
  hideEmpty?: boolean;
}

/** Un bloc titré sous la fiche : un texte, une liste, un tableau composé par la page. */
export interface DetailSection {
  title: string;
  /** Un texte (affiché en paragraphe) ou des composants de `@alfred/ui`. Vide : `empty` s’affiche. */
  content?: ReactNode;
  /** « Aucune description ». */
  empty?: string;
  /** Actions du bloc : deux icônes au plus, le reste dans « ⋯ ». */
  actions?: ReadonlyArray<Action>;
}

/** Identifiant publié par la liste (`{ id }`), ou la sélection elle-même. */
function selectedId(selection: unknown): unknown {
  if (selection && typeof selection === "object" && "id" in selection) return (selection as { id: unknown }).id;
  return selection ?? null;
}

function useSelectedId() {
  const services = useFrameServices();
  const [id, setId] = useState<unknown>(null);
  useEffect(() => services.onSelection((selection) => setId(selectedId(selection))), [services]);
  return id;
}

/**
 * Gabarit du panneau de droite : l’objet sélectionné dans la liste de la page, avec son nom, son état, ses
 * actions en icônes, sa fiche et ses blocs. Il lit lui-même la sélection, charge l’objet et couvre les états
 * (rien de sélectionné, chargement, erreur, introuvable). Après une action, la liste de la page se recharge.
 */
export function DetailPanel<Item>({
  load,
  title,
  subtitle,
  status,
  actions,
  fields,
  sections,
  emptyTitle,
  emptyDescription = "Sélectionnez une ligne de la liste pour afficher son détail.",
  notFoundTitle = "Élément introuvable",
}: {
  /** Charge l’objet sélectionné ; `null` s’il n’existe plus. */
  load: (id: unknown) => Promise<Item | null | undefined>;
  title: (item: Item) => string;
  /** Une ligne de contexte sous le nom : « Attribuée à Léa Martin ». */
  subtitle?: (item: Item) => string | null | undefined;
  /** État de l’objet, en badge à côté du nom. */
  status?: { value: (item: Item) => string | null | undefined; statuses: StatusMap };
  /** Actions sur l’objet : trois icônes au plus, puis « ⋯ » (les actions `danger` y vont toujours). */
  actions?: (item: Item) => ReadonlyArray<Action>;
  /** Attributs de l’objet, en fiche « libellé : valeur ». */
  fields?: (item: Item) => ReadonlyArray<DetailField>;
  /** Blocs titrés sous la fiche. */
  sections?: (item: Item) => ReadonlyArray<DetailSection>;
  /** « Aucune tâche sélectionnée ». */
  emptyTitle: string;
  emptyDescription?: string;
  notFoundTitle?: string;
}) {
  const id = useSelectedId();
  const state = useLoad(async () => (id == null ? null : ((await load(id)) ?? null)), [id]);
  useReloadOnPeerChange(state.reload);
  const item = state.data;

  if (id == null) {
    return (
      <Page>
        <EmptyState size="compact" title={emptyTitle} description={emptyDescription} />
      </Page>
    );
  }
  if (state.error) {
    return (
      <Page>
        <FeedbackBanner tone="danger" action={<Button onClick={state.reload}>Réessayer</Button>}>
          {`Le détail n’a pas pu être chargé. ${state.error.message}`}
        </FeedbackBanner>
      </Page>
    );
  }
  if (item === undefined) {
    return (
      <Page>
        <LoadingSkeleton rows={4} label="Chargement du détail…" />
      </Page>
    );
  }
  if (item === null) {
    return (
      <Page>
        <EmptyState size="compact" title={notFoundTitle} description="Il a peut-être été supprimé." />
      </Page>
    );
  }
  const name = title(item);
  const statusValue = status?.value(item);
  const rows = (fields?.(item) ?? []).filter(
    (field) => !(field.hideEmpty && (field.value == null || field.value === "")),
  );
  return (
    <Page
      header={{
        title: name,
        subtitle: subtitle?.(item) ?? undefined,
        status: statusValue ? (status?.statuses[statusValue] ?? { label: statusValue, tone: "neutral" }) : undefined,
        actions: actions?.(item),
        onDone: state.reload,
      }}
    >
      {rows.length > 0 ? (
        <KeyValueList
          items={rows.map((field) => ({
            id: field.label,
            label: field.label,
            value: <FormattedValue value={field.value} options={field} />,
          }))}
        />
      ) : null}
      {(sections?.(item) ?? []).map((section) => {
        const empty = section.content == null || section.content === "" || section.content === false;
        return (
          <Section
            key={section.title}
            title={section.title}
            actions={
              section.actions ? (
                <ActionBar actions={section.actions} place="section" subject={name} onDone={state.reload} />
              ) : undefined
            }
          >
            {empty ? (
              <Text tone="muted">{section.empty ?? "Aucun contenu"}</Text>
            ) : typeof section.content === "string" ? (
              <Text>{section.content}</Text>
            ) : (
              section.content
            )}
          </Section>
        );
      })}
    </Page>
  );
}
