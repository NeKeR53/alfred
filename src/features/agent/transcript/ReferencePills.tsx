import type { ReactNode } from "react";
import { type ComposerReference, mentionOf } from "../lib/composerReferences";

/** Nom court d’une référence : le nom du fichier, ou celui de la commande ou du skill. Repris de OneApp. */
export function referenceDisplayName(item: ComposerReference): string {
  return item.kind === "file" ? item.name.replace(/\/$/, "").split(/[\\/]/).at(-1) || item.name : item.name;
}

type Piece = { start: number; end: number; reference: ComposerReference };

/** Mentions des références dans le texte, dans l’ordre, en début de mot et sans chevauchement. */
export function referenceMentions(text: string, references: readonly ComposerReference[]): Piece[] {
  const pieces: Piece[] = [];
  for (const reference of references) {
    const mention = mentionOf(reference);
    let index = text.indexOf(mention);
    while (index !== -1) {
      const before = index === 0 || /\s/.test(text[index - 1] ?? "");
      const after = text[index + mention.length];
      if (before && (after === undefined || /\s|[.,;:!?)]/.test(after)))
        pieces.push({ start: index, end: index + mention.length, reference });
      index = text.indexOf(mention, index + 1);
    }
  }
  pieces.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: Piece[] = [];
  for (const piece of pieces) if (!kept.length || piece.start >= (kept.at(-1)?.end ?? 0)) kept.push(piece);
  return kept;
}

/**
 * Texte d’un message envoyé dont les commandes, skills et fichiers cités s’affichent en pastilles, repris de
 * `ReferencePills` de OneApp.
 */
export function ReferencePills({ text, references }: { text: string; references: readonly ComposerReference[] }) {
  const pieces = referenceMentions(text, references);
  if (!pieces.length) return <span className="reference-text">{text}</span>;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, reference } of pieces) {
    if (start > cursor) content.push(text.slice(cursor, start));
    content.push(
      <span className="agent-chat__reference-pill" key={`${start}:${reference.path}`} title={reference.path}>
        {referenceDisplayName(reference)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return <span className="reference-text">{content}</span>;
}
