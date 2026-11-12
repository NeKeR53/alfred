/** Fichiers échangés avec un agent : joindre (boîte de dialogue, dépôt, collage) et ouvrir ce qu’il cite. */
import { inTauri, invoke, openExternal } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { isAgentFileReference } from "./lib/agentFileLinks";
import type { Attachment } from "./model";

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
export async function saveBlob(conversation: string, file: File): Promise<Attachment> {
  const saved = await invoke<{ path: string; name: string }>("files.saveExchange", {
    conversation,
    name: file.name || `collage-${Date.now()}.png`,
    base64: toBase64(await file.arrayBuffer()),
  });
  return { path: saved.path, name: saved.name, mimeType: file.type || undefined };
}

export async function attachmentFromPath(path: string): Promise<Attachment | undefined> {
  const stat = await invoke<FileStat>("files.stat", { path });
  if (!stat.exists || stat.isDirectory) return undefined;
  return { path: stat.path, name: stat.name ?? path, mimeType: stat.mimeType };
}

/** Fait choisir des fichiers à joindre ; hors de la fenêtre Tauri, l’appelant passe par un champ de fichier. */
export async function pickAttachments(): Promise<Attachment[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: true, title: "Joindre des fichiers" });
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
  const attachments = await Promise.all(paths.map((path) => attachmentFromPath(path)));
  return attachments.filter((attachment): attachment is Attachment => attachment !== undefined);
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
