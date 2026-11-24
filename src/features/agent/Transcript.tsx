import { ChevronDown, ChevronUp, Undo2 } from "lucide-react";
import { memo, type ReactNode, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AttachmentChip,
  AttachmentList,
  Button,
  Card,
  ChatMessage,
  ChatTranscript,
  DiffStat,
  Link,
  MentionText,
  MessageActions,
  useConfirm,
  WorkStatus,
  WorkSummary,
} from "socle-ui";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { Activities, type Activity, hasActivityOutput } from "./Activities";
import { restoreMessageDraft } from "./Composer";
import { effortLabel } from "./effort";
import { followLink } from "./files";
import type { ApprovalRequest } from "./harness";
import { activityImageOutput, loadConversationImage, referencedLocalImages } from "./lib/chatImages";
import { mentionReferences } from "./lib/composerReferences";
import { referencedLocalFiles } from "./lib/conversationFileKinds";
import { type Delivery, deliveryLabel, formatDateTimeShort } from "./lib/delivery";
import { pageCaptures } from "./lib/pageCaptures";
import type { AgentQuestion, Conversation, ConversationRuntime, Turn, TurnItem, UserMessage } from "./model";
import { PlacementCard } from "./PlacementCard";
import { useAgents } from "./store";
import { AgentMarkdown } from "./transcript/AgentMarkdown";
import { AgentQuestionCard } from "./transcript/AgentQuestionCard";
import { agentQuestion, withoutAgentQuestion } from "./transcript/agentQuestions";
import { ChatAttachments } from "./transcript/ChatAttachments";
import { ConversationFiles } from "./transcript/ConversationFiles";
import { ConversationImages } from "./transcript/ConversationImages";
import { ErrorBoundary } from "./transcript/ErrorBoundary";
import { conversationFileActions } from "./transcript/fileActions";
import { PageCaptures } from "./transcript/PageCaptures";
import { type ConversationResources, ConversationResourcesContext } from "./transcript/resources";
import "./transcript/transcript.css";

/*
 * Relevé d’une conversation, repris de `ChatTranscript` de OneApp : le message de l’utilisateur en bulle à droite,
 * puis le travail de l’agent replié derrière son résumé (« A travaillé pendant 12 s · 3 outils appelés ») et sa
 * réponse finale en clair, les images et fichiers du tour. Le bilan des fichiers modifiés, avec « Annuler cette
 * modification », ne vient qu’à la fin d’une suite de messages enchaînés et couvre toute la suite. La question de
 * l’agent ou l’autorisation attendue se pose dans une carte au-dessus de la saisie.
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

type Block = { key: string; message?: string; occurredAt?: number; activities?: Activity[] };

/** Suite des éléments d’un tour : messages et séries d’activités consécutives. */
function blocksOf(items: readonly TurnItem[]): Block[] {
  const result: Block[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      if (item.content.trim()) result.push({ key: item.id, message: item.content, occurredAt: item.occurredAt });
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

/** Outils appelés pendant un tour, sans la réflexion (« 0 outils appelés » compris), comme `workSummary` de OneApp. */
export function turnToolCount(turn: Turn): number {
  return turn.items.filter((item) => item.kind === "activity" && item.activityKind !== "analysis").length;
}

/**
 * Réponse finale d’un tour terminé, comme `work` de OneApp : le dernier message non vide, même suivi d’activités. Elle
 * reste visible sous le résumé ; le reste du tour se replie derrière lui.
 */
export function finalMessage(turn: Turn): Extract<TurnItem, { kind: "message" }> | undefined {
  if (turn.status !== "done") return undefined;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.kind === "message" && item.content.trim()) return item;
  }
  return undefined;
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

/** Horodatage court d’un message, au bout de sa rangée d’actions. */
function Time({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{formatDateTimeShort(value)}</time>;
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
    <ChatMessage
      role="assistant"
      author="Alfred"
      actions={<MessageActions content={shown} onQuote={onQuote} onFork={onFork} />}
      meta={
        timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime()) ? <Time value={timestamp} /> : null
      }
    >
      <AgentMarkdown text={shown} cwd={cwd} />
      <ConversationImages images={citedImages} label="Images citées" />
      <ConversationFiles files={citedFiles} label="Fichiers cités" />
    </ChatMessage>
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
        // Comme OneApp : chaque message de l’agent porte son heure ; un message plus ancien, sans heure, prend celle du tour.
        timestamp={block.occurredAt ?? (index === blocks.length - 1 ? timestamp : undefined)}
        onQuote={onQuote}
        onFork={onFork}
      />
    ) : (
      <Activities key={block.key} activities={block.activities ?? []} onOpenFile={onOpenFile} />
    ),
  );
});

