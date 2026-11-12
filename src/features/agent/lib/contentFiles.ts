import { imageDataUrl, imageFileType } from "./chatImages";
import { isConversationDocument } from "./conversationFileKinds";

/** Chemin local d’une adresse `file://` ou d’un chemin brut. */
function localPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const path = decodeURIComponent(new URL(text).pathname);
      // file:///C:/… : le chemin Windows suit la barre initiale.
      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    } catch {
      return undefined;
    }
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[A-Za-z]:[\\/]/.test(text) ? undefined : text;
}

function imagePath(value: unknown): string | undefined {
  const path = localPath(value);
  return path && imageFileType(path.split(/[\\/]/).at(-1) ?? "") ? path : undefined;
}

function documentPath(value: unknown): string | undefined {
  const path = localPath(value);
  return path && isConversationDocument(path) ? path : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

type Found = { image?: string; file?: string };

/** Image ou document d’un bloc de contenu ACP ou MCP : image en ligne, ressource binaire ou lien vers un fichier. */
function blockFile(value: unknown): Found {
  const block = record(value);
  if (!block) return {};
  if (block.type === "image") {
    if (typeof block.data === "string" && typeof block.mimeType === "string")
      return { image: imageDataUrl(`data:${block.mimeType};base64,${block.data}`) };
    return { image: imagePath(block.uri) };
  }
  if (block.type === "resource_link") return { image: imagePath(block.uri), file: documentPath(block.uri) };
  if (block.type === "resource") {
    const resource = record(block.resource);
    if (resource && typeof resource.blob === "string" && typeof resource.mimeType === "string") {
      const inline = imageDataUrl(`data:${resource.mimeType};base64,${resource.blob}`);
      if (inline) return { image: inline };
    }
    return { image: imagePath(resource?.uri), file: documentPath(resource?.uri) };
  }
  return {};
}

const imagePlaceholder = "[image affichée ci-dessous]";
const filePlaceholder = "[fichier affiché ci-dessous]";

/**
 * Images et documents d’un contenu d’agent (ACP pour OpenCode, MCP pour les outils) : blocs du contenu, imbriqués
 * ou non dans un contenu d’outil, et fichiers touchés par l’outil. Le contenu renvoyé remplace les données binaires
 * par un repère, pour ne pas afficher de base64.
 */
export function contentFiles(
  content: unknown,
  locations?: unknown,
): { images: string[]; files: string[]; content: unknown } {
  const images: string[] = [];
  const files: string[] = [];
  const add = (list: string[], value: string | undefined) => {
    if (value && !list.includes(value) && list.length < 8) list.push(value);
  };
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    const block = record(value);
    if (!block) return value;
    const found = blockFile(block);
    add(images, found.image);
    add(files, found.file);
    if (found.image && (block.type === "image" || block.type === "resource")) return imagePlaceholder;
    if (found.file && block.type === "resource") return filePlaceholder;
    if (block.type === "content") return { ...block, content: strip(block.content) };
    if (Array.isArray(block.content)) return { ...block, content: strip(block.content) };
    return value;
  };
  const stripped = content === undefined ? undefined : strip(content);
  if (Array.isArray(locations))
    for (const location of locations) {
      const path = record(location)?.path;
      add(images, imagePath(path));
      add(files, documentPath(path));
    }
  return { images, files, content: stripped };
}
