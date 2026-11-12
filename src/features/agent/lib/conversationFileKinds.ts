import { citedLocalPaths, isAgentFileReference, normalizeAgentFileReference } from "./agentFileLinks";

/** Documents montrés en carte sous un message : ce que l’utilisateur ouvre ou enregistre, pas le code source. */
const documentExtensions = [
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "odt",
  "ods",
  "odp",
  "rtf",
  "csv",
  "tsv",
  "zip",
  "epub",
  "html",
  "svg",
  "mp4",
  "webm",
  "mp3",
  "wav",
];
const documentPattern = new RegExp(`\\.(?:${documentExtensions.join("|")})$`, "i");

export function conversationFilePath(reference: string) {
  return normalizeAgentFileReference(reference.trim()).replace(/(?::\d+){1,2}$/, "");
}

export function conversationFileName(reference: string) {
  return conversationFilePath(reference).split(/[\\/]/).at(-1) || reference;
}

export function isConversationDocument(reference: string): boolean {
  return isAgentFileReference(reference) && documentPattern.test(conversationFilePath(reference));
}

export function isPdfDocument(reference: string): boolean {
  return /\.pdf$/i.test(conversationFilePath(reference));
}

/** Documents cités par leur chemin dans le texte d’un agent, une seule fois chacun. */
export function referencedLocalFiles(content: string): string[] {
  return citedLocalPaths(content, documentExtensions.join("|")).filter(isConversationDocument).slice(0, 8);
}