/** État du travail en cours, repris de `currentWorkActivity` de OneApp. */
export function runningLabel(turn: Turn, runtime: ConversationRuntime): string {
  if (runtime.approvals.length) return "Autorisation requise";
  if (runtime.status === "connecting") return "Connexion en cours";
  const latest = turn.items.at(-1);
  if (latest?.kind === "message") return "Rédaction en cours";
  if (latest?.kind === "activity" && !["completed", "failed", "cancelled", "stopped"].includes(latest.status))
    return latest.activityKind === "analysis"
      ? "Réflexion en cours"
      : `Outil en cours : ${latest.title || "Exécution"}`;
  return "Travail en cours";
}

type ChangedFile = { path: string; added: number | null; removed: number | null };

/**
 * Délai au-delà duquel un message ne continue plus le précédent. Un message mis en file ou glissé dans la réponse
 * part dès la fin du tour d’avant ; un message envoyé juste après sa fin continue aussi la suite.
 */
export const CHAINED_TURN_GAP = 2 * 60_000;

/** Suites de tours enchaînés : chaque tour parti moins de `CHAINED_TURN_GAP` après la fin du précédent le continue. */
export function turnSequences(turns: readonly Turn[]): Turn[][] {
  const sequences: Turn[][] = [];
  for (const turn of turns) {
    const sequence = sequences.at(-1);
    const previous = sequence?.at(-1);
    const chained =
      previous !== undefined &&
      (previous.endedAt === undefined || turn.startedAt - previous.endedAt <= CHAINED_TURN_GAP);
    if (sequence && chained) sequence.push(turn);
    else sequences.push([turn]);
  }
  return sequences;
}

/** La conversation en a fini : l’agent ne répond plus, aucun tour ne tourne, aucun message n’attend dans la file. */
export function conversationSettled(conversation: Conversation, runtime: ConversationRuntime): boolean {
  return runtime.status === "idle" && !runtime.queued.length && conversation.turns.at(-1)?.status !== "running";
}

/**
 * Bilans des modifications, rangés sous le dernier tour de chaque suite : une suite qui continue n’en a pas encore,
 * pour que rien ne marque une fin entre deux messages qui s’enchaînent. Seuls les tours qui ont un commit y figurent.
 */
export function changeSummaries(turns: readonly Turn[], settled: boolean): Map<string, Turn[]> {
  const summaries = new Map<string, Turn[]>();
  const sequences = turnSequences(turns);
  sequences.forEach((sequence, index) => {
    if (index === sequences.length - 1 && !settled) return;
    const changed = sequence.filter((turn) => turn.commit);
    const last = sequence.at(-1);
    if (changed.length && last) summaries.set(last.id, changed);
  });
  return summaries;
}

/**
 * Fichiers modifiés par un ou plusieurs tours, dans l’ordre où ils l’ont été, avec leurs lignes ajoutées et retirées
 * cumulées quand elles sont connues pour chaque tour qui les a touchés.
 */
export function changedFilesOf(turns: Turn | readonly Turn[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const turn of Array.isArray(turns) ? turns : [turns as Turn]) {
    for (const path of turn.changedFiles ?? []) {
      const lines = turn.changedLines?.[path];
      const known = files.get(path);
      if (!known) files.set(path, { path, added: lines?.added ?? null, removed: lines?.removed ?? null });
      else
        files.set(path, {
          path,
          added: known.added === null || !lines ? null : known.added + lines.added,
          removed: known.removed === null || !lines ? null : known.removed + lines.removed,
        });
    }
  }
  return [...files.values()];
}

/** Garde le même tableau tant que la suite garde les mêmes tours : les tours terminés ne sont pas redessinés. */
function useStableSummaries(summaries: Map<string, Turn[]>): Map<string, Turn[]> {
  const previous = useRef(new Map<string, Turn[]>());
  const stable = new Map<string, Turn[]>();
  for (const [id, turns] of summaries) {
    const known = previous.current.get(id);
    stable.set(
      id,
      known && known.length === turns.length && known.every((turn, index) => turn === turns[index]) ? known : turns,
    );
  }
  previous.current = stable;
  return stable;
}

/**
 * Bilan des fichiers de l’espace modifiés par une suite de tours, repris de `ChangeSummary` de OneApp : nombre de
 * fichiers, total « +a −r », trois fichiers puis « Afficher N de plus », chemins cliquables, « — » si inconnu ; avec
 * l’annulation propre à Alfred, qui défait toute la suite.
 */
