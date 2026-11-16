import { Disclosure } from "@alfred/ui";
import { BookOpen, Brain, FolderOpen, LoaderCircle, Pencil, Search, TerminalSquare, Wrench } from "lucide-react";
import { useMemo } from "react";
import type { ActivityAction } from "./harness";
import { isAgentFileReference } from "./lib/agentFileLinks";
import { activityImageOutput } from "./lib/chatImages";
import type { TurnItem } from "./model";
import { ConversationFiles } from "./transcript/ConversationFiles";
import { ConversationImages } from "./transcript/ConversationImages";
import { ImagePreview } from "./transcript/ImagePreview";

/**
 * Activités de l’agent, reprises de `ChatActivities` de OneApp : une activité seule s’affiche sur sa ligne, une suite
 * d’activités se replie derrière un résumé (« 3 outils exécutés »), le détail de chacune s’ouvre à la demande.
 */
export type Activity = Extract<TurnItem, { kind: "activity" }>;

/**
 * Titre d’une activité, comme `activityTitle` de OneApp : une commande se lit « Exécuté {commande} », que le détail
 * soit le texte de la commande (Codex) ou ses paramètres JSON.
 */
function activityTitle(activity: Activity): string {
  const title = activity.title || "Outil";
  if (!/^(?:command|commande|exec_command|terminal|shell|run command)$/i.test(title.trim()) || !activity.detail)
    return title;
  try {
    const input: unknown = JSON.parse(activity.detail);
    if (typeof input === "string") return `Exécuté ${input}`;
    if (input && typeof input === "object") {
      const object = input as Record<string, unknown>;
      const command = object.command ?? object.cmd;
      if (typeof command === "string" && command.trim()) return `Exécuté ${command}`;
    }
  } catch {
    // Le détail est directement le texte de la commande.
    if (activity.detail.trim()) return `Exécuté ${activity.detail}`;
  }
  return title;
}

function activityIcon(activity: Activity) {
  if (activity.activityKind === "command") return TerminalSquare;
  if (activity.activityKind === "file") return Pencil;
  if (activity.activityKind === "search") return Search;
  const title = activityTitle(activity);
  if (/^(read|lire|lecture)\b/i.test(title)) return BookOpen;
  if (/^(edited|edit|modified|modifier|modifié|écrit|write)\b/i.test(title)) return Pencil;
  if (/^(searched|search|recherché|recherche|chercher)\b/i.test(title)) return Search;
  if (/^(ran|run|exécuté|execute|commande|command)(?:\s|$)/i.test(title)) return TerminalSquare;
  return Wrench;
}

export function hasActivityOutput(activity: Activity): boolean {
  return Boolean(
    activity.detail?.trim() || activity.content?.trim() || activity.images?.length || activity.files?.length,
  );
}

/** Statut lu d’une activité ; « Arrêté » pour une activité interrompue (`cancelled` ou `stopped`, selon le harnais). */
export function activityStatusLabel(status: string): string {
  return status === "failed"
    ? "Échec"
    : status === "completed"
      ? "Terminé"
      : status === "cancelled" || status === "stopped"
        ? "Arrêté"
        : "En cours";
}

function isRunning(activity: Activity): boolean {
  return !["completed", "failed", "cancelled", "stopped"].includes(activity.status);
}

function ActivityLabel({ activity }: { activity: Activity }) {
  const running = isRunning(activity);
  const Icon = running ? LoaderCircle : activity.activityKind === "analysis" ? Brain : activityIcon(activity);
  const title = activityTitle(activity);
  return (
    <>
      <Icon size={15} className={running ? "is-spinning" : undefined} aria-hidden="true" />
      <span className="agent-chat__tool-title" title={title}>
        {title.replace(/\s*\n\s*/g, " ")}
      </span>
      <span className={activity.status === "failed" ? "agent-chat__tool-status is-failed" : "sr-only"}>
        {activityStatusLabel(activity.status)}
      </span>
    </>
  );
}

function contentKey(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `${content.length}:${hash >>> 0}`;
}

