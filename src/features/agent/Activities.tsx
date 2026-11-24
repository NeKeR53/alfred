import { BookOpen, FolderOpen, Pencil, Search, TerminalSquare, Wrench } from "lucide-react";
import { useMemo } from "react";
import { Accordion, ActivityGroup, type ActivityItem, type ActivityKind, Link, TextArea } from "socle-ui";
import type { ActivityAction } from "./harness";
import { isAgentFileReference } from "./lib/agentFileLinks";
import { activityImageOutput } from "./lib/chatImages";
import type { TurnItem } from "./model";
import { ConversationFiles } from "./transcript/ConversationFiles";
import { ConversationImages } from "./transcript/ConversationImages";
import { ImagePreview } from "./transcript/ImagePreview";

/**
 * Activités de l’agent, en `ActivityGroup` de Socle (D-376) : une ligne par outil, un résumé au-delà de 3, la sortie
 * ouverte à la demande. Deux cas restent en ligne locale, faute d’équivalent dans Socle 1.4 (voir
 * docs/socle-propositions.md, « Manques vus en 1.4 ») : un chemin de fichier lu ou modifié, qui s’ouvre d’un clic, et une
 * sortie qui contient des images ou des fichiers.
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

/** Type Socle d’une activité, qui choisit son icône. */
function activityKind(activity: Activity): ActivityKind {
  if (activity.activityKind === "analysis") return "think";
  const Icon = activityIcon(activity);
  return Icon === TerminalSquare
    ? "command"
    : Icon === Pencil
      ? "edit"
      : Icon === Search
        ? "search"
        : Icon === BookOpen
          ? "read"
          : "other";
}

/** Verbe en tête d’un titre (« Exécuté npm test », « Read src/a.ts ») : il se sépare de l’objet, en chasse fixe. */
const LEADING_VERB =
  /^(Exécuté|Lu|Lire|Read|Modifié|Modified|Edited|Écrit|Recherché|Searched|Listé|Ran|Run)\s+([\s\S]+)$/i;

/** Ligne Socle d’une activité : verbe, objet, état ; « Arrêté » s’ajoute au verbe, Socle n’ayant pas cet état. */
export function activityItem(activity: Activity): ActivityItem {
  const title =
    activityTitle(activity)
      .replace(/\s*\n\s*/g, " ")
      .trim() || "Outil";
  const split = LEADING_VERB.exec(title);
  const stopped = ["cancelled", "stopped"].includes(activity.status as string);
  const output = activityImageOutput(activity.content ?? "").text;
  const detail = [activity.detail, output].filter((value) => value?.trim()).join("\n");
  return {
    id: activity.id,
    kind: activityKind(activity),
    verb: `${split ? split[1] : title}${stopped ? ` · ${activityStatusLabel(activity.status)}` : ""}`,
    object: split?.[2],
    status: activity.status === "failed" ? "error" : isRunning(activity) ? "running" : "done",
    detail: detail || undefined,
  };
}

function contentKey(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `${content.length}:${hash >>> 0}`;
}

/** Détail d’une activité locale : sa sortie en lecture seule, puis ses images et fichiers, comme dans OneApp. */
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
        <TextArea
          label={`Détail de ${title}`}
          hideLabel
          isReadOnly
          value={text}
          minRows={Math.min(12, Math.max(2, text.split("\n").length))}
          maxRows={12}
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

/** Fichiers lus ou modifiés par une activité : ses actions, ou les chemins du détail d’une modification. */
function fileActions(activity: Activity): ActivityAction[] {
  const actions: ActivityAction[] = activity.actions?.length
    ? activity.actions
    : activity.activityKind === "file" && activity.detail
      ? activity.detail
          .split("\n")
          .filter(Boolean)
          .map((path) => ({ type: "edit" as const, path }))
      : [];
  return Array.from(new Map(actions.map((action) => [JSON.stringify(action), action])).values());
}

const ACTION_VERB = { read: "Lu", edit: "Modifié", search: "Recherché" } as const;
const actionVerb = (action: ActivityAction) => ACTION_VERB[action.type as keyof typeof ACTION_VERB] ?? "Listé";
const actionFile = (action: ActivityAction) =>
  action.type === "read" || action.type === "edit" ? action.path?.split(/[\\/]/).pop() || action.path : action.path;
const actionLines = (action: ActivityAction) =>
  action.added !== undefined && action.removed !== undefined ? ` +${action.added} −${action.removed}` : "";