function ChangeSummary({ conversationId, turns }: { conversationId: string; turns: Turn[] }) {
  const undoTurns = useAgents((state) => state.undoTurns);
  const spacePath = useShell((state) => state.snapshot?.path);
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(() => changedFilesOf(turns), [turns]);
  const visible = expanded ? files : files.slice(0, 3);
  const complete = files.length > 0 && files.every((file) => file.added !== null && file.removed !== null);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  // Les chemins du commit sont relatifs à l’espace.
  const openFile = (path: string) => void followLink(path, spacePath ?? "");
  const undo = async () => {
    const accepted = await confirm({
      title: "Annuler cette modification ?",
      message: `L’espace de travail revient à son état d’avant ${turns.length > 1 ? "ces messages" : "ce tour"}. L’annulation est elle-même enregistrée et peut être défaite.`,
      confirmLabel: "Annuler la modification",
    });
    if (!accepted) return;
    try {
      await undoTurns(
        conversationId,
        turns.map((turn) => turn.id),
      );
    } catch (error) {
      notify({
        title: "Annulation impossible",
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };
  return (
    <section aria-label="Bilan des modifications">
      <Card
        title={
          files.length
            ? `${files.length} fichier${files.length > 1 ? "s" : ""} de l’espace de travail modifié${files.length > 1 ? "s" : ""}`
            : "L’espace de travail a été modifié"
        }
        actions={[
          {
            id: "undo",
            label: "Annuler cette modification",
            icon: <Undo2 size={14} />,
            onPress: () => void undo(),
          },
        ]}
      >
        {complete ? <DiffStat added={added} removed={removed} /> : null}
        {files.length ? (
          // Hors design : liste de fichiers avec leurs compteurs (voir docs/socle-propositions.md, « Manques vus en 1.4 »).
          <ul className="agent-chat__change-files">
            {visible.map(({ path, added: fileAdded, removed: fileRemoved }) => (
              <li key={path} className="agent-chat__change-row">
                <Link onPress={() => openFile(path)}>{path}</Link>
                {fileAdded === null || fileRemoved === null ? (
                  "—"
                ) : (
                  <DiffStat added={fileAdded} removed={fileRemoved} />
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {files.length > 3 ? (
          <Button
            size="sm"
            variant="subtle"
            icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            onPress={() => setExpanded(!expanded)}
          >
            {expanded
              ? "Afficher moins"
              : `Afficher ${files.length - 3} fichier${files.length - 3 > 1 ? "s" : ""} de plus`}
          </Button>
        ) : null}
      </Card>
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
  const delivery = turnDelivery(turn);
  const mentions = useMemo(() => mentionReferences(references ?? []), [references]);
  const pieces =
    attachments.length || contexts.length ? (
      <>
        {attachments.length ? <ChatAttachments attachments={attachments} /> : null}
        <AttachmentList>
          {contexts.map((context) => (
            <AttachmentChip key={context.id} kind="text" name={context.title} text={context.text} />
          ))}
        </AttachmentList>
      </>
    ) : null;
  const body = !text ? null : mentions.length ? (
    <MentionText text={text} references={mentions} />
  ) : isLongChatText(text) ? (
    <AttachmentChip kind="text" name="Message" text={text} />
  ) : (
    <AgentMarkdown text={text} cwd={cwd} />
  );
  return (
    <ChatMessage
      role="user"
      // Sans texte, les pièces jointes forment le message : pas de bulle vide sous elles.
      attachments={body ? pieces : null}
      actions={<MessageActions content={text} onRetry={onResend} onFork={onFork} />}
      meta={
        <>
          {deliveryLabel(delivery.status)} · <Time value={delivery.startedAt} />
        </>
      }
    >
      {body ?? pieces}
    </ChatMessage>
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
  changes,
}: {
  conversationId: string;
  cwd: string;
  turn: Turn;
  last: boolean;
  /** Tours de la suite qui finit ici et qui ont modifié l’espace : leur bilan se montre sous ce tour. */
  changes?: Turn[];
  /** État du travail en cours, pour le dernier tour pendant une réponse. */
  working?: string;
  onQuote: (text: string) => void;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
  resend?: TurnActions["resend"];
  fork?: TurnActions["fork"];
}) {
  // Comme OneApp, seul un tour terminé se replie derrière son résumé ; un tour en cours, arrêté ou en erreur montre
  // tout son travail. La réponse finale reste visible sous le résumé.
  const completed = turn.status === "done";
  const final = useMemo(() => finalMessage(turn), [turn]);
  const blocks = useMemo(
    () => blocksOf(final ? turn.items.filter((item) => item !== final) : turn.items),
    [turn.items, final],
  );
  const finalBlocks = useMemo<Block[]>(
    () => (final ? [{ key: final.id, message: final.content, occurredAt: final.occurredAt }] : []),
    [final],
  );
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
  const images = useMemo(() => (completed ? producedImages(turn) : []), [completed, turn]);
  const files = useMemo(() => (completed ? producedFiles(turn) : []), [completed, turn]);
  const captures = useMemo(() => pageCaptures(turn), [turn]);
  const entryProps = { cwd, onQuote, onFork, onOpenFile };
  return (
    <>
      {/* Comme OneApp : une relance reprend le même message, sa bulle n’est pas redessinée. */}
      {turn.retryOf ? null : <UserEntry turn={turn} cwd={cwd} onResend={onResend} onFork={onForkUser} />}
      {!completed ? (
        <>
          <Entries blocks={blocks} {...entryProps} />
          <PageCaptures captures={captures} />
          {working && turn.status === "running" && turn.endedAt === undefined ? (
            <WorkStatus startedAt={turn.startedAt} label={working} />
          ) : null}
        </>
      ) : (
        <>
          <WorkSummary durationMs={(turn.endedAt ?? turn.startedAt) - turn.startedAt} toolCount={turnToolCount(turn)}>
            {blocks.length ? <Entries blocks={blocks} {...entryProps} /> : null}
          </WorkSummary>
          <PageCaptures captures={captures} />
          {final ? <Entries blocks={finalBlocks} timestamp={turn.endedAt} {...entryProps} /> : null}
          <ConversationImages images={images} label="Images du tour" />
          <ConversationFiles files={files} label="Fichiers du tour" />
        </>
      )}
      {/* Comme OneApp : l’arrêt et l’erreur ne se lisent qu’en bas de la conversation, tant qu’elle en reste là. */}
      {last && turn.status === "cancelled" ? (
        <Alert tone="warning" announce>
          Exécution arrêtée · Travail non terminé
        </Alert>
      ) : last && turn.error ? (
        <Alert tone="danger" action={{ label: "Réessayer le message", onPress: onRetry }}>
          {turn.error}
        </Alert>
      ) : null}
      {changes ? <ChangeSummary conversationId={conversationId} turns={changes} /> : null}
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

/**
 * Question de l’agent ou autorisation attendue, reprise de OneApp, où elle se pose dans le pied de la page, au-dessus
 * de la saisie (`agents-page__question`). Rien quand aucune réponse n’est attendue.
 */
export function ConversationQuestion({
  conversation,
  runtime,
}: {
  conversation: Conversation;
  runtime: ConversationRuntime;
}) {
  const send = useAgents((state) => state.send);
  const answerApproval = useAgents((state) => state.answerApproval);
  const question = agentQuestion(conversation, runtime);
  const permission = runtime.approvals[0];
  if (!question && !permission) return null;
  const { id } = conversation;
  return (
    <AgentQuestionCard
      key={`${id}:${conversation.turns.at(-1)?.id ?? ""}:${permission?.id ?? ""}`}
      question={question}
      permission={permission as ApprovalRequest | undefined}
      disabled={!permission && runtime.status !== "idle"}
      onAnswer={(text) => void send(id, { text, attachments: [], contexts: [] }).catch(report("Message non envoyé"))}
      onRespond={(optionId) =>
        permission && void answerApproval(id, permission.id, optionId).catch(report("Réponse non transmise"))
      }
    />
  );
}

/**
 * Relevé d’une conversation (`ChatTranscript` de Socle) : chaque tour, puis les cartes de placement. Il suit le bas
 * tant que l’utilisateur y reste, et s’y recolle à l’ouverture et à chaque envoi. La question de l’agent se pose hors
 * du relevé, au-dessus de la saisie (`ConversationQuestion`).
 */
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
  const retry = useAgents((state) => state.retry);
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
  // Le bilan ne vient qu’à la fin d’une suite de messages : tant que l’agent répond ou qu’un message attend, rien ne
  // marque de fin.
  const settled = conversationSettled(conversation, runtime);
  const summaries = useStableSummaries(useMemo(() => changeSummaries(turns, settled), [turns, settled]));

  return (
    <ChatTranscript
      label={`Conversation de ${conversation.title}`}
      // Une conversation ouverte part du bas ; un envoi de l’utilisateur l’y recolle, même s’il était remonté.
      followKey={`${conversationId}:${sent}`}
      announce={settled && lastTurn?.status === "done" ? "Réponse terminée" : ""}
    >
      <ErrorBoundary resetKey={conversationId}>
        <ConversationResourcesContext.Provider value={resources}>
          {header !== undefined && header !== null && header !== false ? (
            <TranscriptHeader conversation={conversation} />
          ) : null}
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
                changes={summaries.get(turn.id)}
              />
            );
          })}
          {runtime.questions.map((placement) => (
            <QuestionCard key={placement.requestId} conversation={conversationId} question={placement} />
          ))}
        </ConversationResourcesContext.Provider>
      </ErrorBoundary>
    </ChatTranscript>
  );
}
