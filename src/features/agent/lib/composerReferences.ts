/**
 * Références de la saisie, reprises de OneApp (`composerReferences.ts`, `composerReferenceCatalog.ts`) : `/` appelle
 * une commande ou un skill du harnais de la conversation, `$` un skill seul, `@` cite un fichier ou un dossier du
 * dossier de travail. La référence choisie devient une pastille à sa position dans le texte (`offset`) ; le chemin
 * exact part avec le message, en consigne pour l’agent, l’interface n’affichant que le nom.
 */

import type { MentionReference } from "socle-ui";
import { invoke } from "../../../lib/native";
import type { Provider } from "../harness";

export type ReferenceKind = "file" | "skill" | "command";
export interface ComposerReference {
  name: string;
  path: string;
  kind: ReferenceKind;
  description?: string;
}
/** Référence placée dans le texte : `offset` est sa position, en caractères, dans le texte sans les pastilles. */
export type ComposerReferenceMention = ComposerReference & { id: string; offset: number };
export interface ReferenceQuery {
  /** `file` pour `@`, `skill` pour `$`, `command` pour `/` (commandes et skills). */
  kind: ReferenceKind;
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

/** Mot en cours de frappe juste avant le curseur, s’il commence par `@`, `$` ou `/` (en début de mot). */
export function referenceQuery(text: string, cursor: number): ReferenceQuery | undefined {
  const match = /(?:^|\s)([@$/])([^\s]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  return {
    kind: match[1] === "@" ? "file" : match[1] === "$" ? "skill" : "command",
    query: match[2],
    start: cursor - match[2].length - 1,
    end: cursor,
  };
}

/** Nom affiché dans la pastille : le dernier segment d’un chemin, le nom d’une commande ou d’un skill. */
export function referenceDisplayName(item: ComposerReference): string {
  return item.kind === "file" ? item.name.replace(/\/$/, "").split(/[\\/]/).at(-1) || item.name : item.name;
}

/** Retire le mot en cours (`@not`, `/pub`) : la pastille prend sa place. */
export function removeReferenceQuery(text: string, query: ReferenceQuery) {
  return { text: text.slice(0, query.start) + text.slice(query.end), cursor: query.start };
}

/**
 * Décale les pastilles après le remplacement de `start`–`end` par `replacementLength` caractères : celles d’avant ne
 * bougent pas, celles d’après suivent, celles du passage remplacé se posent à sa fin.
 */
export function replaceComposerRange(
  references: readonly ComposerReferenceMention[],
  start: number,
  end: number,
  replacementLength = 0,
): ComposerReferenceMention[] {
  const delta = replacementLength - (end - start);
  return references.map((reference) => ({
    ...reference,
    offset:
      reference.offset <= start
        ? reference.offset
        : reference.offset >= end
          ? reference.offset + delta
          : start + replacementLength,
  }));
}

/** Positions des pastilles dans le texte rogné (`text.trim()`) qui part avec le message. */
export function trimComposerReferences(
  text: string,
  references: readonly ComposerReferenceMention[],
): ComposerReferenceMention[] {
  const leading = text.length - text.trimStart().length;
  const length = text.trim().length;
  return references.map((reference) => ({
    ...reference,
    offset: Math.max(0, Math.min(length, reference.offset - leading)),
  }));
}

/** Consignes réservées à l’agent : l’interface n’affiche que le nom de la référence. */
export function referenceInstructions(items: readonly ComposerReference[]): string {
  return items
    .map((item) =>
      item.kind === "file"
        ? `Fichier ou dossier référencé : @${JSON.stringify(item.path)}`
        : item.kind === "skill"
          ? `Utilise le skill $${item.name}.`
          : `Applique la commande /${item.name} définie dans ${JSON.stringify(item.path)}.`,
    )
    .join("\n");
}

function validReference(raw: unknown): raw is ComposerReference {
  if (!raw || typeof raw !== "object") return false;
  const item = raw as Partial<ComposerReference>;
  return (
    typeof item.name === "string" &&
    Boolean(item.name.trim()) &&
    typeof item.path === "string" &&
    Boolean(item.path.trim()) &&
    ["file", "skill", "command"].includes(String(item.kind)) &&
    (item.description === undefined || typeof item.description === "string")
  );
}

/** Relit des références venues d’un message enregistré : champs connus, chemins non vides, 50 au plus. */
export function validReferences(value: unknown): ComposerReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).filter(validReference);
}

