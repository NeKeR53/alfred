/** Les chemins affichés dans une conversation restent limités à des références de fichiers. */
export function isAgentFileReference(value: string): boolean {
  const text = value.trim();
  if (!text || [...text].some((character) => character.charCodeAt(0) < 32)) return false;
  if (/^file:\/\//i.test(text)) return true;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return false;
  const path = text.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/(?::\d+){1,2}$/, "");
  return /\.[a-z0-9]{1,12}$/i.test(path);
}

export function normalizeAgentFileReference(value: string): string {
  if (/^file:\/\//i.test(value)) return value;
  const withoutAnchor = value.replace(/#L\d+(?:-L?\d+)?$/i, "");
  try {
    return decodeURIComponent(withoutAnchor);
  } catch {
    return withoutAnchor;
  }
}

const codeFence = /```[\s\S]*?```/g;
const markdownLinkTarget = /\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
const inlineCode = /`([^`\n]+)`/g;

/**
 * Chemins de fichiers cités dans le texte d’un agent, dans l’ordre et sans doublon. La cible d’un lien Markdown et un
 * code inline sont repris en entier, espaces et encodage compris ; dans le texte libre, un chemin s’arrête au premier
 * espace. Un `~` est admis dans un dossier, comme dans les noms courts de Windows (`ALEXAN~1`). `extensions` est une alternative d’extensions pour une expression régulière, par exemple `pdf|docx`.
 */
export function citedLocalPaths(content: string, extensions: string): string[] {
  const explicit = new RegExp(`\\.(?:${extensions})(?:#L\\d+(?:-L?\\d+)?|(?::\\d+){1,2})?$`, "i");
  const found: { index: number; reference: string }[] = [];
  const keep = (index: number, reference: string) => {
    if (isAgentFileReference(reference) && explicit.test(reference)) found.push({ index, reference });
  };
  const blank = (match: string) => " ".repeat(match.length);
  let text = content.replace(codeFence, blank).replace(markdownLinkTarget, (match, target: string, index: number) => {
    keep(index, target.replace(/^<|>$/g, "").trim());
    return blank(match);
  });
  text = text.replace(inlineCode, (match, code: string, index: number) => {
    const reference = code.trim();
    if (!(isAgentFileReference(reference) && explicit.test(reference))) return match;
    keep(index, reference);
    return blank(match);
  });
  const plain = new RegExp(
    `(?<![\\p{L}\\p{N}_:/~\\\\])(?:file://\\S+|(?:[A-Za-z]:[\\\\/]|~?/|\\.{1,2}/)?(?:[\\p{L}\\p{N}_@+.~-]+[\\\\/])*[\\p{L}\\p{N}_@+-][\\p{L}\\p{N}_@+.-]*\\.(?:${extensions}))`,
    "giu",
  );
  for (const match of text.matchAll(plain)) keep(match.index, match[0].replace(/[`*_)\].,;:!?]+$/, ""));
  return [...new Set(found.sort((left, right) => left.index - right.index).map(({ reference }) => reference))];
}

/** Préfixe des liens de fichier : une ancre, que le Markdown garde telle quelle, même pour un chemin Windows (`C:\\`). */
const FILE_LINK = "#fichier:";

const fileLink = (path: string) => `${FILE_LINK}${encodeURIComponent(path)}`;

/** Chemin d’un lien posé par `linkAgentFiles`, ou d’un lien Markdown qui vise déjà un fichier. */
export function fileFromLink(href: string): string | undefined {
  if (href.startsWith(FILE_LINK)) {
    try {
      return decodeURIComponent(href.slice(FILE_LINK.length));
    } catch {
      return undefined;
    }
  }
  return isAgentFileReference(href) ? href : undefined;
}

const filePattern =
  /(?<![\p{L}\p{N}_:/~])(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?(?:[\p{L}\p{N}_@+.-]+[\\/])*[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.(?:md|txt|tsx?|jsx?|css|html?|json|ya?ml|toml|rs|py|java|kt|cs|go|sh|ps1|sql|xml|csv|pdf|png|jpe?g|svg|lock)(?::\d+(?::\d+)?)?/giu;

/** Lien Markdown ou image, code inline, lien automatique `<…>`, adresse web : laissés tels quels, sauf leur cible. */
const protectedPart =
  /(!?)\[((?:[^\]\\\n]|\\.)*)\]\(\s*(<[^>\n]*>|[^\s)]*)((?:\s+"[^"]*")?\s*)\)|(`+)([^`][\s\S]*?)\5(?!`)|<[^>\n]+>|\b(?:https?:\/\/|mailto:|www\.)\S+/g;

const escapeLabel = (text: string) => text.replace(/[\\`*_[\]<>]/g, (character) => `\\${character}`);

function linkPlainText(text: string): string {
  return text.replace(filePattern, (match) => `[${escapeLabel(match)}](${fileLink(match)})`);
}

function linkSegment(text: string): string {
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(protectedPart)) {
    result += linkPlainText(text.slice(offset, match.index));
    offset = match.index + match[0].length;
    const [whole, bang, label, target, title, ticks, code] = match;
    if (target !== undefined && !bang) {
      const destination = target.replace(/^<|>$/g, "").trim();
      result += isAgentFileReference(destination) ? `[${label}](${fileLink(destination)}${title})` : whole;
    } else if (ticks && code !== undefined && isAgentFileReference(code.trim())) {
      result += `[${whole}](${fileLink(code.trim())})`;
    } else result += whole;
  }
  return result + linkPlainText(text.slice(offset));
}

/**
 * Relie les noms de fichiers écrits en texte ou en code inline, et les liens Markdown qui visent un fichier, sans
 * modifier les blocs de code ni les autres liens. Le lien posé se lit avec `fileFromLink`.
 */
export function linkAgentFiles(markdown: string): string {
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1?\2[`~]*[ \t]*(?=\n|$)|$)/gm;
  let result = "";
  let offset = 0;
  for (const match of markdown.matchAll(fence)) {
    result += linkSegment(markdown.slice(offset, match.index));
    result += match[0];
    offset = match.index + match[0].length;
  }
  return result + linkSegment(markdown.slice(offset));
}
