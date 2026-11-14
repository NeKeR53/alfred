import { IconButton, MenuItem, OverflowMenu } from "@alfred/ui";
import { ArrowUp, Clock, FolderOpen, Paperclip, Pencil, Plus, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { inTauri, pickFolder } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { takeComposerDraft } from "./drafts";
import { attachmentFromPath, isImage, pickAttachments, saveBlob } from "./files";
import type { Autonomy } from "./harness";
import {
  type Attachment,
  type Conversation,
  isLongPaste,
  type PastedContext,
  pastedContextTitle,
  type UserMessage,
} from "./model";
import { ChoicePicker } from "./panel/ChoicePicker";
import { ModelPicker } from "./panel/ModelPicker";
import { useComposerReferences } from "./ReferenceSuggestions";
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

/**
 * Saisie d’un message : texte, fichiers joints (bouton, dépôt, collage d’image) et collages longs repliés en blocs
 * de contexte. Entrée envoie, Maj+Entrée va à la ligne.
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
  const queued = useAgents((state) => state.runtime[conversation.id]?.queued) ?? [];
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [contexts, setContexts] = useState<PastedContext[]>([]);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const conversationId = conversation.id;
  const spaceDir = useShell((state) => state.snapshot?.path ?? "");
  // `/` : commandes et skills du harnais de la conversation ; `@` : fichiers de son dossier de travail.
  const references = useComposerReferences({
    field,
    text,
    setText,
    cwd: conversation.cwd || spaceDir,
    provider: conversation.provider,
  });

  // Chaque conversation a son brouillon : en changer vide la saisie.
  // biome-ignore lint/correctness/useExhaustiveDependencies: réinitialisation voulue au changement de conversation.
  useEffect(() => {
    const draft = takeComposerDraft(conversationId);
    setText(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
    setContexts(draft?.contexts ?? []);
    references.reset();
    field.current?.focus();
  }, [conversationId]);

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
      setText((current) => {
        const before = current.replace(/\s*$/, "");
        return before ? `${before}\n\n${block}` : block;
      });
      requestAnimationFrame(() => {
        const input = field.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    };
    window.addEventListener(QUOTE_EVENT, quote);
    return () => window.removeEventListener(QUOTE_EVENT, quote);
  }, [conversationId]);

  const addAttachments = useCallback(
    (added: Attachment[]) =>
      setAttachments((current) => [
        ...current,
        ...added.filter((item) => !current.some((known) => known.path === item.path)),
      ]),
    [],
  );

  const addFiles = async (files: File[]) => {
    try {
      addAttachments(await Promise.all(files.map((file) => saveBlob(conversationId, file))));
    } catch (error) {
      failure("Fichier non joint", error);
    }
  };

  // Dans la fenêtre de l’application, le dépôt de fichiers arrive par le système, avec les chemins réels.
  useEffect(() => {
    if (!inTauri) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") setDragging(true);
        else if (event.payload.type === "leave") setDragging(false);
        else if (event.payload.type === "drop") {
          setDragging(false);
          void Promise.all(event.payload.paths.map((path) => attachmentFromPath(path))).then((found) =>
            addAttachments(found.filter((item): item is Attachment => item !== undefined)),
          );
        }
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [addAttachments]);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (isLongPaste(pasted)) {
      event.preventDefault();
      setContexts((current) => [
        ...current,
        { id: crypto.randomUUID(), title: pastedContextTitle(pasted, current.length + 1), text: pasted },
      ]);
    }
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (inTauri) return;
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  // Pendant une réponse, le message rejoint la file et part dès que l’agent a fini.
  const canSend = text.trim().length > 0 || attachments.length > 0 || contexts.length > 0;

  const submit = async () => {
    if (!canSend) return;
    const chosen = references.take(text);
    const message: UserMessage = {
      text: text.trim(),
      attachments,
      contexts,
      ...(chosen.length ? { references: chosen } : {}),
    };
    setText("");
    setAttachments([]);
    setContexts([]);
    try {
      await send(conversationId, message);
    } catch (error) {
      failure("Message non envoyé", error);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (references.onKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape" && responding) {
      event.preventDefault();
      void cancel(conversationId);
    }
  };

  /** Reprend un message de la file dans la saisie, pour le corriger avant son départ. */
  const edit = (queuedId: string) => {
    const message = unqueue(conversationId, queuedId);
    if (!message) return;
    setText((current) => (current.trim() ? `${message.text}\n\n${current}` : message.text));
    setAttachments((current) => [
      ...message.attachments,
      ...current.filter((item) => !message.attachments.some((known) => known.path === item.path)),
    ]);
    setContexts((current) => [...message.contexts, ...current]);
    requestAnimationFrame(() => field.current?.focus());
  };

  const pick = async () => {
    if (!inTauri) {
      fileInput.current?.click();
      return;
    }
    try {
      addAttachments(await pickAttachments());
    } catch (error) {
      failure("Fichier non joint", error);
    }
  };

  return (
    <div className="agent-composer">
      {queued.length ? (
        <ul className="agent-composer__queue" aria-label="Messages en attente">
          {queued.map((item) => (
            <li key={item.id} className="agent-composer__queued">
              <Clock size={13} aria-hidden="true" />
              <span className="agent-composer__queued-text" title={item.message.text}>
                {item.message.text ||
                  `${item.message.attachments.length + item.message.contexts.length} pièce(s) jointe(s)`}
              </span>
              <span className="agent-composer__queued-state">Envoyé à la fin de la réponse</span>
              <IconButton size="small" label="Modifier le message en attente" onClick={() => edit(item.id)}>
                <Pencil size={12} aria-hidden="true" />
              </IconButton>
              <IconButton
                size="small"
                label="Retirer le message en attente"
                onClick={() => unqueue(conversationId, item.id)}
              >
                <X size={12} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className={`agent-composer__box${dragging ? " is-dragging" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => {
          if (inTauri) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => !inTauri && setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length || contexts.length ? (
          <ul className="agent-composer__attachments">
            {contexts.map((context) => (
              <li key={context.id}>
                <TextPreview
                  text={context.text}
                  label={context.title}
                  onRemove={() => setContexts((current) => current.filter((item) => item.id !== context.id))}
                />
              </li>
            ))}
            {attachments.map((attachment) => (
              <li key={attachment.path} className="agent-composer__file" title={attachment.path}>
                <Paperclip size={13} aria-hidden="true" />
                <span>{attachment.name}</span>
                {isImage(attachment.path) ? <span className="sr-only"> (image)</span> : null}
                <IconButton
                  size="small"
                  className="agent-composer__remove"
                  label={`Retirer ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}
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
            tooltip="Joindre un fichier"
            icon={<Plus size={16} aria-hidden="true" />}
            placement="above"
            align="start"
          >
            <MenuItem onClick={() => void pick()}>
              <Paperclip size={14} aria-hidden="true" />
              Joindre des fichiers…
            </MenuItem>
          </OverflowMenu>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <textarea
            ref={field}
            className="agent-composer__input"
            // Exclu du soulignement des champs nus (styles.css) : le cadre du compositeur porte bordure et focus.
            data-slot="composer-input"
            aria-label="Message à l’agent"
            placeholder={
              dragging
                ? "Déposez vos fichiers ici"
                : conversation.turns.length
                  ? "Répondre à l’agent…"
                  : "Décrire ce que l’agent doit faire…"
            }
            rows={1}
            value={text}
            {...references.inputProps}
            onChange={(event) => {
              setText(event.target.value);
              references.track();
            }}
            onSelect={references.track}
            onBlur={references.dismiss}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
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
            label={responding ? "Envoyer à la fin de la réponse" : "Envoyer"}
            disabled={!canSend}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </IconButton>
        </div>
      </form>
      {references.popover}
      {compact ? null : <ConversationOptions conversation={conversation} locked={responding} />}
    </div>
  );
}
