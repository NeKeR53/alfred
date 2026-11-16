import { Button, Disclosure, useConfirm } from "@alfred/ui";
import { ChevronDown, ChevronUp, FileDiff, LoaderCircle, Undo2 } from "lucide-react";
import {
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { Activities, type Activity, hasActivityOutput } from "./Activities";
import { restoreMessageDraft } from "./Composer";
import { effortLabel } from "./effort";
import { followLink } from "./files";
import type { ApprovalRequest } from "./harness";
import { activityImageOutput, loadConversationImage, referencedLocalImages } from "./lib/chatImages";
import { referencedLocalFiles } from "./lib/conversationFileKinds";
import type { AgentQuestion, Conversation, ConversationRuntime, Turn, TurnItem, UserMessage } from "./model";
import { PlacementCard } from "./PlacementCard";
import { useAgents } from "./store";
import { TextPreview } from "./TextPreview";
import { AgentMarkdown } from "./transcript/AgentMarkdown";
import { AgentQuestionCard } from "./transcript/AgentQuestionCard";
import { agentQuestion, withoutAgentQuestion } from "./transcript/agentQuestions";
import { ChatAttachments } from "./transcript/ChatAttachments";
import { ConversationFiles } from "./transcript/ConversationFiles";
import { ConversationImages } from "./transcript/ConversationImages";
import { ErrorBoundary } from "./transcript/ErrorBoundary";
import { conversationFileActions } from "./transcript/fileActions";
import { type Delivery, formatDateTimeShort, MessageActions } from "./transcript/MessageActions";
import { ReferencePills } from "./transcript/ReferencePills";
import { type ConversationResources, ConversationResourcesContext } from "./transcript/resources";
import "./transcript/transcript.css";

/*
 * Relevé d’une conversation, repris de `ChatTranscript` de OneApp : le message de l’utilisateur en bulle à droite,
 * puis le travail de l’agent replié derrière son résumé (« A travaillé pendant 12 s · 3 outils appelés ») et sa
 * réponse finale en clair, les images et fichiers du tour, enfin le bilan des fichiers modifiés avec « Annuler cette
 * modification ». La question de l’agent ou l’autorisation attendue se pose dans une carte au-dessus de la saisie.
 */

/** Événement qui demande à la saisie d’une conversation d’ajouter une citation (« Citer dans la réponse »). */
export const QUOTE_EVENT = "alfred:agent-quote";

/** Tours affichés dès l’ouverture d’une conversation (les 12 derniers blocs de OneApp : message et travail). */
export const RECENT_TURNS = 6;

/** Un message de l’utilisateur long (2 000 caractères ou 20 lignes) s’affiche en carte, comme dans OneApp. */
export function isLongChatText(text: string): boolean {
  return text.length >= 2000 || text.split(/\r\n|\r|\n/, 20).length >= 20;
}

/** Actions du store ajoutées par le moteur des conversations ; le relevé ne montre leurs boutons que si elles existent. */
type TurnActions = {
  resend?: (conversationId: string, turnId: string) => Promise<unknown>;
  /** `"user"` : historique jusqu’avant ce tour ; `"reply"` : jusqu’à ce tour compris. */
  fork?: (conversationId: string, turnId: string, from?: "user" | "reply") => Promise<unknown>;
  /** Compteur des envois de l’utilisateur par conversation : le relevé se recolle en bas à chaque envoi. */
  follow?: Record<string, number>;
};

type Block = { key: string; message?: string; activities?: Activity[] };

/** Suite des éléments d’un tour : messages et séries d’activités consécutives. */
function blocksOf(items: readonly TurnItem[]): Block[] {
  const result: Block[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      if (item.content.trim()) result.push({ key: item.id, message: item.content });
      continue;
    }
    // Une réflexion terminée sans contenu n’apporte rien au relevé.
    if (item.activityKind === "analysis" && item.status === "completed" && !hasActivityOutput(item)) continue;
    const last = result.at(-1);
    if (last?.activities) last.activities.push(item);
    else result.push({ key: item.id, activities: [item] });
  }
  return result;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60
    ? `${seconds} s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ${seconds % 60} s`
      : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** Résumé d’un tour terminé, repris de `workSummary` de OneApp. */
export function turnSummary(turn: Turn): string {
  const count = turn.items.filter((item) => item.kind === "activity" && item.activityKind !== "analysis").length;
  const worked =
    turn.endedAt !== undefined ? `A travaillé pendant ${duration(turn.endedAt - turn.startedAt)}` : "Travail terminé";
  if (count === 0) return `${worked} · aucun outil appelé`;
  return `${worked} · ${count} outil${count === 1 ? " appelé" : "s appelés"}`;
}

/** Statut de remise du message de l’utilisateur, repris de OneApp : envoyé dès que l’agent a répondu. */
export function turnDelivery(turn: Turn): Delivery {
  const status =
    turn.status === "done" || turn.items.length ? "sent" : turn.status === "running" ? "pending" : turn.status;
  return { startedAt: turn.startedAt, status };
}

/**
 * Images remises par l’agent ou générées, visibles sous le tour hors du détail : les images lues par les outils
 * (une photo jointe par l’utilisateur) ne sont pas des livrables à répéter sous la réponse.
 */
export function producedImages(turn: Turn): string[] {
  return turn.items.flatMap((item) =>
    item.kind === "activity" && (item.title === "Génération d’image" || item.title === "Image de l’agent")
      ? [...(item.images ?? []), ...activityImageOutput(item.content ?? "").images]
      : [],
  );
}

export function producedFiles(turn: Turn): string[] {
  return turn.items.flatMap((item) => (item.kind === "activity" ? (item.files ?? []) : []));
}

/** Modèle de la conversation, en infobulle de son en-tête. */
export function conversationModelLabel(conversation: Pick<Conversation, "model" | "effort">): string | undefined {
  if (!conversation.model) return undefined;
  return conversation.effort ? `${conversation.model} · ${effortLabel(conversation.effort)}` : conversation.model;
}

/** En-tête « Depuis {origine} · {date} », avec le modèle en infobulle, repris de la page Agents de OneApp. */
export function TranscriptHeader({ conversation }: { conversation: Conversation }) {
  // Une reprise (« Repartir d’ici ») vient de la conversation d’origine.
  const forkedFrom = (conversation as Conversation & { forkedFrom?: { title: string } }).forkedFrom;
  const origin = conversation.origin?.title ?? forkedFrom?.title;
  return (
    <p className="agents-page__context" title={conversationModelLabel(conversation)}>
      {origin ? `Depuis ${origin} · ` : ""}
      {formatDateTimeShort(conversation.createdAt)}
    </p>
  );
}

const AssistantEntry = memo(function AssistantEntry({
  content,
  cwd,
  timestamp,
  onQuote,
  onFork,
}: {
  content: string;
  cwd: string;
  timestamp?: number;
  onQuote: (text: string) => void;
  onFork?: () => void;
}) {
  const shown = withoutAgentQuestion(content);
  const citedImages = useMemo(() => referencedLocalImages(shown), [shown]);
  const citedFiles = useMemo(() => referencedLocalFiles(shown), [shown]);
  return (
    <li className="agent-chat__entry agent-chat__entry--assistant">
      <strong className="sr-only">Alfred</strong>
      <MessageActions content={shown} timestamp={timestamp} onQuote={onQuote} onFork={onFork}>
        <div className="agent-chat__message">
          <AgentMarkdown text={shown} cwd={cwd} />
          <ConversationImages images={citedImages} label="Images citées" />
          <ConversationFiles files={citedFiles} label="Fichiers cités" />
        </div>
      </MessageActions>
    </li>
  );
});

/**
 * Messages et activités d’un tour, mémorisés sur l’identité de leurs blocs : pendant un flux, seul le bloc qui change
 * est réconcilié.
 */
const Entries = memo(function Entries({
  blocks,
  cwd,
  timestamp,
  onQuote,
  onFork,
  onOpenFile,
}: {
  blocks: Block[];
  cwd: string;
  /** Heure de la réponse, montrée sur le dernier message du tour. */
  timestamp?: number;
  onQuote: (text: string) => void;
  onFork?: () => void;
  onOpenFile: (path: string) => void;
}) {
  return blocks.map((block, index) =>
    block.message !== undefined ? (
      <AssistantEntry
        key={block.key}
        content={block.message}
        cwd={cwd}
        timestamp={index === blocks.length - 1 ? timestamp : undefined}
        onQuote={onQuote}
        onFork={onFork}
      />
    ) : (
      <li key={block.key} className="agent-chat__entry agent-chat__entry--activity">
        <Activities activities={block.activities ?? []} onOpenFile={onOpenFile} />
      </li>
    ),
  );
});

function RunningWork({ startedAt, label }: { startedAt: number; label: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="agent-chat__running-work">
      <span className="agent-chat__running-state" role="status">
        <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
        {label}
      </span>
      <span role="timer">Depuis {duration(now - startedAt)}</span>
      <span>
        Début à{" "}
        <time dateTime={new Date(startedAt).toISOString()}>
          {new Date(startedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </time>
      </span>
    </div>
  );
}

function runningLabel(turn: Turn, runtime: ConversationRuntime): string {
  if (runtime.approvals.length || runtime.questions.length) return "Accord requis";
  if (runtime.status === "connecting") return "Connexion en cours";
  const latest = turn.items.at(-1);
  if (latest?.kind === "message") return "Rédaction en cours";
  if (latest?.kind === "activity" && latest.status === "running")
    return latest.activityKind === "analysis"
      ? "Réflexion en cours"
      : `Outil en cours : ${latest.title || "Exécution"}`;
  return "Travail en cours";
}

type ChangedFile = { path: string; added: number | null; removed: number | null };

/** Fichiers modifiés par un tour, avec leurs lignes ajoutées et retirées quand elles sont connues. */
export function changedFilesOf(turn: Turn): ChangedFile[] {
  return (turn.changedFiles ?? []).map((path) => {
    const lines = turn.changedLines?.[path];
    return { path, added: lines?.added ?? null, removed: lines?.removed ?? null };
  });
}

/**
 * Bilan des fichiers de l’espace modifiés par un tour, repris de `ChangeSummary` de OneApp : nombre de fichiers,
 * total « +a −r », trois fichiers puis « Afficher N de plus », chemins cliquables, « — » si inconnu ; avec
 * l’annulation propre à Alfred.
 */
function ChangeSummary({ conversationId, turn }: { conversationId: string; turn: Turn }) {
  const undoTurn = useAgents((state) => state.undoTurn);
  const spacePath = useShell((state) => state.snapshot?.path);
  const { confirm, confirmDialog } = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const files = changedFilesOf(turn);
  const visible = expanded ? files : files.slice(0, 3);
  const complete = files.length > 0 && files.every((file) => file.added !== null && file.removed !== null);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  // Les chemins du commit sont relatifs à l’espace.
  const openFile = (path: string) => void followLink(path, spacePath ?? "");
  return (
    <section className="agent-chat__change-summary" aria-label="Bilan des modifications">
      {confirmDialog}
      <div className="agent-chat__change-header">
        <span className="agent-chat__change-icon">
          <FileDiff size={18} aria-hidden="true" />
        </span>
        <div className="agent-chat__change-title">
          <strong>
            {files.length
              ? `${files.length} fichier${files.length > 1 ? "s" : ""} de l’espace modifié${files.length > 1 ? "s" : ""}`
              : "L’espace a été modifié"}
          </strong>
          {complete ? (
            <div className="agent-chat__change-totals">
              <span className="agent-chat__change-added">+{added}</span>{" "}
              <span className="agent-chat__change-removed">−{removed}</span>
            </div>
          ) : null}
        </div>
        <Button
          className="agent-chat__change-undo"
          onClick={async () => {
            const accepted = await confirm({
              title: "Annuler cette modification ?",
              message:
                "L’espace revient à son état d’avant ce tour. L’annulation est elle-même enregistrée et peut être défaite.",
              confirmLabel: "Annuler la modification",
            });
            if (!accepted) return;
            try {
              await undoTurn(conversationId, turn.id);
            } catch (error) {
              notify({
                title: "Annulation impossible",
                description: error instanceof Error ? error.message : String(error),
                tone: "error",
              });
            }
          }}
        >
          <Undo2 size={14} aria-hidden="true" /> Annuler cette modification
        </Button>
      </div>
      {files.length ? (
        <ul className="agent-chat__change-files">
          {visible.map(({ path, added: fileAdded, removed: fileRemoved }) => {
            const slash = path.lastIndexOf("/");
            return (
              <li key={path}>
                <div className="agent-chat__change-row">
                  <button type="button" className="agent-chat__change-file" onClick={() => openFile(path)}>
                    <span>{path.slice(0, slash + 1)}</span>
                    {path.slice(slash + 1)}
                  </button>
                  <span className="agent-chat__change-counts">
                    {fileAdded === null || fileRemoved === null ? (
                      "—"
                    ) : (
                      <>
                        <span className="agent-chat__change-added">+{fileAdded}</span>{" "}
                        <span className="agent-chat__change-removed">−{fileRemoved}</span>
                      </>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {files.length > 3 ? (
        <button
          type="button"
          className="agent-chat__change-expand"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded
            ? "Afficher moins"
            : `Afficher ${files.length - 3} fichier${files.length - 3 > 1 ? "s" : ""} de plus`}
          {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
        </button>
      ) : null}
    </section>
  );
}

const UserEntry = memo(function UserEntry({
  turn,
  cwd,
  onResend,
  onFork,
}: {
  turn: Turn;
  cwd: string;
  onResend?: () => void;
  onFork?: () => void;
}) {
  const { attachments, contexts, text, references } = turn.user;
  return (
    <li className="agent-chat__entry agent-chat__entry--user">
      <strong className="sr-only">Vous</strong>
      <MessageActions content={text} delivery={turnDelivery(turn)} onResend={onResend} onFork={onFork}>
        {attachments.length ? <ChatAttachments attachments={attachments} /> : null}
        {contexts.length ? (
          <div className="agent-chat__message-pastes">
            {contexts.map((context) => (
              <TextPreview key={context.id} text={context.text} label={context.title} />
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="agent-chat__message">
            {references?.length ? (
              <ReferencePills text={text} references={references} />
            ) : isLongChatText(text) ? (
              <TextPreview text={text} />
            ) : (
              <AgentMarkdown text={text} cwd={cwd} />
            )}
          </div>
        ) : null}
      </MessageActions>
    </li>
  );
});

/**
 * Tour de la conversation. Mémorisé sur ses propriétés : pendant qu’un agent écrit, les tours terminés gardent le même
 * objet et ne sont pas redessinés ; seul le tour en cours l’est.
 */
const TurnView = memo(function TurnView({
  conversationId,
  cwd,
  turn,
  last,
  working,
  onQuote,
  onOpenFile,
  onRetry,
  resend,
  fork,
}: {
  conversationId: string;
  cwd: string;
  turn: Turn;
  last: boolean;
  /** État du travail en cours, pour le dernier tour pendant une réponse. */
  working?: string;
  onQuote: (text: string) => void;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
  resend?: TurnActions["resend"];
  fork?: TurnActions["fork"];
}) {
  const blocks = useMemo(() => blocksOf(turn.items), [turn.items]);
  const running = turn.status === "running";
  // La réponse finale reste visible ; le travail qui la précède se replie derrière son résumé.
  const lastBlock = blocks.at(-1);
  const final = !running && lastBlock?.message !== undefined ? lastBlock : undefined;
  const work = useMemo(() => (final ? blocks.slice(0, -1) : blocks), [blocks, final]);
  const finalBlocks = useMemo(() => (final ? [final] : []), [final]);
  const onResend = useMemo(
    () => (resend ? () => void resend(conversationId, turn.id).catch(report("Message non relancé")) : undefined),
    [resend, conversationId, turn.id],
  );
  const forkFrom = useCallback(
    (from: "user" | "reply") =>
      fork &&
      void fork(conversationId, turn.id, from)
        .then((result) => {
          const forked = result as { id?: string; draft?: UserMessage } | undefined;
          if (forked?.id && forked.draft) return restoreMessageDraft(forked.id, forked.draft);
        })
        .catch(report("Reprise impossible")),
    [fork, conversationId, turn.id],
  );
  const onForkUser = useMemo(() => (fork ? () => forkFrom("user") : undefined), [fork, forkFrom]);
  const onFork = useMemo(() => (fork ? () => forkFrom("reply") : undefined), [fork, forkFrom]);
  const images = useMemo(() => (running ? [] : producedImages(turn)), [running, turn]);
  const files = useMemo(() => (running ? [] : producedFiles(turn)), [running, turn]);
  const entryProps = { cwd, onQuote, onFork, onOpenFile };
  return (
    <>
      <UserEntry turn={turn} cwd={cwd} onResend={onResend} onFork={onForkUser} />
      <li className="agent-chat__work">
        {running ? (
          <>
            <ol className="agent-chat__work-entries">
              <Entries blocks={blocks} {...entryProps} />
            </ol>
            {working ? <RunningWork startedAt={turn.startedAt} label={working} /> : null}
          </>
        ) : (
          <>
            {work.length ? (
              <Disclosure
                appearance="subtle"
                lazy
                className="agent-chat__work-details"
                label={<span>{turnSummary(turn)}</span>}
              >
                <ol className="agent-chat__work-entries">
                  <Entries blocks={work} {...entryProps} />
                </ol>
              </Disclosure>
            ) : turn.items.length || turn.status === "done" ? (
              <div className="agent-chat__work-summary">{turnSummary(turn)}</div>
            ) : null}
            {final ? (
              <ol className="agent-chat__work-entries">
                <Entries blocks={finalBlocks} timestamp={turn.endedAt} {...entryProps} />
              </ol>
            ) : null}
            <ConversationImages images={images} label="Images du tour" />
            <ConversationFiles files={files} label="Fichiers du tour" />
          </>
        )}
        {turn.status === "cancelled" ? (
          <p className="agent-chat__work-summary" role="status">
            Exécution arrêtée · Travail non terminé
          </p>
        ) : turn.error ? (
          <div className="agent-chat__recovery" role="alert">
            <p>{turn.error}</p>
            {last ? <Button onClick={onRetry}>Réessayer le message</Button> : null}
          </div>
        ) : null}
        {turn.commit ? <ChangeSummary conversationId={conversationId} turn={turn} /> : null}
      </li>
    </>
  );
});

function report(title: string) {
  return (error: unknown) =>
    notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
}

function QuestionCard({ conversation, question }: { conversation: string; question: AgentQuestion }) {
  const answer = useAgents((state) => state.answerQuestion);
  return (
    <PlacementCard
      payload={question.payload}
      onSubmit={(result) => void answer(conversation, question.requestId, result)}
      onCancel={() =>
        void answer(conversation, question.requestId, null, "L’utilisateur a annulé le placement de la page.")
      }
    />
  );
}

/** Champ de saisie de la conversation, sous le relevé : « Autre réponse… » y renvoie. */
function focusComposer(from: HTMLElement | null) {
  const field = from?.parentElement?.querySelector<HTMLElement>(
    '.agents-page__footer textarea, .agents-page__footer [contenteditable="true"]',
  );
  field?.focus();
}

/** Relevé d’une conversation : chaque tour, puis les cartes qui attendent une réponse de l’utilisateur. */
export function Transcript({
  conversation,
  runtime,
  header,
}: {
  conversation: Conversation;
  runtime: ConversationRuntime;
  /**
   * Ligne au-dessus du relevé, dans la colonne défilante. Quand elle est demandée, c’est l’en-tête de OneApp
   * (« Depuis {origine} · {date} », modèle en infobulle) qui s’affiche, quel que soit le contenu passé.
   */
  header?: ReactNode;
}) {
  const scroller = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const retry = useAgents((state) => state.retry);
  const send = useAgents((state) => state.send);
  const answerApproval = useAgents((state) => state.answerApproval);
  const resend = useAgents((state) => (state as unknown as TurnActions).resend);
  const fork = useAgents((state) => (state as unknown as TurnActions).fork);
  const sent = useAgents((state) => (state as unknown as TurnActions).follow?.[conversation.id] ?? 0);
  const { id: conversationId, cwd, turns } = conversation;

  // Une longue conversation s’ouvre sur ses derniers échanges ; les précédents suivent en transition, interruptible,
  // pour que l’interface ne se fige pas à l’ouverture.
  const [shown, setShown] = useState({ id: conversationId, all: turns.length <= RECENT_TURNS });
  const complete = (shown.id === conversationId && shown.all) || turns.length <= RECENT_TURNS;
  useEffect(() => {
    if (complete) return;
    const frame = requestAnimationFrame(() => startTransition(() => setShown({ id: conversationId, all: true })));
    return () => cancelAnimationFrame(frame);
  }, [complete, conversationId]);
  const visibleTurns = complete ? turns : turns.slice(-RECENT_TURNS);

  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.items.at(-1);
  const question = agentQuestion(conversation, runtime);
  const permission = runtime.approvals[0];
  const growth = `${visibleTurns.length}:${lastTurn?.items.length}:${lastItem?.kind === "message" ? lastItem.content.length : 0}:${runtime.approvals.length}:${runtime.questions.length}:${question ? 1 : 0}`;

  // Après un envoi de l’utilisateur, le relevé se recolle en bas, même s’il était remonté.
  useLayoutEffect(() => {
    if (!sent) return;
    pinned.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [sent]);

  // Le relevé suit la réponse tant que l’utilisateur est resté en bas ; s’il remonte, on ne le ramène pas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `growth` résume ce qui allonge le relevé.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [growth]);

  const onQuote = useCallback(
    (text: string) => window.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: { conversationId, text } })),
    [conversationId],
  );
  const onOpenFile = useCallback((path: string) => void followLink(path, cwd), [cwd]);
  const onRetry = useCallback(
    () => void retry(conversationId).catch(report("Message non envoyé")),
    [retry, conversationId],
  );
  const resources = useMemo<ConversationResources>(
    () => ({
      loadImage: (reference: string) => loadConversationImage(cwd, reference),
      files: conversationFileActions(cwd),
      quote: onQuote,
    }),
    [cwd, onQuote],
  );
  const working =
    lastTurn?.status === "running" && runtime.status !== "idle" ? runningLabel(lastTurn, runtime) : undefined;

  return (
    <section
      ref={scroller}
      className="agents-page__transcript"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: la conversation défilante doit rester accessible au clavier.
      tabIndex={0}
      aria-label={`Conversation : ${conversation.title}`}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      }}
    >
      <ErrorBoundary resetKey={conversationId}>
        <ConversationResourcesContext.Provider value={resources}>
          <div className="agents-page__column">
            {header !== undefined && header !== null && header !== false ? (
              <TranscriptHeader conversation={conversation} />
            ) : null}
            <ol className="agent-chat__entries">
              {visibleTurns.map((turn, index) => {
                const last = index === visibleTurns.length - 1;
                return (
                  <TurnView
                    key={turn.id}
                    conversationId={conversationId}
                    cwd={cwd}
                    turn={turn}
                    last={last}
                    working={last ? working : undefined}
                    onQuote={onQuote}
                    onOpenFile={onOpenFile}
                    onRetry={onRetry}
                    resend={resend}
                    fork={fork}
                  />
                );
              })}
            </ol>
            {runtime.questions.map((placement) => (
              <QuestionCard key={placement.requestId} conversation={conversationId} question={placement} />
            ))}
            {question || permission ? (
              <div className="agent-chat__question-dock">
                <AgentQuestionCard
                  key={`${conversationId}:${lastTurn?.id ?? ""}:${permission?.id ?? ""}`}
                  question={question}
                  permission={permission as ApprovalRequest | undefined}
                  disabled={!permission && runtime.status !== "idle"}
                  onAnswer={(text) =>
                    void send(conversationId, { text, attachments: [], contexts: [] }).catch(
                      report("Message non envoyé"),
                    )
                  }
                  onRespond={(optionId) =>
                    permission &&
                    void answerApproval(conversationId, permission.id, optionId).catch(report("Réponse non transmise"))
                  }
                  onOther={() => focusComposer(scroller.current)}
                />
              </div>
            ) : null}
          </div>
        </ConversationResourcesContext.Provider>
      </ErrorBoundary>
    </section>
  );
}
