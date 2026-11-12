import { Disclosure } from "@alfred/ui";
import { BookOpen, Bot, Brain, FolderOpen, LoaderCircle, Pencil, Search, TerminalSquare, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { TurnItem } from "./model";

/**
 * Activités de l’agent, reprises de `ChatActivities` de OneApp : une activité seule s’affiche sur sa ligne, une suite
 * d’activités se replie derrière un résumé (« 3 outils exécutés »), le détail de chacune s’ouvre à la demande.
 */
export type Activity = Extract<TurnItem, { kind: "activity" }>;

function activityTitle(activity: Activity): string {
  const title = activity.title || "Outil";
  if (activity.activityKind === "command" && activity.detail?.trim()) {
    const command = activity.detail.split("\n")[0];
    return /^(?:commande|command)$/i.test(title.trim()) ? `Exécuté ${command}` : `${title} · ${command}`;
  }
  return title;
}

function activityIcon(activity: Activity) {
  if (activity.activityKind === "analysis") return Brain;
  if (activity.activityKind === "command") return TerminalSquare;
  if (activity.activityKind === "file") return Pencil;
  if (activity.activityKind === "search") return Search;
  if (activity.activityKind === "agent") return Bot;
  const title = activityTitle(activity);
  if (/^(read|lire|lecture)\b/i.test(title)) return BookOpen;
  if (/^(edited|edit|modified|modifier|modifié|écrit|write)\b/i.test(title)) return Pencil;
  if (/^(searched|search|recherché|recherche|chercher)\b/i.test(title)) return Search;
  return Wrench;
}

export function hasActivityOutput(activity: Activity): boolean {
  return Boolean(
    (activity.activityKind === "tool" && activity.detail?.trim()) ||
      activity.content?.trim() ||
      activity.images?.length ||
      activity.files?.length,
  );
}

function ActivityLabel({ activity }: { activity: Activity }) {
  const running = activity.status === "running";
  const Icon = running ? LoaderCircle : activityIcon(activity);
  const title = activityTitle(activity).replace(/\s*\n\s*/g, " ");
  return (
    <>
      <Icon size={15} className={running ? "is-spinning" : undefined} aria-hidden="true" />
      <span className="agent-chat__tool-title" title={title}>
        {title}
      </span>
      <span className={activity.status === "failed" ? "agent-chat__tool-status is-failed" : "sr-only"}>
        {activity.status === "failed" ? "Échec" : activity.status === "completed" ? "Terminé" : "En cours"}
      </span>
    </>
  );
}

function ActivityOutput({ activity, extras }: { activity: Activity; extras?: ReactNode }) {
  const text = [activity.activityKind === "tool" ? activity.detail : undefined, activity.content]
    .filter((value) => value?.trim())
    .join("\n");
  return (
    <>
      {text ? (
        <textarea
          className="agent-chat__tool-output"
          aria-label={`Détail de ${activity.title || "l’outil"}`}
          readOnly
          rows={Math.min(12, Math.max(2, text.split("\n").length))}
          value={text}
        />
      ) : null}
      {extras}
    </>
  );
}

function ActivityLine({
  activity,
  renderExtras,
}: {
  activity: Activity;
  renderExtras: (activity: Activity) => ReactNode;
}) {
  const edits = activity.actions?.length ? activity.actions : [];
  if (edits.length && !hasActivityOutput(activity))
    return (
      <>
        {Array.from(new Map(edits.map((action) => [JSON.stringify(action), action])).values()).map((action) => {
          const fileLabel =
            action.type === "read" || action.type === "edit"
              ? action.path?.split(/[\\/]/).pop() || action.path
              : action.path;
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
                {fileLabel}
                {action.added !== undefined || action.removed !== undefined ? (
                  <>
                    {" "}
                    <span className="agent-chat__change-added">+{action.added ?? 0}</span>{" "}
                    <span className="agent-chat__change-removed">−{action.removed ?? 0}</span>
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </>
    );
  if (!hasActivityOutput(activity))
    return (
      <div className="agent-chat__activity-status">
        <ActivityLabel activity={activity} />
      </div>
    );
  return (
    <Disclosure appearance="subtle" label={<ActivityLabel activity={activity} />} lazy>
      <ActivityOutput activity={activity} extras={renderExtras(activity)} />
    </Disclosure>
  );
}

export function activitySummary(activities: readonly Activity[]): string {
  const failed = activities.filter((activity) => activity.status === "failed").length;
  const running = activities.filter((activity) => activity.status === "running").length;
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
  renderExtras,
}: {
  activities: readonly Activity[];
  /** Images et fichiers produits par une activité, affichés sous son détail. */
  renderExtras: (activity: Activity) => ReactNode;
}) {
  if (activities.length === 1)
    return (
      <div className="agent-chat__activity-group">
        <ActivityLine activity={activities[0]} renderExtras={renderExtras} />
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
            <ActivityLine activity={activity} renderExtras={renderExtras} />
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}
