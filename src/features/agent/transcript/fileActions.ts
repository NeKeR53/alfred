/**
 * Fichiers et images d’une conversation, repris de `agentConversationFiles` de OneApp : ouverture avec l’application
 * du système, copie enregistrée à l’emplacement choisi, lecture bornée pour l’aperçu d’un PDF.
 */
import { inTauri, invoke } from "../../../lib/native";
import { notify } from "../../../shell/notifications";
import { followLink } from "../files";
import { imageDataUrl } from "../lib/chatImages";
import { conversationFileName, conversationFilePath } from "../lib/conversationFileKinds";

function requireDesktop() {
  if (!inTauri) throw new Error("Les fichiers de l’agent s’ouvrent dans l’application de bureau.");
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Contenu d’un document de l’agent, lu par Rust (20 Mo au plus). */
export async function readConversationFile(cwd: string, reference: string): Promise<Uint8Array> {
  const file = await invoke<{ base64: string }>("files.read", {
    path: conversationFilePath(reference),
    base: cwd || undefined,
  });
  return bytesOf(file.base64);
}

/** Nom proposé pour la copie : celui du fichier, ou `image.png` pour une image en ligne. */
export function suggestedCopyName(reference: string): string {
  const inline = imageDataUrl(reference);
  if (!inline) return conversationFileName(reference);
  const extension = /^data:image\/([a-z]+)/.exec(inline)?.[1]?.replace("jpeg", "jpg") ?? "png";
  return `image.${extension}`;
}

/**
 * Enregistre une copie du document ou de l’image à l’emplacement choisi dans la boîte de dialogue du système.
 * Renvoie `false` quand l’utilisateur annule.
 */
export async function saveConversationFile(cwd: string, reference: string): Promise<boolean> {
  requireDesktop();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const destination = await save({ title: "Enregistrer une copie", defaultPath: suggestedCopyName(reference) });
  if (!destination) return false;
  const inline = imageDataUrl(reference);
  await invoke(
    "files.saveCopy",
    inline
      ? { destination, base64: inline.split(",")[1] ?? "" }
      : { destination, path: conversationFilePath(reference), base: cwd || undefined },
  );
  return true;
}

/** Actions des cartes de fichiers, avec leur notification d’échec ou de réussite. */
export function conversationFileActions(cwd: string) {
  const failure = (title: string) => (error: unknown) =>
    notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
  return {
    open: (reference: string) => void followLink(conversationFilePath(reference), cwd),
    save: (reference: string) =>
      void saveConversationFile(cwd, reference).then(
        (saved) =>
          saved && notify({ title: "Copie enregistrée", description: "Le fichier a été enregistré.", tone: "success" }),
        failure("Enregistrement impossible"),
      ),
    read: (reference: string) => readConversationFile(cwd, reference),
  };
}

export type ConversationFileActions = ReturnType<typeof conversationFileActions>;
