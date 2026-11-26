import { BookMarked, File, Folder, FolderOpen, Terminal } from "lucide-react";
import { type ReactNode, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Alert,
  AttachmentChip,
  AttachmentList,
  ChatComposer,
  type ChatComposerHandle,
  ChatOptionButton,
  ChatOptions,
  Link,
  type MentionReference,
  type MentionTrigger,
} from "socle-ui";
import { inTauri, pickFolder } from "../../lib/native";
import { pageTakesDrop } from "../../shell/fileDrop";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { DictationButton } from "../voice/DictationButton";
import { useVoice } from "../voice/store";
import { blankDraft, type ComposerDraft, hasDraft, useComposerDrafts } from "./drafts";
import {
  attachmentsFromPaths,
  isImage,
  MAX_ATTACHMENTS,
  type PreparedAttachment,
  prepareAttachments,
  saveBlobs,
} from "./files";
import type { Autonomy } from "./harness";
import {
  type ComposerReference,
  type ComposerReferenceMention,
  loadComposerReferences,
  REFERENCE_TRIGGER,
  type ReferenceKind,
  referenceDisplayName,
  trimComposerReferences,
} from "./lib/composerReferences";
import type { Conversation, QueuedMessage, UserMessage } from "./model";
import { ChoicePicker } from "./panel/ChoicePicker";
import { ModelPicker } from "./panel/ModelPicker";
import { QueueList, queuedEditable } from "./QueueList";
import { useAgents } from "./store";
import { QUOTE_EVENT } from "./Transcript";
import { WatchLines } from "./watches";

const AUTONOMY_LABEL: Record<Autonomy, string> = {
  ask: "Libre dans ses dossiers",
  auto: "Autonomie totale",
  strict: "Accord à chaque action",
  workspace: "Seulement dans son dossier",
};

function failure(title: string, error: unknown) {
  notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
}

/**
 * Ligne sous la saisie, hors du cadre comme dans OneApp : à gauche l’état (résumé Git) et le rappel des raccourcis
 * pendant une réponse ; à droite le modèle et le raisonnement (modifiables pendant la réponse, comme dans OneApp, pour
 * le message suivant), l’autonomie, puis le dossier de travail.
 */
