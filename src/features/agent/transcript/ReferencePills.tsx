import type { ReactNode } from "react";
import { type ComposerReference, type ComposerReferenceMention, referenceDisplayName } from "../lib/composerReferences";

const isMention = (reference: ComposerReference): reference is ComposerReferenceMention =>
  typeof (reference as Partial<ComposerReferenceMention>).offset === "number";

/**
 * Texte d’un message envoyé dont les commandes, skills et fichiers cités s’affichent en pastilles, à leur position
 * (`offset`, dans le texte sans les pastilles), repris de `ReferencePills` de OneApp. Une référence sans position,
 * d’un message plus ancien, n’a pas de pastille.
 */
export function ReferencePills({
  text,
  references,
}: {
  text: string;
  references: readonly (ComposerReference | ComposerReferenceMention)[];
}) {
  const mentions = references.filter(isMention);
  if (!mentions.length) return <span className="reference-text">{text}</span>;
  const ordered = mentions
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => left.reference.offset - right.reference.offset || left.index - right.index);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const { reference } of ordered) {
    const offset = Math.max(cursor, Math.min(text.length, reference.offset));
    if (offset > cursor) content.push(text.slice(cursor, offset));
    content.push(
      <span className="agent-chat__reference-pill" key={reference.id} title={reference.description}>
        {referenceDisplayName(reference)}
      </span>,
    );
    cursor = offset;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return <span className="reference-text">{content}</span>;
}
