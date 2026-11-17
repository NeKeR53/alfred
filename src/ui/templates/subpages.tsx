import { ArrowLeft } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { IconButton } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { type Action, ActionBar } from "./actions";
import type { StatusTone } from "./format";
import { releases } from "./host";

/** En-tête fixe d’une page, d’un panneau ou d’une sous-page : le nom de l’objet, son état, ses actions. */
export interface PageHeaderSpec {
  /** Le nom de ce que montre la page : « Relancer le client », « Facture F-2031 ». */
  title: string;
  /** Une ligne de contexte sous le nom : « Attribuée à Léa Martin ». */
  subtitle?: string;
  /** État, en badge à côté du nom. */
  status?: { label: string; tone?: StatusTone };
  /** Actions sur l’objet : trois icônes au plus, puis « ⋯ » ; l’action `primary` en bouton plein. */
  actions?: ReadonlyArray<Action>;
  /** Appelé après la réussite d’une action (recharger). Réservé aux gabarits. */
  onDone?: () => void;
}

/** Une sous-page : un écran ouvert par-dessus la page, avec « Retour », sans perdre la liste ni sa position. */
export interface SubpageSpec extends PageHeaderSpec {
  /** Les blocs de la sous-page (`Section`, `KeyValueList`, `DataTable`, `Markdown`…), pas un gabarit. */
  content: ReactNode;
  /** `text` limite la largeur de lecture (760 px) ; `full` par défaut. */
  width?: "full" | "text";
}

interface Entry {
  id: number;
  spec: SubpageSpec;
  resolve: () => void;
}

let stack: Entry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const top = () => stack[stack.length - 1];

releases.add(() => {
  for (const entry of stack) entry.resolve();
  stack = [];
  emit();
});

/**
 * Ouvre une sous-page par-dessus la page : un objet à lire ou à traiter en entier (une ligne de la liste, un
 * document). « Retour » (ou Échap) revient à la page telle qu’elle était. Une sous-page peut en ouvrir une autre.
 * La promesse se résout à sa fermeture.
 */
export function openSubpage(spec: SubpageSpec): Promise<void> {
  return new Promise((resolve) => {
    nextId += 1;
    stack = [...stack, { id: nextId, spec, resolve }];
    emit();
  });
}

/** Ferme la sous-page du dessus (après une suppression, par exemple). */
export function closeSubpage() {
  const entry = top();
  if (!entry) return;
  stack = stack.slice(0, -1);
  emit();
  entry.resolve();
}

export function useSubpage() {
  return useSyncExternalStore(subscribe, top, top);
}

/** En-tête fixe, hors de la zone qui défile ; `onBack` y ajoute « Retour ». */
export function PageHeaderBar({ header, onBack }: { header: PageHeaderSpec; onBack?: () => void }) {
  return (
    <header className="al-page__header">
      {onBack ? (
        <IconButton label="Retour" tooltip="Retour" onClick={onBack} data-autofocus>
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
      <div className="al-object-header__copy">
        <div className="al-object-header__title">
          <h1 className="al-heading al-heading--2">{header.title}</h1>
          {header.status ? (
            <StatusBadge tone={header.status.tone ?? "neutral"} size="compact">
              {header.status.label}
            </StatusBadge>
          ) : null}
        </div>
        {header.subtitle ? <p className="al-object-header__description">{header.subtitle}</p> : null}
      </div>
      {header.actions?.length ? (
        <ActionBar actions={header.actions} place="header" subject={header.title} onDone={header.onDone} />
      ) : null}
    </header>
  );
}

/** La sous-page du dessus, posée par la `Page` hôte par-dessus son contenu. */
export function SubpageLayer({ entry }: { entry: Entry }) {
  const layer = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: une nouvelle sous-page reprend le focus.
  useEffect(() => {
    if (!opener.current) opener.current = document.activeElement;
    layer.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [entry.id]);
  useEffect(
    () => () => {
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    },
    [],
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      closeSubpage();
    }
  };
  return (
    <section ref={layer} className="al-subpage" aria-label={entry.spec.title} onKeyDown={onKeyDown}>
      <PageHeaderBar header={entry.spec} onBack={closeSubpage} />
      <div className={`al-page__body${entry.spec.width === "text" ? " al-page__body--text" : ""}`}>
        {entry.spec.content}
      </div>
    </section>
  );
}
