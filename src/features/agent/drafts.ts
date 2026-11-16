/**
 * Brouillons de la saisie, un par conversation, repris de OneApp (`useRecoverableDraft`, `draftsRepository`) : le
 * texte, ses pastilles de références, les pièces jointes et les collages restent d’une conversation à l’autre et
 * après un redémarrage. Ils s’enregistrent sous une seule clé des réglages, 750 ms après la dernière frappe.
 *
 * Un brouillon illisible n’est ni chargé ni écrasé : la saisie de sa conversation reste verrouillée jusqu’à
 * « Réessayer » ou « Supprimer le brouillon ». Une pièce jointe disparue du disque est retirée au chargement.
 */
import { create } from "zustand";
import { inTauri, invoke } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { MAX_ATTACHMENTS, type PreparedAttachment } from "./files";
import { type ComposerReferenceMention, validComposerReferenceMentions } from "./lib/composerReferences";
import type { Attachment, PastedContext } from "./model";

/** Pièce jointe de la saisie ; `preview` est la vignette d’une image, jamais enregistrée. */
export type DraftAttachment = PreparedAttachment;

export interface ComposerDraft {
  text: string;
  references: ComposerReferenceMention[];
  attachments: DraftAttachment[];
  /** Collages longs et blocs de contexte, en cartes au-dessus du texte. */
  pastes: PastedContext[];
}

export const blankDraft: ComposerDraft = { text: "", references: [], attachments: [], pastes: [] };

export const DRAFTS_KEY = "agents.drafts";

export function hasDraft(draft: ComposerDraft): boolean {
  return Boolean(draft.text.trim() || draft.references.length || draft.attachments.length || draft.pastes.length);
}

/** Forme enregistrée, versionnée ; les vignettes n’y figurent pas. */
export function serializeDraft(draft: ComposerDraft) {
  return {
    version: 1,
    text: draft.text,
    references: draft.references,
    attachments: draft.attachments.map(({ name, path, mimeType }) => ({
      name,
      path,
      ...(mimeType ? { mimeType } : {}),
    })),
    pastes: draft.pastes,
  };
}

/** Relit un brouillon enregistré ; une forme inattendue le rend illisible plutôt que de le deviner. */
export function parseDraft(value: unknown): ComposerDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Format de brouillon invalide.");
  const draft = value as Record<string, unknown>;
  if (
    draft.version !== 1 ||
    typeof draft.text !== "string" ||
    !validComposerReferenceMentions(draft.references) ||
    !Array.isArray(draft.attachments) ||
    draft.attachments.length > MAX_ATTACHMENTS ||
    !draft.attachments.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        typeof item.path === "string" &&
        (item.mimeType === undefined || typeof item.mimeType === "string"),
    ) ||
    !Array.isArray(draft.pastes) ||
    !draft.pastes.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.text === "string",
    )
  )
    throw new Error("Format de brouillon invalide.");
  return {
    text: draft.text,
    references: draft.references,
    attachments: draft.attachments as DraftAttachment[],
    pastes: draft.pastes as PastedContext[],
  };
}

interface DraftsState {
  drafts: Record<string, ComposerDraft>;
  ready: boolean;
  /** Les brouillons n’ont pas pu être lus : aucune saisie tant qu’un nouvel essai n’a pas réussi. */
  loadError: boolean;
  /** Conversations dont le brouillon enregistré est illisible. */
  unreadable: string[];
  load: () => Promise<void>;
  retry: () => Promise<void>;
  update: (id: string, change: (current: ComposerDraft) => ComposerDraft) => void;
  patch: (id: string, patch: Partial<ComposerDraft>) => void;
  clear: (id: string) => void;
  discardUnreadable: (id: string) => Promise<void>;
  /** Brouillon à cet instant, même si le rendu n’a pas encore suivi (frappe appliquée en transition). */
  read: (id: string) => ComposerDraft;
}

function failureMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

function reportSave(message: string) {
  notify({ title: "Brouillon non enregistré", description: message, tone: "error" });
}

/** Valeurs enregistrées illisibles, gardées telles quelles : une écriture ne les efface pas. */
let unreadableRaw: Record<string, unknown> = {};
/** Brouillons déposés avant le chargement (capture « Corriger un élément ») : appliqués dès qu’il a réussi. */
const seeds = new Map<string, (current: ComposerDraft) => ComposerDraft>();
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;
let loading: Promise<void> | undefined;

async function write(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  dirty = false;
  const { drafts } = useComposerDrafts.getState();
  const value: Record<string, unknown> = { ...unreadableRaw };
  for (const [id, draft] of Object.entries(drafts)) if (hasDraft(draft)) value[id] = serializeDraft(draft);
  const next = writing.catch(() => undefined).then(() => invoke<void>("settings.set", { key: DRAFTS_KEY, value }));
  writing = next;
  try {
    await next;
  } catch (error) {
    // Le prochain vidage réessaiera.
    dirty = true;
    reportSave(failureMessage(error, "Impossible d’enregistrer le brouillon."));
    throw error;
  }
}

