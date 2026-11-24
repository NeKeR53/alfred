import { ActivityGroup, type ActivityItem, type ActivityKind } from "socle-ui";
import type { ActivityAction } from "./harness";
import { isAgentFileReference } from "./lib/agentFileLinks";
import { activityImageOutput } from "./lib/chatImages";
import type { TurnItem } from "./model";
import { ConversationFiles } from "./transcript/ConversationFiles";
import { ConversationImages } from "./transcript/ConversationImages";

/**
 * Activités de l’agent, en un seul `ActivityGroup` de Socle (D-376, D-384, D-390, D-391) : dès le premier outil, une
 * ligne repliée avec le nombre d’appels et le nombre en cours ; dépliée, une ligne par outil, la sortie ouverte à la
 * demande avec ses images et ses fichiers ; un chemin lu ou modifié s’ouvre d’un clic.
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

export function hasActivityOutput(activity: Activity): boolean {
  return Boolean(
    activity.detail?.trim() || activity.content?.trim() || activity.images?.length || activity.files?.length,
  );
}

function isRunning(activity: Activity): boolean {
  return !["completed", "failed", "cancelled", "stopped"].includes(activity.status);
}

/** Type Socle d’une activité, qui choisit son icône : console, crayon, loupe, livre, dossier, cerveau, clé (D-394). */
function activityKind(activity: Activity): ActivityKind {
  if (activity.activityKind === "analysis") return "think";
  if (activity.activityKind === "command") return "command";
  if (activity.activityKind === "file") return "edit";
  if (activity.activityKind === "search") return "search";
  const title = activityTitle(activity);
  if (/^(ran|run|exécuté|execute|commande|command|bash|shell|powershell|terminal)(?:\s|$)/i.test(title))
    return "command";
  if (/^(read|lire|lecture|lu|view)\b/i.test(title)) return "read";
  if (/^(edited|edit|modified|modifier|modifié|écrit|write|patch|apply_patch|multiedit)\b/i.test(title)) return "edit";
  if (/^(ls|list|listé|lister|glob|listfiles)\b/i.test(title)) return "list";
  if (/^(searched|search|recherché|recherche|chercher|grep|websearch)\b/i.test(title)) return "search";
  return "other";
}

/** Verbe en tête d’un titre (« Exécuté npm test », « Read src/a.ts ») : il se sépare de l’objet, en chasse fixe. */
const LEADING_VERB =
  /^(Exécuté|Lu|Lire|Read|Modifié|Modified|Edited|Écrit|Recherché|Searched|Listé|Ran|Run)\s+([\s\S]+)$/i;

/** Ligne Socle d’une activité : verbe, objet, état, sortie, et ses images et fichiers en pièces. */
export function activityItem(activity: Activity, onOpenFile?: (path: string) => void): ActivityItem {
  const title =
    activityTitle(activity)
      .replace(/\s*\n\s*/g, " ")
      .trim() || "Outil";
  const split = LEADING_VERB.exec(title);
  const stopped = ["cancelled", "stopped"].includes(activity.status as string);
  const output = activityImageOutput(activity.content ?? "");
  const detail = [activity.detail, output.text].filter((value) => value?.trim()).join("\n");
  // « Read src/page.tsx » : le chemin du titre s’ouvre d’un clic.
  const fileTitle = FILE_TITLE.exec(activity.title ?? "");
  const openable = fileTitle && onOpenFile && isAgentFileReference(fileTitle[2]) ? fileTitle[2] : undefined;
  return {
    id: activity.id,
    kind: activityKind(activity),
    verb: openable && fileTitle ? fileTitle[1] : split ? split[1] : title,
    object: openable ?? split?.[2],
    ...(openable && onOpenFile ? { onObjectPress: () => onOpenFile(openable) } : {}),
    status: activity.status === "failed" ? "error" : stopped ? "stopped" : isRunning(activity) ? "running" : "done",
    detail: detail || undefined,
    attachments: activityAttachments(activity, [...(activity.images ?? []), ...output.images]),
  };
}

/** Images et fichiers produits par l’outil, sous le texte de sa sortie. */
function activityAttachments(activity: Activity, images: readonly string[]) {
  const title = activity.title || "l’outil";
  if (!images.length && !activity.files?.length) return undefined;
  return (
    <>
      <ConversationImages images={images} label={`Images de ${title}`} />
      {activity.files?.length ? <ConversationFiles files={activity.files} label={`Fichiers de ${title}`} /> : null}
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

/** « Read src/page.tsx », « Modifié notes.md » : le chemin du titre. */
const FILE_TITLE = /^(Read|Lire|Lecture de|Edited|Modified|Modifié)\s+(\S+)(.*)$/i;

/** Lignes Socle d’une activité : une par fichier touché, le fichier s’ouvrant d’un clic ; sinon une seule. */
function activityItems(activity: Activity, onOpenFile?: (path: string) => void): ActivityItem[] {
  const actions = fileActions(activity);
  if (!actions.length) return [activityItem(activity, onOpenFile)];
  return actions.map((action, index) => {
    const path = action.path;
    const openable = path && onOpenFile && (action.type === "read" || action.type === "edit");
    return {
      id: `${activity.id}:${index}`,
      kind:
        action.type === "read"
          ? "read"
          : action.type === "search"
            ? "search"
            : action.type === "listFiles"
              ? "list"
              : "edit",
      verb: actionVerb(action),
      object: [action.query, actionFile(action)].filter(Boolean).join(" ") + actionLines(action),
      ...(openable ? { onObjectPress: () => onOpenFile(path) } : {}),
    };
  });
}

export function Activities({
  activities,
  onOpenFile,
}: {
  activities: readonly Activity[];
  /** Ouvre un fichier lu ou modifié par l’agent ; sans lui, les chemins restent du texte. */
  onOpenFile?: (path: string) => void;
}) {
  // Les appels qui se suivent forment une seule ligne repliée, même pour un outil seul et pendant le travail :
  // « 1 outil · 1 en cours », « 7 outils · 2 en cours » (D-390, D-391). Dépliée, elle montre une ligne par appel.
  return (
    <ActivityGroup
      items={activities.flatMap((activity) => activityItems(activity, onOpenFile))}
      groupAbove={0}
      defaultExpanded={false}
    />
  );
}
