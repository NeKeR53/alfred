type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

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

/** Relie les noms de fichiers écrits en texte ou en code inline, sans modifier les blocs de code ni les liens existants. */
export function agentFileLinks() {
  const filePattern =
    /(?<![\p{L}\p{N}_:/~])(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?(?:[\p{L}\p{N}_@+.-]+[\\/])*[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.(?:md|txt|tsx?|jsx?|css|html?|json|ya?ml|toml|rs|py|java|kt|cs|go|sh|ps1|sql|xml|csv|pdf|png|jpe?g|svg|lock)(?::\d+(?::\d+)?)?/giu;
  const walk = (node: MarkdownNode) => {
    if (!node.children || ["link", "linkReference", "code", "image", "html"].includes(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "inlineCode" && child.value && isAgentFileReference(child.value))
        return [{ type: "link", url: child.value, children: [child] }];
      if (child.type === "text" && child.value) {
        const text = child.value;
        const pieces: MarkdownNode[] = [];
        let offset = 0;
        for (const match of text.matchAll(filePattern)) {
          const index = match.index;
          if (index > offset) pieces.push({ type: "text", value: text.slice(offset, index) });
          pieces.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0] }] });
          offset = index + match[0].length;
        }
        if (offset) {
          if (offset < text.length) pieces.push({ type: "text", value: text.slice(offset) });
          return pieces;
        }
      }
      walk(child);
      return [child];
    });
  };
  return (tree: unknown) => walk(tree as MarkdownNode);
}
