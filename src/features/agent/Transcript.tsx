import { Button, Disclosure, IconButton, Markdown, useConfirm } from "@alfred/ui";
import { Check, ChevronDown, ChevronUp, Copy, FileDiff, FileText, LoaderCircle, Quote, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { notify } from "../../shell/notifications";
import { Activities, type Activity, hasActivityOutput } from "./Activities";
import { followLink, isImage, loadImage } from "./files";
import type { ApprovalRequest } from "./harness";
import { agentFileLinks } from "./lib/agentFileLinks";
import type { AgentQuestion, Conversation, ConversationRuntime, Turn, TurnItem } from "./model";
import { PlacementCard } from "./PlacementCard";
import { useAgents } from "./store";
import { TextPreview } from "./TextPreview";

/*
 * Relevé d’une conversation, repris de `ChatTranscript` de OneApp : le message de l’utilisateur en bulle à droite,
 * puis le travail de l’agent replié derrière son résumé (« A travaillé pendant 12 s · 3 outils appelés ») et sa
 * réponse finale en clair, enfin le bilan des fichiers de l’espace modifiés avec « Annuler cette modification ».
 */

function LocalImage({ path, cwd, alt }: { path: string; cwd: string; alt: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    loadImage(path, cwd).then(
      (url) => active && setSource(url),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [path, cwd]);
  return source ? (
    <span className="agent-chat__image">
      <img src={source} alt={alt} />
    </span>
  ) : null;
}

function FileCard({ path, cwd }: { path: string; cwd: string }) {
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <button
      type="button"
      className="agent-chat__attachment-file"
      title={path}
      onClick={() => void followLink(path, cwd)}
    >
      <FileText size={15} aria-hidden="true" />
      <span>{name}</span>
    </button>
  );
}

/** Images et fichiers produits par une activité. */
function activityExtras(activity: Activity, cwd: string): ReactNode {
  if (!activity.images?.length && !activity.files?.length) return null;
  return (
    <ul className="agent-chat__message-attachments">
      {activity.images?.map((image) => (
        <li key={image}>
          <LocalImage path={image} cwd={cwd} alt={`Image produite par ${activity.title}`} />
        </li>
      ))}
      {activity.files?.map((file) => (
        <li key={file}>
          <FileCard path={file} cwd={cwd} />
        </li>
      ))}
    </ul>
  );
}

/** Événement qui demande à la saisie d’une conversation d’ajouter une citation (« Citer dans la réponse »). */
export const QUOTE_EVENT = "alfred:agent-quote";

/** Copie et, pour l’agent, citation du message au survol, comme les actions de message de OneApp. */
function MessageActions({ content, quoteIn }: { content: string; quoteIn?: string }) {
  const [copied, setCopied] = useState(false);
  if (!content.trim()) return null;
  return (
    <fieldset className="agent-chat__message-actions" aria-label="Actions du message">
      <IconButton
        size="small"
        label={copied ? "Message copié" : "Copier le message"}
        tooltip={copied ? "Copié" : "Copier"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            notify({ title: "Copie impossible", tone: "error" });
          }
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </IconButton>
      {quoteIn ? (
        <IconButton
          size="small"
          label="Citer dans la réponse"
          tooltip="Citer"
          onClick={() =>
            window.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: { conversationId: quoteIn, text: content } }))
          }
        >
          <Quote aria-hidden="true" />
        </IconButton>
      ) : null}
    </fieldset>
  );
}

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

function Entries({ blocks, cwd, conversationId }: { blocks: Block[]; cwd: string; conversationId: string }) {
  const plugins = useMemo(() => [agentFileLinks], []);
  return blocks.map((block) =>
    block.message !== undefined ? (
      <li key={block.key} className="agent-chat__entry agent-chat__entry--assistant">
        <strong className="sr-only">Agent</strong>
        <div className="agent-chat__message">
          <Markdown remarkPlugins={plugins} onLink={(href) => void followLink(href, cwd)}>
            {block.message}
          </Markdown>
        </div>
        <MessageActions content={block.message} quoteIn={conversationId} />
      </li>
    ) : (
      <li key={block.key} className="agent-chat__entry agent-chat__entry--activity">
        <Activities activities={block.activities ?? []} renderExtras={(activity) => activityExtras(activity, cwd)} />
      </li>
    ),
  );
}

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

