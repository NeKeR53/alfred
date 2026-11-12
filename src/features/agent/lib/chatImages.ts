import { markdownUrl } from "./markdown";

export const maxImagePreviewLength = 2 * 1024 * 1024;

export function imageDataUrl(value: string): string | undefined {
  return value.length <= maxImagePreviewLength &&
    /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : undefined;
}

export function chatImageUrl(value: string): string | undefined {
  const data = imageDataUrl(value);
  if (data) return data;
  const url = markdownUrl(value);
  return url && /^https?:/.test(url) ? url : undefined;
}

export function imageFileType(name: string): string | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase();
  const types = new Map([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
  ]);
  return types.get(extension ?? "");
}

/** Extrait uniquement les blocs image des réponses MCP et des outils dynamiques. */
export function activityImageOutput(content: string): { text: string; images: string[] } {
  const images: string[] = [];
  const block = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const item = value as Record<string, unknown>;
    const source =
      item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string"
        ? imageDataUrl(`data:${item.mimeType};base64,${item.data}`)
        : item.type === "inputImage" && typeof item.imageUrl === "string"
          ? chatImageUrl(item.imageUrl)
          : undefined;
    if (!source) return value;
    images.push(source);
    return undefined;
  };
  try {
    const parsed: unknown = JSON.parse(content);
    let output: unknown = parsed;
    if (Array.isArray(parsed)) {
      const remaining = parsed.map(block).filter((item) => item !== undefined);
      output = remaining.length ? remaining : undefined;
    } else if (parsed && typeof parsed === "object" && "content" in parsed && Array.isArray(parsed.content)) {
      const remaining = parsed.content.map(block).filter((item) => item !== undefined);
      const { content: _content, ...metadata } = parsed;
      output = remaining.length
        ? { ...metadata, content: remaining }
        : Object.keys(metadata).length
          ? metadata
          : undefined;
    }
    return { text: images.length ? (output === undefined ? "" : JSON.stringify(output, null, 2)) : content, images };
  } catch {
    return { text: content, images };
  }
}