function ConversationOptions({
  conversation,
  locked,
  responding,
  status,
}: {
  conversation: Conversation;
  locked: boolean;
  responding: boolean;
  status?: ReactNode;
}) {
  const update = useAgents((state) => state.update);
  const spaceDir = useShell((state) => state.snapshot?.path ?? "");
  const started = conversation.turns.length > 0;
  const folder =
    conversation.cwd === spaceDir
      ? "Dossier de l’espace de travail"
      : (conversation.cwd.split(/[\\/]/).pop() ?? conversation.cwd);
  return (
    <ChatOptions label="Réglages de la conversation" start={status}>
      <ModelPicker
        value={{ provider: conversation.provider, model: conversation.model, effort: conversation.effort }}
        cwd={conversation.cwd || spaceDir}
        disabled={locked}
        onChange={(choice) =>
          update(conversation.id, {
            provider: choice.provider,
            model: choice.model,
            effort: choice.effort,
            // Comme dans OneApp : un autre harnais ne peut pas reprendre la session ; la suivante rejoue l’historique.
            ...(choice.provider !== conversation.provider ? { sessionId: undefined } : {}),
          })
        }
      />
      <ChoicePicker
        name="Autonomie de l’agent"
        value={conversation.autonomy}
        choices={(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((value) => ({ value, label: AUTONOMY_LABEL[value] }))}
        placeholder="Autonomie"
        disabled={locked || responding}
        align="end"
        onChange={(value) => update(conversation.id, { autonomy: value as Autonomy })}
      />
      <ChatOptionButton
        icon={<FolderOpen size={13} />}
        label={folder}
        aria-label={`${folder} : dossier de travail ${conversation.cwd}`}
        isDisabled={locked || responding || !inTauri || started}
        onPress={async () => {
          const selected = await pickFolder("Dossier de travail de la conversation");
          if (selected) update(conversation.id, { cwd: selected });
        }}
      />
    </ChatOptions>
  );
}

/** Les collages se numérotent dans l’ordre, comme les cartes « Texte collé N » de OneApp : en retirer un renumérote les suivants. */
export function numberPastes(pastes: ComposerDraft["pastes"]): ComposerDraft["pastes"] {
  let index = 0;
  return pastes.map((paste) =>
    paste.title.startsWith("Texte collé") ? { ...paste, title: `Texte collé ${++index}` } : paste,
  );
}

function isMention(reference: ComposerReference): reference is ComposerReferenceMention {
  const { id, offset } = reference as Partial<ComposerReferenceMention>;
  return typeof id === "string" && Number.isInteger(offset);
}

/**
 * Remet un message dans la saisie d’une autre conversation, même pas encore affichée : « Repartir d’ici » depuis un
 * message de l’utilisateur, comme dans OneApp, ouvre la reprise avec ce message prêt à être corrigé et renvoyé.
 */
export async function restoreMessageDraft(conversation: string, message: UserMessage): Promise<void> {
  const drafts = useComposerDrafts.getState();
  if (!drafts.ready) await drafts.load();
  useComposerDrafts.getState().update(conversation, (current) => mergeIntoDraft(message, current));
}

/**
 * Remet un message (de la file, ou dont l’envoi a échoué) dans la saisie : seul s’il n’y a rien d’autre, sinon
 * devant ce qui est déjà écrit, ses pastilles à leur place et celles du brouillon décalées d’autant.
 */
export function mergeIntoDraft(message: UserMessage | ComposerDraft, current: ComposerDraft): ComposerDraft {
  const pastes = "pastes" in message ? message.pastes : message.contexts;
  const references = (message.references ?? []).filter(isMention);
  if (!hasDraft(current))
    return { text: message.text, references, attachments: message.attachments.slice(0, MAX_ATTACHMENTS), pastes };
  const separator = message.text && current.text.trim() ? "\n\n" : "";
  const shift = message.text.length + separator.length;
  return {
    text: `${message.text}${separator}${current.text}`,
    references: [...references, ...current.references.map((item) => ({ ...item, offset: item.offset + shift }))],
    attachments: [
      ...message.attachments,
      ...current.attachments.filter((item) => !message.attachments.some((known) => known.path === item.path)),
    ].slice(0, MAX_ATTACHMENTS),
    pastes: numberPastes([...pastes, ...current.pastes]),
  };
}

/** Déclencheurs de la saisie : `/` commandes et skills, `$` skills, `@` fichiers du dossier de travail. */
const TRIGGERS: { char: string; label: string; kind: ReferenceKind }[] = [
  { char: "/", label: "Skill ou commande", kind: "command" },
  { char: "$", label: "Skill", kind: "skill" },
  { char: "@", label: "Fichier du dossier", kind: "file" },
];

const referenceId = (reference: ComposerReference) => `${reference.kind}:${reference.path}`;

function referenceIcon(item: ComposerReference) {
  if (item.kind === "skill") return <BookMarked size={14} aria-hidden="true" />;
  if (item.kind === "command") return <Terminal size={14} aria-hidden="true" />;
  return item.name.endsWith("/") ? <Folder size={14} aria-hidden="true" /> : <File size={14} aria-hidden="true" />;
}

/** Détail à droite de la suggestion, comme dans OneApp : le dossier du fichier, sinon « Skill » ou « Commande ». */
function referenceDetail(item: ComposerReference) {
  if (item.kind === "file") return item.name.replace(/\/$/, "").split(/[\\/]/).slice(0, -1).join("/") || ".";
  return item.kind === "skill" ? "Skill" : "Commande";
}

/** Pastille de `MentionInput` d’une référence du brouillon ; la clé de la pastille est l’identifiant de la référence. */
function toMention(reference: ComposerReferenceMention): MentionReference {
  return {
    key: reference.id,
    trigger: REFERENCE_TRIGGER[reference.kind],
    id: referenceId(reference),
    label: referenceDisplayName(reference),
    offset: reference.offset,
  };
}

/** Les pastilles de la saisie sont celles du brouillon : mêmes clés, mêmes places. */
function samePlaces(references: readonly ComposerReferenceMention[], mentions: readonly MentionReference[]): boolean {
  return (
    references.length === mentions.length &&
    references.every(
      (reference, index) => reference.id === mentions[index].key && reference.offset === mentions[index].offset,
    )
  );
}

/**
 * Saisie d’un message : `ChatComposer` et `ChatOptions` de Socle (D-371 à D-374). Texte et pastilles de références
 * (`/`, `$`, `@`), fichiers joints (menu « + », dépôt, collage d’image), collages longs en « Texte collé N »,
 * brouillon gardé par conversation. Entrée envoie, Maj+Entrée va à la ligne ; pendant une réponse, ⌘/Ctrl+Entrée met
 * en file et Échap arrête l’agent.
 */
export function Composer({
  conversation,
  responding,
  compact = false,
  status,
  onDraggingChange,
}: {
  conversation: Conversation;
  responding: boolean;
  /** Panneau de droite : la saisie seule, sans les réglages de la conversation. */
  compact?: boolean;
  /**
   * État affiché à gauche, sur la ligne du choix du modèle (résumé des fichiers modifiés), comme dans OneApp ; masqué
   * pendant une réponse et tant qu’un message attend dans la file.
   */
  status?: ReactNode;
  /** Fichiers survolés : la page couvre sa zone de dépôt, comme celle de OneApp. */
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const send = useAgents((state) => state.send);
  const cancel = useAgents((state) => state.cancel);
  const unqueue = useAgents((state) => state.unqueue);
  const sendQueuedNow = useAgents((state) => state.sendQueuedNow);
  const retry = useAgents((state) => state.retry);
  // Réordonner la file appartient au moteur des conversations : tant qu’il ne le sait pas, la poignée reste masquée.
  const reorderQueued = useAgents(
    (state) => (state as { reorderQueued?: (id: string, ids: string[]) => Promise<void> | void }).reorderQueued,
  );
  const agentsReady = useAgents((state) => state.ready);
  const lastStatus = useAgents((state) => state.loaded[conversation.id]?.turns.at(-1)?.status);
  const queued = useAgents((state) => state.runtime[conversation.id]?.queued) ?? [];
  // Le résumé des fichiers modifiés est un état de fin : il attend que l’agent ait fini et que la file soit vide, pour
  // que rien ne marque une fin entre deux messages qui s’enchaînent.
  const shownStatus = responding || lastStatus === "running" || queued.length ? undefined : status;
  const conversationId = conversation.id;
  const spaceDir = useShell((state) => state.snapshot?.path ?? "");
  const cwd = conversation.cwd || spaceDir;
  const draft = useComposerDrafts((state) => state.drafts[conversationId] ?? blankDraft);
  const draftsReady = useComposerDrafts((state) => state.ready);
  const draftsLoadError = useComposerDrafts((state) => state.loadError);
  const draftUnreadable = useComposerDrafts((state) => state.unreadable.includes(conversationId));
  const { update, patch, clear, read, retry: retryDrafts, discardUnreadable } = useComposerDrafts.getState();
  // Comme OneApp : rien ne se saisit tant que les conversations et les brouillons ne sont pas prêts.
  const locked = !agentsReady || !draftsReady || draftUnreadable;
  const draggingChange = useRef(onDraggingChange);
  draggingChange.current = onDraggingChange;
  const setDragging = useCallback((next: boolean) => draggingChange.current?.(next), []);
  const [pendingAttachments, setPendingAttachments] = useState(0);
  const attaching = pendingAttachments > 0;
  const dictation = useVoice((state) => state.dictation);
  const partial = useVoice((state) => state.partial);
  const composer = useRef<ChatComposerHandle>(null);
  /** Verrou immédiat : plusieurs Entrée avant le rendu suivant n’envoient qu’un message. */
  const sending = useRef(false);
  /** Le texte du champ est déjà parti : jusqu’à la frappe suivante, il n’est pas renvoyé. */
  const sentText = useRef(false);
  const previewed = useRef(new Set<string>());
  /** Références proposées par les suggestions, par identifiant de pastille : la pastille choisie retrouve son chemin. */
  const catalog = useRef(new Map<string, ComposerReference>());

  useEffect(() => {
    void useComposerDrafts.getState().load();
  }, []);

  // Pendant qu’un agent écrit, la page se redessine plusieurs fois par seconde : le texte et les pastilles tapés
  // vivent donc ici, appliqués tout de suite (`flushSync`), et le brouillon partagé suit en transition.
  const [live, setLive] = useState(() => ({ text: draft.text, mentions: draft.references.map(toMention) }));
  const [seen, setSeen] = useState(draft);
  if (draft !== seen) {
    setSeen(draft);
    if (draft.text !== live.text || !samePlaces(draft.references, live.mentions)) {
      sentText.current = false;
      setLive({ text: draft.text, mentions: draft.references.map(toMention) });
    }
  }
  /** Références du brouillon pour les pastilles de la saisie : celles déjà connues gardent leur chemin. */
  const fromMentions = (mentions: readonly MentionReference[]): ComposerReferenceMention[] => {
    const known = new Map(read(conversationId).references.map((reference) => [reference.id, reference]));
    return mentions.flatMap((mention) => {
      const reference = known.get(mention.key) ?? catalog.current.get(mention.id);
      return reference
        ? [
            {
              name: reference.name,
              path: reference.path,
              kind: reference.kind,
              ...(reference.description ? { description: reference.description } : {}),
              id: mention.key,
              offset: mention.offset,
            },
          ]
        : [];
    });
  };
  const type = (text: string, mentions: MentionReference[]) => {
    sentText.current = false;
    flushSync(() => setLive({ text, mentions }));
    const references = fromMentions(mentions);
    startTransition(() => patch(conversationId, { text, references }));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus voulu au changement de conversation.
  useEffect(() => {
    composer.current?.focus();
  }, [conversationId]);

  // Une image jointe sans vignette (brouillon relu, capture déposée) reçoit la sienne.
  useEffect(() => {
    const missing = draft.attachments.filter(
      (item) => !item.preview && isImage(item.path) && !previewed.current.has(item.path),
    );
    if (!missing.length) return;
    for (const item of missing) previewed.current.add(item.path);
    void prepareAttachments(missing).then((prepared) => {
      const previews = new Map(prepared.flatMap((item) => (item.preview ? [[item.path, item.preview]] : [])));
      if (!previews.size) return;
      update(conversationId, (current) => ({
        ...current,
        attachments: current.attachments.map((item) =>
          previews.has(item.path) ? { ...item, preview: previews.get(item.path) } : item,
        ),
      }));
    });
  }, [draft.attachments, conversationId, update]);

  // « Citer dans la réponse » ajoute le passage en citation Markdown à la fin de la saisie, puis lui rend le focus.
  useEffect(() => {
    const quote = (event: Event) => {
      const { conversationId: target, text: quoted } = (event as CustomEvent<{ conversationId: string; text: string }>)
        .detail;
      if (target !== conversationId) return;
      const block = `${quoted
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
      update(conversationId, (current) => {
        const before = current.text.replace(/\s*$/, "");
        return { ...current, text: before ? `${before}\n\n${block}` : block };
      });
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener(QUOTE_EVENT, quote);
    return () => window.removeEventListener(QUOTE_EVENT, quote);
  }, [conversationId, update]);

  /** Prépare des pièces jointes (copie, vignettes) ; l’envoi attend qu’elles soient prêtes. */
  const attach = useCallback(
    (prepare: () => Promise<PreparedAttachment[]>) => {
      const target = conversationId;
      setPendingAttachments((count) => count + 1);
      void prepare()
        .then((files) =>
          update(target, (previous) => {
            const paths = new Set(previous.attachments.map((item) => item.path));
            return {
              ...previous,
              attachments: [...previous.attachments, ...files.filter((item) => !paths.has(item.path))].slice(
                0,
                MAX_ATTACHMENTS,
              ),
            };
          }),
        )
        .catch((error) => failure("Fichier non joint", error))
        .finally(() => setPendingAttachments((count) => count - 1));
    },
    [conversationId, update],
  );

  // Dans la fenêtre de l’application, le dépôt de fichiers arrive par le système, avec les chemins réels.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    if (!inTauri) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (lockedRef.current) return;
        const { payload } = event;
        // Une page de l’espace qui reçoit des fichiers (`useFileDrop`) prend ceux déposés sur elle ; la conversation,
        // ceux déposés ailleurs dans la fenêtre.
        const toPage = payload.type !== "leave" && pageTakesDrop(payload.position);
        if (payload.type === "over" || payload.type === "enter") setDragging(!toPage);
        else if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          const paths = payload.paths;
          if (!toPage && paths.length) attach(() => attachmentsFromPaths(paths));
        }
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [attach, setDragging]);

  const triggers = useMemo<MentionTrigger[]>(
    () =>
      TRIGGERS.map(({ char, label, kind }) => ({
        char,
        label,
        load: async (query) => {
          try {
            const found = await loadComposerReferences(cwd, conversation.provider, kind, query);
            return found.map((item) => {
              catalog.current.set(referenceId(item), item);
              return {
                id: referenceId(item),
                label: referenceDisplayName(item),
                description: referenceDetail(item),
                icon: referenceIcon(item),
              };
            });
          } catch (error) {
            // Comme dans OneApp, la cause de l’échec part en notification ; la liste dit seulement de réessayer.
            failure("Recherche de ressources", error);
            throw error;
          }
        },
      })),
    [cwd, conversation.provider],
  );

  // Pendant une réponse, comme dans OneApp : Entrée envoie tout de suite, ⌘/Ctrl+Entrée met le message en file.
  const shownPastes = draft.pastes.filter((paste) => !paste.hidden);
  const pieces = draft.attachments.length + shownPastes.length;
  // Comme dans OneApp : après une erreur ou une interruption, envoyer sans rien écrire relance le dernier message.
  const canResume = !responding && (lastStatus === "error" || lastStatus === "cancelled");

  /**
   * Envoie la saisie (texte et pastilles lus dans le champ, pièces jointes dans le brouillon) ; une dictée y ajoute sa
   * transcription et demande que la réponse soit lue.
   */
  const submit = async (typed?: { text: string; mentions: MentionReference[] }, dictated?: string, queue = false) => {
    if (locked || attaching || sending.current || (typed && sentText.current)) return;
    const current = read(conversationId);
    const text = typed ? typed.text : current.text;
    const references = typed ? fromMentions(typed.mentions) : current.references;
    if (!dictated && !text.trim() && !current.attachments.length && !current.pastes.length) return;
    const full = dictated ? [text.trim(), dictated].filter(Boolean).join(" ") : text;
    const message: UserMessage = {
      text: full.trim(),
      attachments: current.attachments.map(({ preview: _preview, ...attachment }) => attachment),
      contexts: current.pastes,
      ...(references.length ? { references: trimComposerReferences(full, references) } : {}),
      ...(dictated ? { spoken: true } : {}),
    };
    // La saisie se vide dès l’envoi ; le message y revient si l’envoi échoue.
    sending.current = true;
    sentText.current = true;
    let delivery: Promise<void>;
    try {
      clear(conversationId);
      delivery = send(conversationId, message, { now: !queue });
    } finally {
      sending.current = false;
    }
    composer.current?.focus();
    try {
      await delivery;
    } catch (error) {
      update(conversationId, (now) => mergeIntoDraft({ ...current, text, references }, now));
      failure("Message non envoyé", error);
    }
  };

  /**
   * Reprend un message de la file dans la saisie, pour le corriger avant son départ. Comme dans OneApp, son texte et
   * ses pastilles remplacent ceux de la saisie ; un message avec pièces jointes ou texte collé ne se reprend pas.
   */
  const edit = (item: QueuedMessage) => {
    if (!queuedEditable(item.message)) return;
    const message = unqueue(conversationId, item.id);
    if (!message) return;
    patch(conversationId, { text: message.text, references: (message.references ?? []).filter(isMention) });
    requestAnimationFrame(() => composer.current?.focus());
  };

  const removePaste = (id: string) =>
    patch(conversationId, { pastes: numberPastes(draft.pastes.filter((item) => item.id !== id)) });
  const removeAttachment = (path: string) =>
    patch(conversationId, { attachments: draft.attachments.filter((item) => item.path !== path) });
  const dictating =
    dictation === "listening"
      ? partial || "Je vous écoute…"
      : dictation === "transcribing"
        ? "Transcription…"
        : undefined;

  return (
    <>
      {draftsLoadError ? (
        <Alert tone="danger" action={{ label: "Réessayer", onPress: () => void retryDrafts() }}>
          Les brouillons n’ont pas pu être chargés. Réessayez avant de saisir un message.
        </Alert>
      ) : draftUnreadable ? (
        <Alert tone="danger" action={{ label: "Réessayer", onPress: () => void retryDrafts() }}>
          Le brouillon enregistré de cette conversation est illisible.{" "}
          <Link
            onPress={() =>
              void discardUnreadable(conversationId).catch((error) => failure("Brouillon non supprimé", error))
            }
          >
            Supprimer le brouillon
          </Link>
        </Alert>
      ) : null}
      <WatchLines conversationId={conversationId} />
      <ChatComposer
        ref={composer}
        label={`Message à ${conversation.title}`}
        value={live.text}
        references={live.mentions}
        onChange={type}
        onSubmit={(text, mode, mentions) => void submit({ text, mentions }, undefined, mode === "queue")}
        placeholder={
          dictating ?? (conversation.turns.length ? "Répondre à l’agent…" : "Que puis-je mettre en place pour vous ?")
        }
        runningPlaceholder={dictating}
        triggers={triggers}
        isRunning={responding}
        onStop={() => void cancel(conversationId)}
        canResume={canResume}
        onResume={() => void retry(conversationId).catch((error) => failure("Message non envoyé", error))}
        isPending={attaching}
        isDisabled={locked}
        hasAttachments={pieces > 0}
        onAddFiles={(files) => attach(() => saveBlobs(conversationId, files.slice(0, MAX_ATTACHMENTS)))}
        onPasteLongText={(pasted) =>
          update(conversationId, (previous) => ({
            ...previous,
            pastes: [
              ...previous.pastes,
              {
                id: crypto.randomUUID(),
                title: `Texte collé ${previous.pastes.filter((item) => item.title.startsWith("Texte collé")).length + 1}`,
                text: pasted,
              },
            ],
          }))
        }
        queue={
          <QueueList
            queue={queued}
            disabled={locked}
            onEdit={edit}
            onRemove={(item) => unqueue(conversationId, item.id)}
            onSendNow={(item) =>
              void sendQueuedNow(conversationId, item.id).catch((error) => failure("Message non envoyé", error))
            }
            onReorder={reorderQueued ? (ids) => reorderQueued(conversationId, ids) : undefined}
          />
        }
        attachments={
          pieces ? (
            <AttachmentList>
              {shownPastes.map((paste) => (
                <AttachmentChip
                  key={paste.id}
                  kind="text"
                  name={paste.title}
                  text={paste.text}
                  onRemove={() => removePaste(paste.id)}
                />
              ))}
              {draft.attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.path}
                  kind={attachment.preview || isImage(attachment.path) ? "image" : "file"}
                  name={attachment.name}
                  src={attachment.preview}
                  onRemove={() => removeAttachment(attachment.path)}
                />
              ))}
            </AttachmentList>
          ) : null
        }
        trailing={<DictationButton onTranscript={(dictated) => void submit(undefined, dictated)} />}
      />
      {compact ? (
        shownStatus ? (
          <ChatOptions start={shownStatus} />
        ) : null
      ) : (
        <ConversationOptions conversation={conversation} locked={locked} responding={responding} status={shownStatus} />
      )}
    </>
  );
}
