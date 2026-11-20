/**
 * Demandes que le backend adresse à l’interface : exécuter une fonction (agent, webhook, planification), rapporter
 * les erreurs des pages affichées, et faire accorder un accès par l’utilisateur.
 */

import { ConfirmDialog } from "@alfred/ui";
import { useEffect, useState } from "react";
import { SecretRevealHost } from "../features/vault/SecretReveal";
import { invoke, onNativeEvent } from "../lib/native";
import { frameErrors } from "./frameErrors";
import { type FrameLogQuery, readFrameLogs } from "./frameLogs";
import { callFunction } from "./functionHost";
import { notify } from "./notifications";
import { capturePage, SnapshotFrames, screenshotPage } from "./pageSnapshot";
import { useShell } from "./store";

interface PermissionRequest {
  requestId: string;
  subject: { kind: string; module: string; reference: string };
  resource: string;
  label: string;
}

function resolve(requestId: string, result: unknown) {
  return invoke("ui.resolve", { requestId, result }).catch(() => undefined);
}

function reject(requestId: string, error: unknown) {
  return invoke("ui.resolve", { requestId, error: error instanceof Error ? error.message : String(error) }).catch(
    () => undefined,
  );
}

let bound = false;
const permissionListeners = new Set<(request: PermissionRequest) => void>();
const waitingPermissions: PermissionRequest[] = [];

function bind() {
  if (bound) return;
  bound = true;
  onNativeEvent("function:call", async (payload) => {
    const call = payload as {
      requestId: string;
      function: string;
      input: unknown;
      caller: string;
      examples?: boolean;
    };
    // La demande est diffusée à toutes les interfaces ouvertes : seule celle qui la réserve l’exécute.
    const claimed = await invoke<boolean>("ui.claim", { requestId: call.requestId }).catch(() => false);
    if (!claimed) return;
    callFunction(call.function, call.input, call.caller, call.examples === true).then(
      (output) => resolve(call.requestId, output),
      (error) => reject(call.requestId, error),
    );
  });
  onNativeEvent("agent:frameErrors", (payload) => {
    const request = payload as { requestId: string; module?: string | null };
    const errors = [...frameErrors.entries()]
      .filter(([reference]) => !request.module || reference.startsWith(`${request.module}/`))
      .map(([page, error]) => ({ page, ...error }));
    void resolve(request.requestId, errors);
  });
  onNativeEvent("agent:pageLogs", (payload) => {
    const request = payload as FrameLogQuery & { requestId: string };
    void resolve(request.requestId, readFrameLogs(request));
  });
  onNativeEvent("agent:pageSnapshot", async (payload) => {
    const request = payload as { requestId: string; page: string; examples?: boolean };
    // Une seule interface capture la page, même si plusieurs fenêtres sont ouvertes.
    const claimed = await invoke<boolean>("ui.claim", { requestId: request.requestId }).catch(() => false);
    if (!claimed) return;
    capturePage(request.page, undefined, { examples: request.examples === true }).then(
      (snapshot) => resolve(request.requestId, snapshot),
      (error) => reject(request.requestId, error),
    );
  });
  onNativeEvent("agent:pageScreenshot", async (payload) => {
    const request = payload as { requestId: string; page: string; fullPage?: boolean; examples?: boolean };
    const claimed = await invoke<boolean>("ui.claim", { requestId: request.requestId }).catch(() => false);
    if (!claimed) return;
    screenshotPage(request.page, { fullPage: request.fullPage === true, examples: request.examples === true }).then(
      (image) => resolve(request.requestId, image),
      (error) => reject(request.requestId, error),
    );
  });
  // Réglages faits par l’agent (coffre, validation d’un client, accord d’accès) : l’utilisateur en est informé.
  onNativeEvent("agent:notice", (payload) => {
    const notice = payload as { title: string; description?: string };
    notify({ title: notice.title, description: notice.description, tone: "info", source: "Agent" });
  });
  // Une tâche de fond se termine pendant que l’utilisateur fait autre chose : il en est prévenu.
  onNativeEvent("jobs:finished", (payload) => {
    const job = payload as { title: string; status: "done" | "failed"; error?: string; module: string };
    const module = useShell.getState().snapshot?.modules.find((candidate) => candidate.id === job.module)?.name;
    notify({
      title: job.status === "done" ? `Tâche terminée : ${job.title}` : `Tâche en échec : ${job.title}`,
      description: job.status === "done" ? module : job.error,
      tone: job.status === "done" ? "success" : "error",
      source: module ?? job.module,
    });
  });
  onNativeEvent("permission:ask", (payload) => {
    const request = payload as PermissionRequest;
    if (permissionListeners.size === 0) waitingPermissions.push(request);
    for (const listener of permissionListeners) listener(request);
  });
}

