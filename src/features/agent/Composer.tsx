import { Button, FeedbackBanner, IconButton, MenuItem, OverflowMenu } from "@alfred/ui";
import { ArrowUp, AtSign, FolderOpen, Paperclip, Plus, Slash, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { inTauri, pickFolder } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { DictationButton } from "../voice/DictationButton";
import { useVoice } from "../voice/store";
import { ComposerEditor, composerSelectionRange, setComposerSelection } from "./ComposerEditor";
import { blankDraft, type ComposerDraft, hasDraft, useComposerDrafts } from "./drafts";
import {
  attachmentsFromPaths,
  isImage,
  MAX_ATTACHMENTS,
  type PreparedAttachment,
  pickAttachments,
  prepareAttachments,
  saveBlobs,
} from "./files";
import type { Autonomy } from "./harness";
import {
  type ComposerReference,
  type ComposerReferenceMention,
  replaceComposerRange,
  trimComposerReferences,
} from "./lib/composerReferences";
import type { Conversation, QueuedMessage, UserMessage } from "./model";
import { ChoicePicker } from "./panel/ChoicePicker";
import { ModelPicker } from "./panel/ModelPicker";
import { QueueList } from "./QueueList";
import { useAgents } from "./store";
import { TextPreview } from "./TextPreview";
import { QUOTE_EVENT } from "./Transcript";
import "./agent-composer.css";

const AUTONOMY_LABEL: Record<Autonomy, string> = {
  ask: "Libre dans ses dossiers",
  auto: "Autonomie totale",
  strict: "Accord à chaque action",
};

function failure(title: string, error: unknown) {
  notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
}

/**
 * Réglages de la conversation sous la saisie, à droite et hors du cadre comme dans OneApp : modèle et raisonnement,
 * autonomie, puis dossier de travail. Mêmes déclencheurs discrets (texte et chevron) que le choix du modèle.
 */
function ConversationOptions({ conversation, locked }: { conversation: Conversation; locked: boolean }) {
  const update = useAgents((state) => state.update);
  const spaceDir = useShell((state) => state.snapshot?.path ?? "");
  const started = conversation.turns.length > 0;
  const folder =
    conversation.cwd === spaceDir ? "Dossier de l’espace" : (conversation.cwd.split(/[\\/]/).pop() ?? conversation.cwd);
  return (
    <div className="agent-composer__options">
      <span className="agent-composer__options-spacer" />
      <ModelPicker
        value={{ provider: conversation.provider, model: conversation.model, effort: conversation.effort }}
        cwd={conversation.cwd || spaceDir}
        providerLocked={started}
        disabled={locked}
        onChange={(choice) =>
          update(conversation.id, {
            provider: choice.provider,
            model: choice.model,
            effort: choice.effort,
            // Une session ne change pas de harnais en cours de route : le relevé resterait, pas la mémoire de l’agent.
            ...(choice.provider !== conversation.provider ? { sessionId: undefined } : {}),
          })
        }
      />
      <ChoicePicker
        name="Autonomie de l’agent"
        value={conversation.autonomy}
        choices={(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((value) => ({ value, label: AUTONOMY_LABEL[value] }))}
        placeholder="Autonomie"
        disabled={locked}
        align="end"
        onChange={(value) => update(conversation.id, { autonomy: value as Autonomy })}
      />
      <button
        type="button"
        className="choice-picker__trigger agent-composer__folder"
        title={conversation.cwd}
        aria-label={`Dossier de travail : ${folder}`}
        disabled={locked || !inTauri || started}
        onClick={async () => {
          const selected = await pickFolder("Dossier de travail de la conversation");
          if (selected) update(conversation.id, { cwd: selected });
        }}
      >
        <FolderOpen size={13} aria-hidden="true" />
        <span>{folder}</span>
      </button>
    </div>
  );
}

/** Comme OneApp : un collage d’au moins 2 000 caractères ou 20 lignes devient une carte « Texte collé N ». */
export function isLongChatText(text: string): boolean {
  return text.length >= 2000 || text.split(/\r\n|\r|\n/, 20).length >= 20;
}

/** Certains presse-papiers n’exposent les images que par `items`. */
function clipboardFiles(data: DataTransfer): File[] {
  const images = [...data.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return images.length ? images : [...data.files];
}

function isMention(reference: ComposerReference): reference is ComposerReferenceMention {
  const { id, offset } = reference as Partial<ComposerReferenceMention>;
  return typeof id === "string" && Number.isInteger(offset);
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
    pastes: [...pastes, ...current.pastes],
  };
}

/**
 * Saisie d’un message, reprise de `AgentComposer` de OneApp : texte et pastilles de références (`/`, `$`, `@`),
 * fichiers joints (menu, dépôt, collage d’image) avec vignettes, collages longs repliés en cartes, brouillon gardé
 * par conversation. Entrée envoie, Maj+Entrée va à la ligne ; pendant une réponse, Ctrl/⌘+Entrée met en file.
 */
export function Composer({
  conversation,
  responding,
  compact = false,
}: {
  conversation: Conversation;
  responding: boolean;
  /** Panneau de droite : la saisie seule, sans les réglages de la conversation. */
  compact?: boolean;
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
  const conversationId = conversation.id;
  const draft = useComposerDrafts((state) => state.drafts[conversationId] ?? blankDraft);
  const draftsReady = useComposerDrafts((state) => state.ready);
  const draftsLoadError = useComposerDrafts((state) => state.loadError);
  const draftUnreadable = useComposerDrafts((state) => state.unreadable.includes(conversationId));
  const { update, patch, clear, read, retry: retryDrafts, discardUnreadable } = useComposerDrafts.getState();
  // Comme OneApp : rien ne se saisit tant que les conversations et les brouillons ne sont pas prêts.
  const locked = !agentsReady || !draftsReady || draftUnreadable;
  const [dragging, setDragging] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState(0);
  const attaching = pendingAttachments > 0;
  const dictation = useVoice((state) => state.dictation);
  const partial = useVoice((state) => state.partial);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Verrou immédiat : plusieurs Entrée avant le rendu suivant n’envoient qu’un message. */
  const sending = useRef(false);
  const previewed = useRef(new Set<string>());
  /** Sélection du champ au moment où il a perdu le focus : le menu « + » insère là où était le curseur. */
  const lastSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  const spaceDir = useShell((state) => state.snapshot?.path ?? "");

  useEffect(() => {
    void useComposerDrafts.getState().load();
  }, []);

  // Pendant qu’un agent écrit, la page se redessine plusieurs fois par seconde : le texte et les pastilles tapés
  // vivent donc ici, appliqués tout de suite (`flushSync`), et le brouillon partagé suit en transition.
  const [live, setLive] = useState({ text: draft.text, references: draft.references });
  const [seen, setSeen] = useState(draft);
  if (draft !== seen) {
    setSeen(draft);
    if (draft.text !== live.text || draft.references !== live.references)
      setLive({ text: draft.text, references: draft.references });
  }
  const typeText = (text: string) => {
    flushSync(() => setLive((current) => ({ ...current, text })));
    startTransition(() => patch(conversationId, { text }));
  };
  const typeReferences = (references: ComposerReferenceMention[]) => {
    flushSync(() => setLive((current) => ({ ...current, references })));
    startTransition(() => patch(conversationId, { references }));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus voulu au changement de conversation.
  useEffect(() => {
    lastSelection.current = undefined;
    editor.current?.focus();
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

  // « Citer dans la réponse » ajoute le passage en citation Markdown à la fin de la saisie, puis y place le curseur.
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
      requestAnimationFrame(() => {
        const input = editor.current;
        if (!input) return;
        input.focus();
        setComposerSelection(input, read(conversationId).text.length);
      });
    };
    window.addEventListener(QUOTE_EVENT, quote);
    return () => window.removeEventListener(QUOTE_EVENT, quote);
  }, [conversationId, update, read]);

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
        if (event.payload.type === "over" || event.payload.type === "enter") setDragging(true);
        else if (event.payload.type === "leave") setDragging(false);
        else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = event.payload.paths;
          if (paths.length) attach(() => attachmentsFromPaths(paths));
        }
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [attach]);

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      attach(() => saveBlobs(conversationId, files));
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (!pasted.trim() || !isLongChatText(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const { start, end } = composerSelectionRange(input);
    update(conversationId, (previous) => ({
      ...previous,
      text: previous.text.slice(0, start) + previous.text.slice(end),
      references: replaceComposerRange(previous.references, start, end),
      pastes: [
        ...previous.pastes,
        {
          id: crypto.randomUUID(),
          title: `Texte collé ${previous.pastes.filter((item) => item.title.startsWith("Texte collé")).length + 1}`,
          text: pasted,
        },
      ],
    }));
    requestAnimationFrame(() => setComposerSelection(input, start));
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (inTauri) return;
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!locked && files.length) attach(() => saveBlobs(conversationId, files));
  };

  /** Insère « / » ou « @ » au curseur pour ouvrir la liste des skills ou des fichiers. */
  const insertTrigger = (character: "/" | "@") => {
    const input = editor.current;
    if (!input || locked) return;
    const length = live.text.length;
    const saved = document.activeElement === input ? undefined : lastSelection.current;
    input.focus();
    const range = saved ?? composerSelectionRange(input);
    const start = Math.min(range.start, length);
    const end = Math.min(range.end, length);
    const before = live.text.slice(0, start);
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}${character}`;
    update(conversationId, (previous) => ({
      ...previous,
      text: previous.text.slice(0, start) + inserted + previous.text.slice(end),
      references: replaceComposerRange(previous.references, start, end, inserted.length),
    }));
    requestAnimationFrame(() => {
      setComposerSelection(input, start + inserted.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  // Pendant une réponse, comme dans OneApp : Entrée envoie tout de suite, Ctrl/⌘+Entrée met le message en file.
  const queueShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↩" : "Ctrl+↩";
  const filled = hasDraft(draft);
  // Comme dans OneApp : après une erreur ou une interruption, envoyer sans rien écrire relance le dernier message.
  const canResume = !responding && (lastStatus === "error" || lastStatus === "cancelled");

  /** Envoie la saisie ; une dictée y ajoute sa transcription et demande que la réponse soit lue. */
  const submit = async (dictated?: string, queue = false) => {
    if (locked || attaching || sending.current) return;
    // La frappe suit en transition : l’envoi lit le brouillon à cet instant, pas celui du dernier rendu.
    const current = read(conversationId);
    if (!dictated && !hasDraft(current)) {
      if (canResume) void retry(conversationId).catch((error) => failure("Message non envoyé", error));
      return;
    }
    const full = dictated ? [current.text.trim(), dictated].filter(Boolean).join(" ") : current.text;
    const message: UserMessage = {
      text: full.trim(),
      attachments: current.attachments.map(({ preview: _preview, ...attachment }) => attachment),
      contexts: current.pastes,
      ...(current.references.length ? { references: trimComposerReferences(full, current.references) } : {}),
      ...(dictated ? { spoken: true } : {}),
    };
    // La saisie se vide dès l’envoi ; le message y revient si l’envoi échoue.
    sending.current = true;
    let delivery: Promise<void>;
    try {
      clear(conversationId);
      delivery = send(conversationId, message, { now: !queue });
    } finally {
      sending.current = false;
    }
    editor.current?.focus();
    try {
      await delivery;
    } catch (error) {
      update(conversationId, (now) => mergeIntoDraft(current, now));
      failure("Message non envoyé", error);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!attaching) void submit(undefined, event.ctrlKey || event.metaKey);
    }
    if (event.key === "Escape" && dictation === "listening") {
      event.preventDefault();
      void useVoice.getState().cancelDictation();
      return;
    }
    if (event.key === "Escape" && responding) {
      event.preventDefault();
      void cancel(conversationId);
    }
  };

  /** Reprend un message de la file dans la saisie, pour le corriger avant son départ. */
  const edit = (item: QueuedMessage) => {
    const message = unqueue(conversationId, item.id);
    if (!message) return;
    update(conversationId, (current) => mergeIntoDraft(message, current));
    requestAnimationFrame(() => editor.current?.focus());
  };

  const pick = () => {
    if (!inTauri) {
      fileInput.current?.click();
      return;
    }
    attach(pickAttachments);
  };

  const sendLabel = canResume && !filled ? "Relancer l’exécution" : responding ? "Envoyer maintenant" : "Envoyer";
  return (
    <div className="agent-composer">
      {draftsLoadError ? (
        <FeedbackBanner action={<Button onClick={() => void retryDrafts()}>Réessayer</Button>}>
          Les brouillons n’ont pas pu être chargés. Réessayez avant de saisir un message.
        </FeedbackBanner>
      ) : draftUnreadable ? (
        <FeedbackBanner
          action={
            <>
              <Button onClick={() => void retryDrafts()}>Réessayer</Button>
              <Button
                onClick={() =>
                  void discardUnreadable(conversationId).catch((error) => failure("Brouillon non supprimé", error))
                }
              >
                Supprimer le brouillon
              </Button>
            </>
          }
        >
          Le brouillon enregistré de cette conversation est illisible.
        </FeedbackBanner>
      ) : null}
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
      <form
        className={`agent-composer__box${dragging ? " is-dragging" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => {
          if (inTauri || locked) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => !inTauri && setDragging(false)}
        onDrop={onDrop}
      >
        {draft.attachments.length || draft.pastes.length ? (
          <ul className="agent-composer__attachments">
            {draft.pastes.map((context) => (
              <li key={context.id}>
                <TextPreview
                  text={context.text}
                  label={context.title}
                  onRemove={() =>
                    patch(conversationId, { pastes: draft.pastes.filter((item) => item.id !== context.id) })
                  }
                />
              </li>
            ))}
            {draft.attachments.map((attachment) => (
              <li
                key={attachment.path}
                className={attachment.preview ? "agent-composer__thumb" : "agent-composer__file"}
                title={attachment.name}
              >
                {attachment.preview ? (
                  <img src={attachment.preview} alt={attachment.name} className="agent-composer__thumb-image" />
                ) : (
                  <>
                    <Paperclip size={13} aria-hidden="true" />
                    <span>{attachment.name}</span>
                  </>
                )}
                <IconButton
                  size="small"
                  className="agent-composer__remove"
                  label={`Retirer ${attachment.name}`}
                  onClick={() =>
                    patch(conversationId, {
                      attachments: draft.attachments.filter((item) => item.path !== attachment.path),
                    })
                  }
                >
                  <X size={12} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="agent-composer__row">
          <OverflowMenu
            label="Ajouter au message"
            tooltip="Joindre un fichier, un skill ou une référence"
            icon={<Plus size={16} aria-hidden="true" />}
            placement="above"
            align="start"
            disabled={locked}
          >
            <MenuItem disabled={attaching} onClick={pick}>
              <Paperclip size={14} aria-hidden="true" />
              Joindre des fichiers…
            </MenuItem>
            <MenuItem onClick={() => insertTrigger("/")}>
              <Slash size={14} aria-hidden="true" />
              Skill ou commande · /
            </MenuItem>
            <MenuItem onClick={() => insertTrigger("@")}>
              <AtSign size={14} aria-hidden="true" />
              Fichier du dossier · @
            </MenuItem>
          </OverflowMenu>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])].slice(0, MAX_ATTACHMENTS);
              event.target.value = "";
              if (files.length) attach(() => saveBlobs(conversationId, files));
            }}
          />
          <ComposerEditor
            key={conversationId}
            ref={editor}
            className="agent-composer__input"
            // Exclu du soulignement des champs nus (styles.css) : le cadre du compositeur porte bordure et focus.
            data-slot="composer-input"
            aria-label="Message à l’agent"
            cwd={conversation.cwd || spaceDir}
            provider={conversation.provider}
            disabled={locked}
            placeholder={
              dictation === "listening"
                ? partial || "Je vous écoute…"
                : dictation === "transcribing"
                  ? "Transcription…"
                  : dragging
                    ? "Déposez vos fichiers ici"
                    : responding
                      ? "Ajouter un message à la file…"
                      : conversation.turns.length
                        ? "Répondre à l’agent…"
                        : "Que puis-je mettre en place pour vous ?"
            }
            value={live.text}
            onValueChange={typeText}
            references={live.references}
            onReferencesChange={typeReferences}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              lastSelection.current = composerSelectionRange(event.currentTarget);
            }}
            onPaste={onPaste}
          />
          <DictationButton onTranscript={(dictated) => void submit(dictated)} />
          {responding ? (
            <IconButton
              label="Interrompre la réponse"
              tooltip="Interrompre · Échap"
              onClick={() => void cancel(conversationId)}
            >
              <Square size={13} aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            type="submit"
            className="agent-composer__send"
            label={sendLabel}
            tooltip={responding ? `Envoyer maintenant · ↩ (${queueShortcut} pour mettre en file)` : sendLabel}
            disabled={locked || attaching || (!filled && !canResume)}
            loading={attaching}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </IconButton>
        </div>
      </form>
      {responding ? (
        <p className="agent-composer__hint">↩ pour envoyer maintenant, {queueShortcut} pour mettre en file</p>
      ) : null}
      {compact ? null : <ConversationOptions conversation={conversation} locked={responding || locked} />}
    </div>
  );
}