function schedule() {
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void write().catch(() => undefined), 750);
}

/** Écrit tout de suite ce qui attend encore (fermeture de la fenêtre). */
export async function flushComposerDrafts(): Promise<void> {
  await write();
  await writing;
}

/** Pièces jointes encore présentes sur le disque ; les autres sont retirées et signalées. */
async function availableAttachments(draft: ComposerDraft): Promise<{ draft: ComposerDraft; missing: number }> {
  if (!inTauri || !draft.attachments.length) return { draft, missing: 0 };
  const available = await Promise.all(
    draft.attachments.map(async (attachment) => {
      try {
        const stat = await invoke<{ exists: boolean } | null>("files.stat", { path: attachment.path });
        return stat?.exists ? attachment : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const attachments = available.filter((item): item is DraftAttachment => Boolean(item));
  return { draft: { ...draft, attachments }, missing: draft.attachments.length - attachments.length };
}

export const useComposerDrafts = create<DraftsState>((set, get) => ({
  drafts: {},
  ready: false,
  loadError: false,
  unreadable: [],

  load() {
    if (get().ready) return Promise.resolve();
    loading ??= (async () => {
      try {
        const stored = await invoke<unknown>("settings.get", { key: DRAFTS_KEY });
        const entries =
          stored && typeof stored === "object" && !Array.isArray(stored)
            ? Object.entries(stored as Record<string, unknown>)
            : [];
        const loaded: Record<string, ComposerDraft> = {};
        const unreadable: string[] = [];
        unreadableRaw = {};
        let missing = 0;
        for (const [id, value] of entries) {
          try {
            const checked = await availableAttachments(parseDraft(value));
            missing += checked.missing;
            loaded[id] = checked.draft;
          } catch {
            unreadable.push(id);
            unreadableRaw[id] = value;
          }
        }
        if (unreadable.length) reportSave("Un brouillon sauvegardé n’a pas pu être relu.");
        if (missing) reportSave(`${missing} pièce(s) jointe(s) introuvable(s) ont été retirées du brouillon.`);
        // Ce qui a été tapé pendant le chargement l’emporte sur l’enregistré.
        const drafts = { ...loaded, ...get().drafts };
        for (const [id, seed] of seeds) if (!unreadable.includes(id)) drafts[id] = seed(drafts[id] ?? blankDraft);
        const seeded = seeds.size > 0;
        seeds.clear();
        set({ drafts, unreadable, ready: true, loadError: false });
        if (missing || seeded) schedule();
      } catch (error) {
        set({ loadError: true });
        reportSave(failureMessage(error, "Impossible de charger les brouillons."));
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  },

  retry() {
    set({ ready: false, loadError: false });
    return get().load();
  },

  update(id, change) {
    const { ready, unreadable } = get();
    if (!ready || unreadable.includes(id)) return;
    set((state) => ({ drafts: { ...state.drafts, [id]: change(state.drafts[id] ?? blankDraft) } }));
    schedule();
  },

  patch(id, patch) {
    get().update(id, (current) => ({ ...current, ...patch }));
  },

  clear(id) {
    get().update(id, () => blankDraft);
  },

  async discardUnreadable(id) {
    if (!get().unreadable.includes(id)) return;
    const { [id]: _removed, ...rest } = unreadableRaw;
    unreadableRaw = rest;
    set((state) => ({ unreadable: state.unreadable.filter((item) => item !== id) }));
    dirty = true;
    await write();
  },

  read(id) {
    return get().drafts[id] ?? blankDraft;
  },
}));

/** Pour les tests : repart d’aucun brouillon chargé. */
export function resetComposerDrafts() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  dirty = false;
  unreadableRaw = {};
  seeds.clear();
  loading = undefined;
  writing = Promise.resolve();
  useComposerDrafts.setState({ drafts: {}, ready: false, loadError: false, unreadable: [] });
}

/** Ancienne forme, gardée pour les appelants : pièces jointes et contexte déposés avant l’affichage. */
export interface ComposerDraftSeed {
  text?: string;
  attachments?: Attachment[];
  contexts?: PastedContext[];
}

/**
 * Dépose un brouillon dans la saisie d’une conversation avant son affichage (capture « Corriger un élément ») : il
 * s’ajoute au brouillon enregistré, à la place du texte s’il en apporte un.
 */
export function setComposerDraft(conversation: string, seed: ComposerDraftSeed) {
  const apply = (current: ComposerDraft): ComposerDraft => ({
    ...current,
    ...(seed.text !== undefined ? { text: seed.text, references: [] } : {}),
    attachments: [
      ...current.attachments,
      ...(seed.attachments ?? []).filter((item) => !current.attachments.some((known) => known.path === item.path)),
    ].slice(0, MAX_ATTACHMENTS),
    pastes: [...current.pastes, ...(seed.contexts ?? [])],
  });
  const drafts = useComposerDrafts.getState();
  if (drafts.ready) drafts.update(conversation, apply);
  else {
    const previous = seeds.get(conversation);
    seeds.set(conversation, previous ? (current) => apply(previous(current)) : apply);
    void drafts.load();
  }
}
