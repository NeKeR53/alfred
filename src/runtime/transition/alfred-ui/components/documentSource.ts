/** Ce que `DocumentViewer` sait afficher. */
export type DocumentFormat = "pdf" | "image" | "text" | "markdown";

/** Source d’un document : un fichier du module, une adresse `data:`/`blob:`, ou un `Blob` (un `File` déposé). */
export type DocumentSource = { file: string } | { src: string } | { blob: Blob };

/** Document lu, prêt à être affiché. */
export type LoadedDocument =
  | { format: "pdf"; name: string; mime: string; bytes: Uint8Array }
  | { format: "image"; name: string; mime: string; url: string }
  | { format: "text" | "markdown"; name: string; mime: string; text: string }
  | { format: null; name: string; mime: string };

const extensions: Record<string, DocumentFormat> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  ini: "text",
  toml: "text",
};

const textTypes = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml"]);

/** Format d’après le type MIME, puis l’extension du nom ; `null` quand Alfred ne sait pas l’afficher. */
export function detectFormat(mime: string | undefined, name: string | undefined): DocumentFormat | null {
  const type = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  const extension = name?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  const byName = extension ? extensions[extension] : undefined;
  if (byName) return byName;
  if (type.startsWith("text/") || textTypes.has(type)) return "text";
  return null;
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Lit une adresse `data:` sans `fetch`, que le cadre d’une page refuse. */
export function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } {
  const match = url.match(/^data:([^,]*),(.*)$/s);
  if (!match) throw new Error("Adresse data: mal formée.");
  const meta = match[1].split(";");
  const mime = meta[0] || "text/plain";
  const base64 = meta.slice(1).some((part) => part.toLowerCase() === "base64");
  const bytes = base64 ? base64Bytes(match[2]) : new TextEncoder().encode(decodeURIComponent(match[2]));
  return { mime, bytes };
}

function finish(
  format: DocumentFormat | null,
  name: string,
  mime: string,
  bytes: () => Uint8Array,
  url: () => string,
): LoadedDocument {
  if (format === "pdf") return { format, name, mime, bytes: bytes() };
  if (format === "image") return { format, name, mime, url: url() };
  if (format === "text" || format === "markdown")
    return { format, name, mime, text: new TextDecoder("utf-8").decode(bytes()) };
  return { format: null, name, mime };
}

/**
 * Lit la source. `readFile` est le service de la page (`files.read`) ; `track` reçoit les adresses `blob:` créées ici,
 * que l’appelant libère quand le document n’est plus affiché.
 */
export async function loadDocument(
  source: DocumentSource,
  options: {
    name?: string;
    type?: string;
    readFile?: (id: string) => Promise<{ name: string; mime: string; data: string }>;
    track: (url: string) => void;
  },
): Promise<LoadedDocument> {
  if ("file" in source) {
    if (!options.readFile) throw new Error("Les fichiers du module ne s’affichent que dans une page d’Alfred.");
    const file = await options.readFile(source.file);
    const name = options.name ?? file.name;
    const mime = options.type ?? file.mime;
    return finish(
      detectFormat(mime, name),
      name,
      mime,
      () => base64Bytes(file.data),
      () => `data:${mime};base64,${file.data}`,
    );
  }
  if ("blob" in source) {
    const blob = source.blob;
    const name = options.name ?? (blob as Partial<File>).name ?? "";
    const mime = options.type ?? blob.type;
    const format = detectFormat(mime, name);
    const bytes =
      format === "pdf" || format === "text" || format === "markdown"
        ? new Uint8Array(await blob.arrayBuffer())
        : undefined;
    return finish(
      format,
      name,
      mime,
      () => bytes ?? new Uint8Array(),
      () => {
        const url = URL.createObjectURL(blob);
        options.track(url);
        return url;
      },
    );
  }
  const { src } = source;
  const name = options.name ?? "";
  if (/^data:/i.test(src)) {
    const parsed = parseDataUrl(src);
    const mime = options.type ?? parsed.mime;
    return finish(
      detectFormat(mime, name),
      name,
      mime,
      () => parsed.bytes,
      () => src,
    );
  }
  if (/^blob:/i.test(src)) {
    const known = detectFormat(options.type, name);
    // Une image s’affiche par son adresse ; le reste doit être lu, ce que le cadre d’une page refuse (`connect-src`).
    if (known === "image") return { format: known, name, mime: options.type ?? "", url: src };
    let blob: Blob;
    try {
      blob = await (await fetch(src)).blob();
    } catch {
      throw new Error("Une adresse blob: ne se lit pas dans une page : passez le Blob lui-même (prop blob).");
    }
    return loadDocument({ blob }, { ...options, type: options.type ?? (blob.type || undefined) });
  }
  throw new Error("Seuls un fichier du module, une adresse data: ou blob:, ou un Blob s’affichent.");
}
