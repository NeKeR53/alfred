/**
 * Recherche dans du texte, comme dans OneApp : sans casse ni accents, et chaque mot tapé doit apparaître. « eleve
 * paris » trouve « Élève inscrit à Paris ». Partagée par le SDK des pages et par la coquille.
 */

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");

/** Mots d’une recherche, sans casse ni accents ; vide quand il n’y a rien à chercher. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

const text = (field: unknown): string =>
  field === null || field === undefined || field === false
    ? ""
    : Array.isArray(field)
      ? field.map(text).join("\n")
      : String(field);

/**
 * Vrai quand chaque mot de la recherche apparaît dans au moins un des champs (textes, nombres, listes ; `null` et
 * `undefined` sont ignorés). `search` est le texte tapé ou ses mots (`searchTerms`). Une recherche vide trouve tout.
 */
export function matchesSearch(search: string | readonly string[], fields: readonly unknown[]): boolean {
  const terms = typeof search === "string" ? searchTerms(search) : search;
  if (!terms.length) return true;
  const haystack = fold(fields.map(text).join("\n"));
  return terms.every((term) => haystack.includes(term));
}
