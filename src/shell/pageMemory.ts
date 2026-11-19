import { invoke } from "../lib/native";

/**
 * Ce que chaque page a demandé à retenir (`usePageState` : recherche, filtres, vue, ligne ouverte), gardé par la
 * coquille tant qu’Alfred est ouvert : le cadre d’une page est détruit quand on la quitte, et il n’a pas de stockage
 * à lui. Une valeur trop grosse n’est pas gardée : ce n’est pas un lieu pour des données.
 *
 * Les clés qui commencent par `alfred.` sont réservées aux gabarits (ordre et repli des sections d’un panneau) : elles
 * sont aussi enregistrées sur le poste et survivent à la fermeture d’Alfred.
 */
const memory = new Map<string, Record<string, unknown>>();
const MAX_VALUE = 20_000;
const DURABLE_PREFIX = "alfred.";
const SETTING = "shell.pageLayouts";

type Stored = Record<string, Record<string, unknown>>;
interface DurableStore {
  load(): Promise<unknown>;
  save(value: Stored): Promise<unknown>;
}
const settingsStore: DurableStore = {
  load: () => invoke("settings.get", { key: SETTING }),
  save: (value) => invoke("settings.set", { key: SETTING, value }),
};
let store: DurableStore = settingsStore;
let loaded: Promise<void> | undefined;
let pendingSave: ReturnType<typeof setTimeout> | undefined;

export const isDurablePageKey = (key: string) => key.startsWith(DURABLE_PREFIX);

/** Reprend une fois les valeurs durables enregistrées ; une valeur déjà retenue pendant la session l’emporte. */
export function loadDurablePageMemory(): Promise<void> {
  loaded ??= store
    .load()
    .then((stored) => {
      if (!stored || typeof stored !== "object") return;
      for (const [reference, values] of Object.entries(stored as Stored)) {
        if (!values || typeof values !== "object") continue;
        const durable = Object.fromEntries(Object.entries(values).filter(([key]) => isDurablePageKey(key)));
        memory.set(reference, { ...durable, ...(memory.get(reference) ?? {}) });
      }
    })
    .catch(() => undefined);
  return loaded;
}

function durableSnapshot(): Stored {
  const all: Stored = {};
  for (const [reference, values] of memory) {
    const durable = Object.entries(values).filter(([key]) => isDurablePageKey(key));
    if (durable.length) all[reference] = Object.fromEntries(durable);
  }
  return all;
}

function scheduleSave() {
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    // Jamais avant d’avoir repris l’enregistré : on l’écraserait.
    void loadDurablePageMemory()
      .then(() => store.save(durableSnapshot()))
      .catch(() => undefined);
  }, 250);
}

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
  if (isDurablePageKey(key)) scheduleSave();
}

/** Pour les tests : vide la mémoire et, au besoin, remplace l’enregistrement sur le poste. */
export function clearPageMemory(durable?: DurableStore) {
  memory.clear();
  loaded = undefined;
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = undefined;
  store = durable ?? settingsStore;
}
