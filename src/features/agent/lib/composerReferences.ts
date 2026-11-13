/**
 * Références de la saisie, reprises de OneApp (`composerReferences.ts`) : `/` appelle une commande ou un skill du
 * harnais de la conversation, `@` cite un fichier ou un dossier du dossier de travail. La référence choisie reste
 * visible dans le texte (`/publier`, `@src/page.tsx`) ; le chemin exact part avec le message, en consigne pour
 * l’agent, tant que sa mention est toujours dans le texte.
 */

import { invoke } from "../../../lib/native";
import type { Provider } from "../harness";

export type ReferenceKind = "file" | "skill" | "command";
export interface ComposerReference {
  name: string;
  path: string;
  kind: ReferenceKind;
  description?: string;
}
export interface ReferenceQuery {
  /** `file` pour `@`, `command` pour `/` (commandes et skills). */
  kind: "file" | "command";
  query: string;
  start: number;
  end: number;
}

const normalizeSearch = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Les noms passent avant les descriptions ; une abréviation ou une lettre de travers trouvent encore. */
export function filterComposerReferences(items: ComposerReference[], query: string, limit = 50): ComposerReference[] {
  const needle = normalizeSearch(query).trim();
  const score = (item: ComposerReference) => {
    const name = normalizeSearch(item.name);
    if (!needle || name === needle) return 0;
    if (name.startsWith(needle)) return 10;
    const words = name.split(/[^a-z0-9]+/);
    if (words.some((word) => word.startsWith(needle))) return 20;
    if (name.includes(needle)) return 30;
    if (needle.length >= 3) {
      // Distance d’édition d’au plus un sur le début d’un mot : « creat » trouve « create ».
      for (const word of words) {
        const prefix = word.slice(0, needle.length);
        let previous = Array.from({ length: prefix.length + 1 }, (_, index) => index);
        for (let i = 1; i <= needle.length; i++) {
          const row = [i];
          for (let j = 1; j <= prefix.length; j++)
            row[j] = Math.min(
              row[j - 1] + 1,
              previous[j] + 1,
              previous[j - 1] + Number(needle[i - 1] !== prefix[j - 1]),
            );
          previous = row;
        }
        if (previous[prefix.length] <= 1) return 40;
      }
      let cursor = 0;
      for (const character of name) if (character === needle[cursor]) cursor++;
      if (cursor === needle.length) return 50;
    }
    if (normalizeSearch(item.description ?? "").includes(needle)) return 60;
    return Number.POSITIVE_INFINITY;
  };
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name, "fr"))
    .slice(0, limit)
    .map(({ item }) => item);
}

/** Mot en cours de frappe juste avant le curseur, s’il commence par `@` ou `/` (en début de mot). */
export function referenceQuery(text: string, cursor: number): ReferenceQuery | undefined {
  const match = /(?:^|\s)([@/])([^\s]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  return {
    kind: match[1] === "@" ? "file" : "command",
    query: match[2],
    start: cursor - match[2].length - 1,
    end: cursor,
  };
}

/** Ce que la saisie affiche pour la référence : `/nom` ou `@chemin/relatif`. */
export function mentionOf(item: ComposerReference): string {
  return item.kind === "file" ? `@${item.name.replace(/\/$/, "")}` : `/${item.name}`;
}

/** Remplace le mot en cours par la mention, suivie d’une espace ; renvoie le texte et la position du curseur. */
export function insertReference(text: string, query: ReferenceQuery, item: ComposerReference) {
  const mention = `${mentionOf(item)} `;
  const next = text.slice(0, query.start) + mention + text.slice(query.end).replace(/^ /, "");
  return { text: next, cursor: query.start + mention.length };
}

function mentioned(text: string, mention: string): boolean {
  let index = text.indexOf(mention);
  while (index !== -1) {
    const before = index === 0 || /\s/.test(text[index - 1] ?? "");
    const after = text[index + mention.length];
    if (before && (after === undefined || /\s|[.,;:!?)]/.test(after))) return true;
    index = text.indexOf(mention, index + 1);
  }
  return false;
}

/** Références dont la mention est encore dans le texte : effacer `@fichier` retire la référence. */
export function keptReferences(text: string, references: readonly ComposerReference[]): ComposerReference[] {
  const seen = new Set<string>();
  return references.filter((item) => {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key) || !mentioned(text, mentionOf(item))) return false;
    seen.add(key);
    return true;
  });
}

/** Consignes ajoutées au message pour l’agent ; l’interface n’affiche que la mention. */
export function referenceInstructions(items: readonly ComposerReference[]): string {
  return items
    .map((item) =>
      item.kind === "file"
        ? `Fichier ou dossier cité (${mentionOf(item)}) : ${JSON.stringify(item.path)}`
        : item.kind === "skill"
          ? `Utilise le skill « ${item.name} » (${JSON.stringify(item.path)}).`
          : `Applique la commande /${item.name} définie dans ${JSON.stringify(item.path)}.`,
    )
    .join("\n");
}

/** Relit des références venues d’un message enregistré : champs connus, chemins non vides, 50 au plus. */
export function validReferences(value: unknown): ComposerReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 50)
    .filter(
      (raw): raw is ComposerReference =>
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as ComposerReference).name === "string" &&
        typeof (raw as ComposerReference).path === "string" &&
        Boolean((raw as ComposerReference).path.trim()) &&
        ["file", "skill", "command"].includes(String((raw as ComposerReference).kind)),
    );
}

/** Catalogue des commandes et skills, gardé 30 s par harnais et dossier : `/` ne relit pas le disque à chaque lettre. */
const catalogs = new Map<string, { expires: number; result: Promise<ComposerReference[]> }>();

export async function loadComposerReferences(
  cwd: string,
  provider: Provider,
  kind: "file" | "command",
  query: string,
): Promise<ComposerReference[]> {
  if (kind === "file") return invoke<ComposerReference[]>("composer.references", { cwd, provider, kind, query });
  const key = `${provider}\n${cwd}`;
  let cached = catalogs.get(key);
  if (!cached || cached.expires < Date.now()) {
    const result = invoke<ComposerReference[]>("composer.references", { cwd, provider, kind, query: "" });
    cached = { result, expires: Date.now() + 30_000 };
    if (catalogs.size >= 20) catalogs.clear();
    catalogs.set(key, cached);
    void result.catch(() => {
      if (catalogs.get(key)?.result === result) catalogs.delete(key);
    });
  }
  return filterComposerReferences(await cached.result, query, query ? 50 : 200);
}

/** Pour les tests : oublie les catalogues gardés. */
export function clearReferenceCatalogs() {
  catalogs.clear();
}