/** « à » suivi du libellé de la ressource, contracté : « au client Jira », « à la fonction notes/compter ». */
export function toResource(label: string): string {
  if (label.startsWith("le ")) return `au ${label.slice(3)}`;
  if (label.startsWith("les ")) return `aux ${label.slice(4)}`;
  return `à ${label}`;
}

/** Qui demande : le titre est écrit par l’agent, la référence (module/page) dit d’où vient vraiment la demande. */
export function subjectLabel(request: Pick<PermissionRequest, "subject">): string {
  const snapshot = useShell.getState().snapshot;
  if (request.subject.kind === "function") {
    const module = snapshot?.modules.find((candidate) => candidate.id === request.subject.module);
    return module && module.name !== request.subject.module
      ? `Les fonctions du module « ${module.name} » (${request.subject.module})`
      : `Les fonctions du module « ${request.subject.module} »`;
  }
  const pages = [
    ...(snapshot?.sections.flatMap((section) =>
      section.pages.flatMap((page) => [page, ...(page.panel ? [page.panel] : [])]),
    ) ?? []),
    ...(snapshot?.settingsPages ?? []),
  ];
  const page = pages.find((candidate) => candidate.reference === request.subject.reference);
  return page && page.title !== request.subject.reference
    ? `La page « ${page.title} » (${request.subject.reference})`
    : `La page « ${request.subject.reference} »`;
}

/**
 * Demande d’accord : la première fois qu’une page ou les fonctions d’un module utilisent un client ou une fonction
 * d’un autre module, l’utilisateur décide. La réponse est mémorisée par Alfred, hors de l’espace.
 */
export function ShellServices() {
  const [queue, setQueue] = useState<PermissionRequest[]>([]);

  useEffect(() => {
    bind();
    const listener = (request: PermissionRequest) => setQueue((current) => [...current, request]);
    permissionListeners.add(listener);
    if (waitingPermissions.length) setQueue((current) => [...current, ...waitingPermissions.splice(0)]);
    // Une fenêtre ouverte pendant qu’une question attend (fenêtre de page) l’affiche aussi : la réponse donnée
    // ici ou ailleurs la retire partout.
    void invoke<PermissionRequest[]>("ui.waiting", { name: "permission:ask" }).then(
      (waiting) =>
        setQueue((current) => [
          ...current,
          ...(Array.isArray(waiting) ? waiting : []).filter(
            (request) => !current.some((known) => known.requestId === request.requestId),
          ),
        ]),
      () => undefined,
    );
    // Tranchée ailleurs (une autre fenêtre, ou un délai dépassé) : la demande ne reste pas affichée ici.
    const stopResolved = onNativeEvent("ui:resolved", (payload) => {
      const { requestId } = payload as { requestId: string };
      setQueue((current) => current.filter((item) => item.requestId !== requestId));
    });
    return () => {
      permissionListeners.delete(listener);
      stopResolved();
    };
  }, []);

  const request = queue[0];
  const answer = (granted: boolean) => {
    if (!request) return;
    void resolve(request.requestId, { granted });
    setQueue((current) => current.slice(1));
  };

  return (
    <>
      <SnapshotFrames />
      <SecretRevealHost />
      <ConfirmDialog
        open={request !== undefined}
        title={request ? `Autoriser l’accès ${toResource(request.label)} ?` : ""}
        message={
          request
            ? `${subjectLabel(request)} veut utiliser ${request.label}. L’accord est mémorisé ; il se retire dans Réglages → Général.`
            : undefined
        }
        confirmLabel="Autoriser"
        cancelLabel="Refuser"
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
      />
    </>
  );
}