/** Références placées d’un brouillon enregistré : 50 au plus, chacune avec son identifiant et sa position. */
export function validComposerReferenceMentions(value: unknown): value is ComposerReferenceMention[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((raw) => {
      if (!validReference(raw)) return false;
      const item = raw as Partial<ComposerReferenceMention>;
      return (
        typeof item.id === "string" && Boolean(item.id) && Number.isInteger(item.offset) && Number(item.offset) >= 0
      );
    })
  );
}

/** Catalogues gardés 30 s par harnais et dossier : `/` et `$` ne relisent pas le disque à chaque lettre. */
const catalogs = new Map<string, { expires: number; result: Promise<ComposerReference[]> }>();

function cached(key: string, load: () => Promise<ComposerReference[]>): Promise<ComposerReference[]> {
  let entry = catalogs.get(key);
  if (!entry || entry.expires < Date.now()) {
    const result = load();
    entry = { result, expires: Date.now() + 30_000 };
    if (catalogs.size >= 20) catalogs.clear();
    catalogs.set(key, entry);
    void result.catch(() => {
      if (catalogs.get(key)?.result === result) catalogs.delete(key);
    });
  }
  return entry.result;
}

/**
 * Skills que Codex propose vraiment, comme OneApp : Rust interroge `codex app-server` (`skills/list`), qui répond
 * avec les skills de son dossier et de son compte. Les skills désactivés sont écartés.
 */
export function codexSkills(cwd: string): Promise<ComposerReference[]> {
  return invoke<ComposerReference[]>("agents.skills", { cwd });
}

function skillCatalog(cwd: string, provider: Provider): Promise<ComposerReference[]> {
  return cached(`skill\n${provider}\n${cwd}`, () =>
    provider === "codex"
      ? codexSkills(cwd)
      : invoke<ComposerReference[]>("composer.references", { cwd, provider, kind: "skill", query: "" }),
  );
}

function commandCatalog(cwd: string, provider: Provider): Promise<ComposerReference[]> {
  return cached(`command\n${provider}\n${cwd}`, () =>
    invoke<ComposerReference[]>("composer.references", { cwd, provider, kind: "command", query: "" }),
  );
}

export async function loadComposerReferences(
  cwd: string,
  provider: Provider,
  kind: ReferenceKind,
  query: string,
): Promise<ComposerReference[]> {
  if (kind === "file") return invoke<ComposerReference[]>("composer.references", { cwd, provider, kind, query });
  const limit = query ? 50 : Number.POSITIVE_INFINITY;
  if (kind === "skill") return filterComposerReferences(await skillCatalog(cwd, provider), query, limit);
  const [commands, skills] = await Promise.all([commandCatalog(cwd, provider), skillCatalog(cwd, provider)]);
  return filterComposerReferences([...commands, ...skills], query, limit);
}

/** Pour les tests : oublie les catalogues gardés. */
export function clearReferenceCatalogs() {
  catalogs.clear();
}

/** Caractère qui cite chaque sorte de référence, comme dans la saisie : `@` un fichier, `$` un skill, `/` une commande. */
export const REFERENCE_TRIGGER: Record<ReferenceKind, string> = { file: "@", skill: "$", command: "/" };

/**
 * Pastilles d’un texte pour `MentionText` et `MessageQueue` de Socle : seules les références placées (`offset`) en ont
 * une ; une référence sans position, d’un message plus ancien, reste hors du texte.
 */
export function mentionReferences(
  references: readonly (ComposerReference | ComposerReferenceMention)[],
): MentionReference[] {
  return references.flatMap((reference, index) =>
    typeof (reference as Partial<ComposerReferenceMention>).offset === "number"
      ? [
          {
            key: `${(reference as ComposerReferenceMention).id}:${index}`,
            trigger: REFERENCE_TRIGGER[reference.kind],
            id: reference.path,
            label: referenceDisplayName(reference),
            offset: (reference as ComposerReferenceMention).offset,
          },
        ]
      : [],
  );
}
