/** Fichiers échangés avec un agent : joindre (boîte de dialogue, dépôt, collage) et ouvrir ce qu’il cite. */
import { inTauri, invoke, openExternal } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { isAgentFileReference } from "./lib/agentFileLinks";
import type { Attachment } from "./model";

/** Comme OneApp : 16 pièces jointes au plus par message, 20 Mo chacune. */
export const MAX_ATTACHMENTS = 16;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_LIMIT_MESSAGE = "Joignez au plus 16 fichiers de 20 Mo chacun.";
/** Une vignette plus lourde que 2 Mo n’est pas gardée : le nom du fichier suffit. */
const MAX_PREVIEW_LENGTH = 2 * 1024 * 1024;

/** Refuse un lot qui dépasse les limites, avant toute copie. */
export function checkAttachmentLimits(files: readonly { size: number | null }[]) {
  if (files.length > MAX_ATTACHMENTS || files.some((file) => (file.size ?? 0) > MAX_ATTACHMENT_BYTES))
    throw new Error(ATTACHMENT_LIMIT_MESSAGE);
}

/** Pièce jointe de la saisie, avec la vignette d’une image. */
export type PreparedAttachment = Attachment & { preview?: string };

/** Vignette WebP d’une image, réduite à 1 600 px de côté, comme OneApp ; `undefined` si elle n’a pas pu être faite. */
export async function imagePreview(blob: Blob): Promise<string | undefined> {
  if (blob.size > MAX_ATTACHMENT_BYTES || typeof createImageBitmap !== "function") return undefined;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/webp", 0.85);
    return url.length <= MAX_PREVIEW_LENGTH && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/.test(url)
      ? url
      : undefined;
  } finally {
    bitmap.close();
  }
}

/** Ajoute la vignette des images qui n’en ont pas ; une image illisible garde son nom seul. */
export async function prepareAttachments(attachments: PreparedAttachment[]): Promise<PreparedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.preview || !isImage(attachment.path) || /\.svg$/i.test(attachment.path)) return attachment;
      try {
        const dataUrl = await loadImage(attachment.path, "");
        const preview = await imagePreview(await (await fetch(dataUrl)).blob());
        return preview ? { ...attachment, preview } : attachment;
      } catch {
        return attachment;
      }
    }),
  );
}

interface FileStat {
  path: string;
  name: string | null;
  exists: boolean;
  isDirectory: boolean;
  size: number | null;
  mimeType: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Enregistre un contenu sans chemin (image collée, fichier déposé depuis le navigateur) dans le dossier d’échange. */
export async function saveBlob(conversation: string, file: File): Promise<PreparedAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
  const saved = await invoke<{ path: string; name: string }>("files.saveExchange", {
    conversation,
    name: file.name || `collage-${Date.now()}.png`,
    base64: toBase64(await file.arrayBuffer()),
  });
  const preview = file.type.startsWith("image/") ? await imagePreview(file).catch(() => undefined) : undefined;
  return { path: saved.path, name: saved.name, mimeType: file.type || undefined, ...(preview ? { preview } : {}) };
}

/** Enregistre plusieurs contenus d’un coup, après avoir vérifié les limites du lot. */
export async function saveBlobs(conversation: string, files: File[]): Promise<PreparedAttachment[]> {
  checkAttachmentLimits(files);
  return Promise.all(files.map((file) => saveBlob(conversation, file)));
}

export async function attachmentFromPath(path: string): Promise<Attachment | undefined> {
  const stat = await invoke<FileStat>("files.stat", { path });
  if (!stat.exists || stat.isDirectory) return undefined;
  return { path: stat.path, name: stat.name ?? path, mimeType: stat.mimeType };
}

/** Fichiers déposés depuis le système : 16 au plus, 20 Mo chacun, vignettes comprises. */
export async function attachmentsFromPaths(paths: readonly string[]): Promise<PreparedAttachment[]> {
  if (paths.length > MAX_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
  const stats = await Promise.all(paths.map((path) => invoke<FileStat>("files.stat", { path })));
  const files = stats.filter((stat) => stat.exists && !stat.isDirectory);
  checkAttachmentLimits(files);
  return prepareAttachments(
    files.map((stat) => ({ path: stat.path, name: stat.name ?? stat.path, mimeType: stat.mimeType })),
  );
}

/**
 * Fait choisir des fichiers à joindre ; hors de la fenêtre Tauri, l’appelant passe par un champ de fichier. Comme
 * OneApp, seuls les 16 premiers fichiers choisis sont gardés.
 */
export async function pickAttachments(): Promise<PreparedAttachment[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: true, title: "Joindre des fichiers" });
  const paths = (Array.isArray(selected) ? selected : selected ? [selected] : []).slice(0, MAX_ATTACHMENTS);
  const attachments = await Promise.all(paths.map((path) => attachmentFromPath(path)));
  return prepareAttachments(attachments.filter((attachment): attachment is Attachment => attachment !== undefined));
}

/** Suit un lien d’un message : une adresse web s’ouvre dans le navigateur, un fichier cité dans son application. */
export async function followLink(href: string, cwd: string) {
  try {
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) await openExternal(href);
    else if (isAgentFileReference(href)) await invoke("files.open", { path: href, base: cwd });
  } catch (error) {
    notify({
      title: "Ouverture impossible",
      description: error instanceof Error ? error.message : String(error),
      tone: "error",
    });
  }
}

export function isImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(path);
}

const imageCache = new Map<string, Promise<string>>();

/** Adresse `data:` d’une image locale citée par l’agent, lue par Rust. */
export function loadImage(path: string, cwd: string): Promise<string> {
  if (path.startsWith("data:image/")) return Promise.resolve(path);
  const key = `${cwd}\n${path}`;
  let loading = imageCache.get(key);
  if (!loading) {
    loading = invoke<{ dataUrl: string }>("files.readImage", { path, base: cwd }).then((result) => result.dataUrl);
    imageCache.set(key, loading);
    loading.catch(() => imageCache.delete(key));
  }
  return loading;
}