/** « Read src/page.tsx », « Modifié notes.md » : le chemin du titre s’ouvre d’un clic. */
const FILE_TITLE = /^(Read|Lire|Lecture de|Edited|Modified|Modifié)\s+(\S+)(.*)$/i;

/** Lignes Socle d’une activité : une par fichier touché, sinon une seule. */
function activityItems(activity: Activity): ActivityItem[] {
  const actions = fileActions(activity);
  if (!actions.length) return [activityItem(activity)];
  return actions.map((action, index) => ({
    id: `${activity.id}:${index}`,
    kind: action.type === "read" ? "read" : action.type === "search" ? "search" : "edit",
    verb: actionVerb(action),
    object: [action.query, actionFile(action)].filter(Boolean).join(" ") + actionLines(action),
  }));
}

/** L’activité a besoin de sa ligne locale : un chemin à ouvrir, ou des images et fichiers dans sa sortie. */
function needsLocalLine(activity: Activity, onOpenFile?: (path: string) => void): boolean {
  if (activity.images?.length || activity.files?.length) return true;
  if (activityImageOutput(activity.content ?? "").images.length) return true;
  if (!onOpenFile) return false;
  if (fileActions(activity).some((action) => action.path && (action.type === "read" || action.type === "edit")))
    return true;
  const fileTitle = FILE_TITLE.exec(activity.title ?? "");
  return Boolean(fileTitle && isAgentFileReference(fileTitle[2]));
}

/** Ligne locale (Hors design en 1.4) : chemins cliquables, ou sortie avec images et fichiers. */
function LocalActivity({ activity, onOpenFile }: { activity: Activity; onOpenFile?: (path: string) => void }) {
  const actions = fileActions(activity);
  if (actions.length && onOpenFile)
    return actions.map((action) => {
      const path = action.path;
      const Icon =
        action.type === "read"
          ? BookOpen
          : action.type === "edit"
            ? Pencil
            : action.type === "search"
              ? Search
              : FolderOpen;
      return (
        <div className="agent-chat__activity-status" key={JSON.stringify(action)}>
          <Icon size={15} aria-hidden="true" />
          <span className="agent-chat__tool-title">
            {actionVerb(action)} {action.query ? `${action.query} ` : ""}
            {path && (action.type === "read" || action.type === "edit") ? (
              <Link onPress={() => onOpenFile(path)}>{actionFile(action) ?? path}</Link>
            ) : (
              actionFile(action)
            )}
            {actionLines(action)}
          </span>
        </div>
      );
    });
  const fileTitle = FILE_TITLE.exec(activity.title ?? "");
  if (fileTitle && onOpenFile && isAgentFileReference(fileTitle[2])) {
    const Icon = activityIcon(activity);
    return (
      <div className="agent-chat__activity-status">
        <Icon size={15} aria-hidden="true" />
        <span>
          {fileTitle[1]} <Link onPress={() => onOpenFile(fileTitle[2])}>{fileTitle[2]}</Link>
          {fileTitle[3]}
        </span>
      </div>
    );
  }
  const item = activityItem(activity);
  return (
    <Accordion title={[item.verb, item.object].filter(Boolean).join(" ")}>
      <ActivityOutput activity={activity} />
    </Accordion>
  );
}

type Run = { key: string; items: Activity[] } | { key: string; local: Activity };

/** Suite d’activités découpée en groupes Socle, entre lesquels s’intercalent les lignes locales, dans l’ordre. */
function runsOf(activities: readonly Activity[], onOpenFile?: (path: string) => void): Run[] {
  const runs: Run[] = [];
  for (const activity of activities) {
    const last = runs.at(-1);
    if (needsLocalLine(activity, onOpenFile)) runs.push({ key: activity.id, local: activity });
    else if (last && "items" in last) last.items.push(activity);
    else runs.push({ key: activity.id, items: [activity] });
  }
  return runs;
}

export function Activities({
  activities,
  onOpenFile,
}: {
  activities: readonly Activity[];
  /** Ouvre un fichier lu ou modifié par l’agent ; sans lui, les chemins restent du texte. */
  onOpenFile?: (path: string) => void;
}) {
  return runsOf(activities, onOpenFile).map((run) =>
    "local" in run ? (
      <LocalActivity key={run.key} activity={run.local} onOpenFile={onOpenFile} />
    ) : (
      <ActivityGroup key={run.key} items={run.items.flatMap(activityItems)} />
    ),
  );
}
