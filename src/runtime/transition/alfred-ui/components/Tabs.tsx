import { type KeyboardEvent, type ReactNode, useRef } from "react";

export interface TabItem<Id extends string | number> {
  id: Id;
  label: string;
  content?: ReactNode;
  /** Infobulle native, obligatoire quand l’onglet n’affiche qu’une icône. */
  title?: string;
}

/**
 * Onglets (rôles `tablist` / `tab`) avec l’apparence de ceux de la barre du haut : soulignement de l’onglet actif,
 * flèches, Origine et Fin. `idPrefix` et `panelId` relient l’onglet actif au panneau qu’il affiche (`aria-controls`) ;
 * `className` et `tabClassName` remplacent l’apparence (réservés à la coquille).
 */
export function Tabs<Id extends string | number>({
  label,
  items,
  activeId,
  onChange,
  className = "settings-editor-tabs",
  tabClassName = "settings-editor-tab",
  idPrefix,
  panelId,
}: {
  label: string;
  items: readonly TabItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void;
  className?: string;
  tabClassName?: string;
  idPrefix?: string;
  panelId?: string;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.defaultPrevented) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <div className={className} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          type="button"
          className={tabClassName}
          id={idPrefix ? `${idPrefix}-${item.id}` : undefined}
          role="tab"
          aria-controls={activeId === item.id ? panelId : undefined}
          aria-selected={activeId === item.id}
          tabIndex={activeId === item.id ? 0 : -1}
          title={item.title}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => move(event, index)}
          ref={(node) => {
            tabs.current[index] = node;
          }}
          key={item.id}
        >
          {item.content ?? item.label}
        </button>
      ))}
    </div>
  );
}
