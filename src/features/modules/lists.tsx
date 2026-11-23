/**
 * Listes simples des modales et des fiches de modules : une puce par élément. HTML d’app, avec les tokens Socle
 * seulement : Socle n’a pas de liste à puces en texte courant (voir les manques de la migration).
 */
import type { ReactNode } from "react";
import { Accordion } from "socle-ui";
import { Stack, Text } from "../../kit";

/** Liste à puces, un élément par ligne. */
export function Bullets({ items, label }: { items: Array<{ key: string; content: ReactNode }>; label?: string }) {
  return (
    <ul aria-label={label} className="m-0 flex min-w-0 list-disc flex-col gap-1 pl-5 text-md text-fg">
      {items.map((item) => (
        <li key={item.key} className="min-w-0 [overflow-wrap:anywhere]">
          {item.content}
        </li>
      ))}
    </ul>
  );
}

/** Éléments montrés d’emblée dans une liste de la fiche ; les suivants se déplient. */
const SHOWN_FACTS = 6;

/**
 * Liste titrée (pages, fonctions…) : au-delà de quelques éléments, un repli « … et N autres » : un module peut avoir
 * beaucoup de fonctions. Rien quand la liste est vide.
 */
export function Facts({ title, items, count = false }: { title: string; items: string[]; count?: boolean }) {
  if (items.length === 0) return null;
  const shown = items.length > SHOWN_FACTS + 1 ? items.slice(0, SHOWN_FACTS) : items;
  const rest = items.slice(shown.length);
  const bullets = (list: string[]) => <Bullets items={list.map((item) => ({ key: item, content: item }))} />;
  return (
    <section aria-label={title}>
      <Stack gap="xs">
        <Text weight="strong">{count ? `${title} · ${items.length}` : title}</Text>
        {bullets(shown)}
        {rest.length > 0 ? <Accordion title={`… et ${rest.length} autres`}>{bullets(rest)}</Accordion> : null}
      </Stack>
    </section>
  );
}

/**
 * Paires libellé et valeur dans une modale (détail d’une automatisation, d’une entrée du journal). `PropertyRow` de
 * Socle appartient au panneau de détail : hors de lui, ce composant local en reprend la lecture.
 */
export function KeyValues({ items, label }: { items: Array<{ label: string; value: ReactNode }>; label?: string }) {
  return (
    <dl aria-label={label} className="m-0 grid min-w-0 grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-2">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-md text-fg-2">{item.label}</dt>
          <dd className="m-0 min-w-0 text-md text-fg [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