/** Bilan des fichiers de l’espace modifiés par un tour, repris de `ChangeSummary` de OneApp, avec l’annulation. */
function ChangeSummary({ conversation, turn }: { conversation: Conversation; turn: Turn }) {
  const undoTurn = useAgents((state) => state.undoTurn);
  const { confirm, confirmDialog } = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const files = turn.changedFiles ?? [];
  const visible = expanded ? files : files.slice(0, 3);
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
              await undoTurn(conversation.id, turn.id);
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
          {visible.map((path) => {
            const slash = path.lastIndexOf("/");
            return (
              <li key={path}>
                <div className="agent-chat__change-row">
                  <span className="agent-chat__change-file">
                    <span>{path.slice(0, slash + 1)}</span>
                    {path.slice(slash + 1)}
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

function UserEntry({ turn, cwd }: { turn: Turn; cwd: string }) {
  const { attachments, contexts, text } = turn.user;
  return (
    <li className="agent-chat__entry agent-chat__entry--user">
      <strong className="sr-only">Vous</strong>
      <div className="agent-chat__message-body">
        {attachments.length ? (
          <ul className="agent-chat__message-attachments">
            {attachments.map((attachment) => (
              <li key={attachment.path}>
                {isImage(attachment.path) ? (
                  <LocalImage path={attachment.path} cwd={cwd} alt={attachment.name} />
                ) : (
                  <FileCard path={attachment.path} cwd={cwd} />
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {contexts.length ? (
          <div className="agent-chat__message-pastes">
            {contexts.map((context) => (
              <TextPreview key={context.id} text={context.text} label={context.title} />
            ))}
          </div>
        ) : null}
        {text ? <div className="agent-chat__message">{text}</div> : null}
      </div>
      <MessageActions content={text} />
    </li>
  );
}

function TurnView({
  conversation,
  turn,
  runtime,
  last,
}: {
  conversation: Conversation;
  turn: Turn;
  runtime: ConversationRuntime;
  last: boolean;
}) {
  const cwd = conversation.cwd;
  const blocks = useMemo(() => blocksOf(turn.items), [turn.items]);
  const running = turn.status === "running";
  // La réponse finale reste visible ; le travail qui la précède se replie derrière son résumé.
  const lastBlock = blocks.at(-1);
  const final = !running && lastBlock?.message !== undefined ? lastBlock : undefined;
  const work = final ? blocks.slice(0, -1) : blocks;
  return (
    <>
      <UserEntry turn={turn} cwd={cwd} />
      <li className="agent-chat__work">
        {running ? (
          <>
            <ol className="agent-chat__work-entries">
              <Entries blocks={blocks} cwd={cwd} conversationId={conversation.id} />
            </ol>
            {last ? <RunningWork startedAt={turn.startedAt} label={runningLabel(turn, runtime)} /> : null}
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
                  <Entries blocks={work} cwd={cwd} conversationId={conversation.id} />
                </ol>
              </Disclosure>
            ) : turn.items.length || turn.status === "done" ? (
              <div className="agent-chat__work-summary">{turnSummary(turn)}</div>
            ) : null}
            {final ? (
              <ol className="agent-chat__work-entries">
                <Entries blocks={[final]} cwd={cwd} conversationId={conversation.id} />
              </ol>
            ) : null}
          </>
        )}
        {turn.error ? (
          <div className="agent-chat__recovery" role="alert">
            <p>{turn.error}</p>
          </div>
        ) : null}
        {turn.status === "cancelled" ? (
          <p className="agent-chat__work-summary" role="status">
            Exécution arrêtée · Travail non terminé
          </p>
        ) : null}
        {turn.commit ? <ChangeSummary conversation={conversation} turn={turn} /> : null}
      </li>
    </>
  );
}

/** Décision attendue de l’utilisateur, habillée comme celles de OneApp. */
function ApprovalCard({ conversation, request }: { conversation: string; request: ApprovalRequest }) {
  const answer = useAgents((state) => state.answerApproval);
  return (
    <section className="agent-chat__permission agent-card" aria-label={`Accord demandé : ${request.title}`}>
      <h3>{request.title}</h3>
      {request.detail ? <pre className="agent-card__detail">{request.detail}</pre> : null}
      <div className="agent-chat__actions">
        {request.options.map((option) => (
          <Button
            key={option.id}
            variant={option.kind === "allow" ? "primary" : option.kind === "deny" ? "danger" : "secondary"}
            onClick={() => void answer(conversation, request.id, option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </section>
  );
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

/** Relevé d’une conversation : chaque tour, puis les cartes qui attendent une réponse de l’utilisateur. */
export function Transcript({
  conversation,
  runtime,
  header,
}: {
  conversation: Conversation;
  runtime: ConversationRuntime;
  /** Ligne au-dessus du relevé (date de la conversation), dans la colonne défilante. */
  header?: ReactNode;
}) {
  const scroller = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const lastTurn = conversation.turns.at(-1);
  const lastItem = lastTurn?.items.at(-1);
  const growth = `${conversation.turns.length}:${lastTurn?.items.length}:${lastItem?.kind === "message" ? lastItem.content.length : 0}:${runtime.approvals.length}:${runtime.questions.length}`;

  // Le relevé suit la réponse tant que l’utilisateur est resté en bas ; s’il remonte, on ne le ramène pas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `growth` résume ce qui allonge le relevé.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [growth]);

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
      <div className="agents-page__column">
        {header}
        <ol className="agent-chat__entries">
          {conversation.turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              conversation={conversation}
              turn={turn}
              runtime={runtime}
              last={index === conversation.turns.length - 1}
            />
          ))}
        </ol>
        {runtime.approvals.map((request) => (
          <ApprovalCard key={request.id} conversation={conversation.id} request={request} />
        ))}
        {runtime.questions.map((question) => (
          <QuestionCard key={question.requestId} conversation={conversation.id} question={question} />
        ))}
      </div>
    </section>
  );
}
