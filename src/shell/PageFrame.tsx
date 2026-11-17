import { useEffect, useMemo, useRef, useState } from "react";
import { useReadyServicesReload } from "../features/setup/useModuleSetup";
import { frameBase, onNativeEvent } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { ALFRED_MESSAGE, type FrameMessage, isFrameMessage, parseFrameShortcut } from "../sdk/protocol";
import {
  type FrameIdentity,
  frameContext,
  handleFrameRequest,
  onSelectionChange,
  registerPeer,
  releaseFrame,
} from "./frameBridge";
import { frameErrors, sanitizeFrameError } from "./frameErrors";
import { frameKey } from "./frameKeys";
import { addFrameConsole, addFrameErrorLog, addFrameLog } from "./frameLogs";
import { registerSnapshotTarget } from "./pageSnapshot";
import { useShell } from "./store";

/**
 * Affiche une page ou un panneau de l’espace dans un cadre isolé : origine opaque, aucun réseau, et pour seul
 * interlocuteur la coquille, par messages.
 */
export function PageFrame({
  page,
  kind,
  host,
  capture = false,
}: {
  page: ResolvedPage;
  kind: "page" | "panel";
  host?: string;
  /** Cadre invisible chargé pour une capture de l’agent : il ne rejoint pas les pairs de la page affichée. */
  capture?: boolean;
}) {
  const info = useShell((state) => state.info);
  const revision = useShell((state) => state.revision);
  // Un service de la page devient prêt (compte ajouté, connecté, testé) : la page se recharge d’elle-même.
  const ready = useReadyServicesReload(page.module, page.uses, !capture);
  const theme = useShell((state) => state.theme);
  const accent = useShell((state) => state.snapshot?.accent ?? null);
  const frame = useRef<HTMLIFrameElement>(null);
  const identity = useMemo<FrameIdentity>(
    () => ({ kind, module: page.module, reference: page.reference, host, instance: page.instance ?? undefined }),
    [kind, page.module, page.reference, host, page.instance],
  );

  // Le thème de départ évite un éclair clair/sombre ; les changements suivants passent par un message.
  const initialTheme = useRef({ theme, accent });
  // Clé du module de la page : sans elle, le cadre ne charge aucun code (et jamais celui d’un autre module).
  const [key, setKey] = useState<{ module: string; key: string }>();
  useEffect(() => {
    let active = true;
    frameKey(page.module).then(
      (value) => active && setKey({ module: page.module, key: value }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [page.module]);
  const moduleKey = key?.module === page.module ? key.key : undefined;
  const source = useMemo(() => {
    if (!info || !moduleKey) return undefined;
    const query = new URLSearchParams({
      module: page.module,
      key: moduleKey,
      page: page.id,
      v: `${revision}.${ready}`,
      theme: initialTheme.current.theme,
    });
    if (initialTheme.current.accent) query.set("accent", initialTheme.current.accent);
    return `${frameBase(info.pageBase)}/host/page?${query}`;
  }, [info, moduleKey, page.module, page.id, revision, ready]);

  useEffect(() => {
    const post = (message: FrameMessage) => frame.current?.contentWindow?.postMessage(message, "*");
    const snapshot = registerSnapshotTarget(identity.reference, post, capture, () => frame.current);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "event") {
        if (message.name === "error") {
          frameErrors.set(identity.reference, sanitizeFrameError(message.payload, identity.module));
          addFrameErrorLog(identity.reference, message.payload);
        }
        if (message.name === "log") addFrameConsole(identity.reference, message.payload);
        if (message.name === "ready") addFrameLog(identity.reference, "info", "Page chargée.");
        // Une page en échec se décrit aussi (son message d’erreur) : elle est prête pour une capture.
        if (message.name === "ready" || message.name === "error") snapshot.ready();
        if (message.name === "description") snapshot.receive(message.payload);
        if (message.name === "ready") frameErrors.delete(identity.reference);
        if (message.name === "shortcut") {
          // Rejoué sur la fenêtre de la coquille, comme si la touche y avait été pressée (palette, Cmd+K).
          const shortcut = parseFrameShortcut(message.payload);
          if (shortcut) window.dispatchEvent(new KeyboardEvent("keydown", { ...shortcut, cancelable: true }));
        }
        return;
      }
      if (message.kind !== "request") return;
      const params = (message.params ?? {}) as Record<string, unknown>;
      const started = Date.now();
      handleFrameRequest(identity, message.method, params).then(
        (result) => {
          // Les échanges internes de la coquille (contexte, sélection) ne disent rien de la page.
          if (!message.method.startsWith("shell."))
            addFrameLog(identity.reference, "request", describeRequest(message.method, params, result, started));
          post({ alfred: ALFRED_MESSAGE, kind: "response", id: message.id, result });
        },
        (error: unknown) => {
          addFrameLog(
            identity.reference,
            "request",
            `${describeCall(message.method, params)} → échec (${Date.now() - started} ms) : ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          post({
            alfred: ALFRED_MESSAGE,
            kind: "response",
            id: message.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              detail: (error as { detail?: unknown })?.detail,
            },
          });
        },
      );
    };
    window.addEventListener("message", onMessage);
    const pushContext = () =>
      post({ alfred: ALFRED_MESSAGE, kind: "event", name: "context", payload: frameContext(identity) });
    const stopSelection = onSelectionChange((changed) => {
      if (changed === identity.host) pushContext();
    });
    const stopTheme = useShell.subscribe((state, previous) => {
      if (state.theme !== previous.theme || state.snapshot?.accent !== previous.snapshot?.accent) pushContext();
    });
    // Des données du module ont changé hors de la page (partage en équipe) : la page relit ce qu’elle affiche.
    const stopData = onNativeEvent("space:dataChanged", (payload) => {
      if ((payload as { module?: string } | null)?.module === identity.module)
        post({ alfred: ALFRED_MESSAGE, kind: "event", name: "dataChanged", payload: null });
    });
    const stopPeer = capture
      ? () => undefined
      : registerPeer(identity, (message) =>
          post({ alfred: ALFRED_MESSAGE, kind: "event", name: "peer", payload: message }),
        );
    return () => {
      snapshot.dispose();
      window.removeEventListener("message", onMessage);
      stopPeer();
      stopData();
      stopSelection();
      stopTheme();
      if (!capture) releaseFrame(identity);
    };
  }, [identity, capture]);

  if (!source) return null;
  return (
    <iframe
      ref={frame}
      className="page-frame"
      title={page.title}
      src={source}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
    />
  );
}

/** Résumé d’une requête d’une page, pour son journal : méthode et cible, sans le corps. */
function describeCall(method: string, params: Record<string, unknown>): string {
  if (method === "clients.request") {
    return `${method} ${String(params.client ?? "?")} ${String(params.method ?? "GET")} ${String(params.path ?? "")}`;
  }
  if (method === "functions.call") return `${method} ${String(params.function ?? "?")}`;
  if (method === "db.query" || method === "db.execute") return `${method} ${String(params.sql ?? "").slice(0, 200)}`;
  return method;
}

function describeRequest(method: string, params: Record<string, unknown>, result: unknown, started: number): string {
  const status = (result as { status?: unknown } | null)?.status;
  const outcome = typeof status === "number" ? `HTTP ${status}` : "ok";
  return `${describeCall(method, params)} → ${outcome} (${Date.now() - started} ms)`;
}