/** Détail d’une activité : sa sortie en lecture seule, puis ses images et fichiers, comme dans OneApp. */
function ActivityOutput({ activity }: { activity: Activity }) {
  const output = useMemo(() => activityImageOutput(activity.content ?? ""), [activity.content]);
  const images = useMemo(() => {
    const occurrences = new Map<string, number>();
    return output.images.map((src) => {
      const occurrence = occurrences.get(src) ?? 0;
      occurrences.set(src, occurrence + 1);
      return { src, key: `${activity.id}:${contentKey(src)}:${occurrence}` };
    });
  }, [activity.id, output.images]);
  const text = [activity.detail, output.text].filter((value) => value?.trim()).join("\n");
  const title = activity.title || "l’outil";
  return (
    <>
      {text ? (
        <textarea
          className="agent-chat__tool-output"
          aria-label={`Détail de ${title}`}
          readOnly
          rows={Math.min(12, Math.max(2, text.split("\n").length))}
          value={text}
        />
      ) : null}
      {activity.images?.length ? (
        <ConversationImages images={activity.images} label={activity.title || "Image"} />
      ) : null}
      {activity.files?.length ? <ConversationFiles files={activity.files} label={`Fichiers de ${title}`} /> : null}
      {images.length ? (
        <div className="agent-chat__message-attachments">
          {images.map(({ src, key }, index) => (
            <ImagePreview key={key} src={src} alt={`Image ${index + 1} de ${title}`} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ActivityLine({ activity, onOpenFile }: { activity: Activity; onOpenFile?: (path: string) => void }) {
  const edits: ActivityAction[] = activity.actions?.length
    ? activity.actions
    : activity.activityKind === "file" && activity.detail
      ? activity.detail
          .split("\n")
          .filter(Boolean)
          .map((path) => ({ type: "edit" as const, path }))
      : [];
  if (edits.length)
    return (
      <>
        {Array.from(new Map(edits.map((action) => [JSON.stringify(action), action])).values()).map((action) => {
          const path = action.path;
          const fileLabel =
            action.type === "read" || action.type === "edit" ? path?.split(/[\\/]/).pop() || path : path;
          const Icon =
            action.type === "read"
              ? BookOpen
              : action.type === "edit"
                ? Pencil
                : action.type === "search"
                  ? Search
                  : FolderOpen;
          const label =
            action.type === "read"
              ? "Lu"
              : action.type === "edit"
                ? "Modifié"
                : action.type === "search"
                  ? "Recherché"
                  : "Listé";
          return (
            <div className="agent-chat__activity-status" key={JSON.stringify(action)}>
              <Icon size={15} aria-hidden="true" />
              <span
                className="agent-chat__tool-title"
                title={[label, action.query, action.path].filter(Boolean).join(" ")}
              >
                {label} {action.query ? `${action.query} ` : ""}
                {path && onOpenFile && (action.type === "read" || action.type === "edit") ? (
                  <button type="button" className="agent-chat__activity-file" onClick={() => onOpenFile(path)}>
                    {fileLabel}
                  </button>
                ) : (
                  fileLabel
                )}
                {action.added !== undefined && action.removed !== undefined
                  ? ` +${action.added} −${action.removed}`
                  : ""}
              </span>
            </div>
          );
        })}
      </>
    );
  // « Read src/page.tsx », « Modifié notes.md » : le chemin du titre s’ouvre d’un clic.
  const fileAction = /^(Read|Lire|Lecture de|Edited|Modified|Modifié)\s+(\S+)(.*)$/i.exec(activity.title ?? "");
  const FileIcon = activityIcon(activity);
  if (fileAction && onOpenFile && isAgentFileReference(fileAction[2]))
    return (
      <div className="agent-chat__activity-status">
        <FileIcon size={15} aria-hidden="true" />
        <span>
          {fileAction[1]}{" "}
          <button type="button" className="agent-chat__activity-file" onClick={() => onOpenFile(fileAction[2])}>
            {fileAction[2]}
          </button>
          {fileAction[3]}
        </span>
      </div>
    );
  if (!hasActivityOutput(activity))
    return (
      <div className="agent-chat__activity-status">
        <ActivityLabel activity={activity} />
      </div>
    );
  return (
    <Disclosure appearance="subtle" label={<ActivityLabel activity={activity} />}>
      <ActivityOutput activity={activity} />
    </Disclosure>
  );
}

export function activitySummary(activities: readonly Activity[]): string {
  const failed = activities.filter((activity) => activity.status === "failed").length;
  const running = activities.filter(isRunning).length;
  const hasAnalysis = activities.some((activity) => activity.activityKind === "analysis");
  const count = `${activities.length} ${hasAnalysis ? "activité" : "outil"}${activities.length > 1 ? "s" : ""}`;
  return [
    running || failed || hasAnalysis ? count : `${count} exécuté${activities.length > 1 ? "s" : ""}`,
    running ? `${running} en cours` : "",
    failed ? `${failed} en échec` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function Activities({
  activities,
  onOpenFile,
}: {
  activities: readonly Activity[];
  /** Ouvre un fichier lu ou modifié par l’agent ; sans lui, les chemins restent du texte. */
  onOpenFile?: (path: string) => void;
}) {
  if (activities.length === 1)
    return (
      <div className="agent-chat__activity-group">
        <ActivityLine activity={activities[0]} onOpenFile={onOpenFile} />
      </div>
    );
  const failed = activities.some((activity) => activity.status === "failed");
  return (
    <Disclosure
      appearance="subtle"
      className="agent-chat__activity-group"
      label={
        <>
          <Wrench size={15} aria-hidden="true" />
          <span className={`agent-chat__tool-title${failed ? " is-failed" : ""}`}>{activitySummary(activities)}</span>
        </>
      }
    >
      <ol className="agent-chat__tool-list">
        {activities.map((activity) => (
          <li key={activity.id}>
            <ActivityLine activity={activity} onOpenFile={onOpenFile} />
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}
