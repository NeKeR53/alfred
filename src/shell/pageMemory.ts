/**
 * Ce que chaque page a demandé à retenir (`usePageState` : recherche, filtres, vue, ligne ouverte), gardé par la
 * coquille tant qu’Alfred est ouvert : le cadre d’une page est détruit quand on la quitte, et il n’a pas de stockage
 * à lui. Une valeur trop grosse n’est pas gardée : ce n’est pas un lieu pour des données.
 */
const memory = new Map<string, Record<string, unknown>>();
const MAX_VALUE = 20_000;

export function pageMemoryOf(reference: string): Record<string, unknown> {
  return { ...(memory.get(reference) ?? {}) };
}

export function rememberPageValue(reference: string, key: unknown, value: unknown) {
  if (typeof key !== "string" || !key || key.length > 200) throw new Error("Clé d’état de page invalide.");
  const kept = memory.get(reference) ?? {};
  if (value === undefined) {
    delete kept[key];
  } else {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_VALUE) {
      throw new Error(`L’état « ${key} » est trop gros pour être retenu (20 000 caractères au plus).`);
    }
    kept[key] = JSON.parse(text);
  }
  memory.set(reference, kept);
}

/** Pour les tests. */
export function clearPageMemory() {
  memory.clear();
}
