import { useEffect, useMemo, useRef } from "react";
import { frameBase } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { ALFRED_MESSAGE, type FrameMessage, isFrameMessage, parseFrameShortcut } from "../sdk/protocol";
import { type FrameIdentity, frameContext, handleFrameRequest, onSelectionChange, registerPeer } from "./frameBridge";
import { frameErrors, sanitizeFrameError } from "./frameErrors";
import { useShell } from "./store";

/**
 * Affiche une page ou un panneau de l’espace dans un cadre isolé : origine opaque, aucun réseau, et pour seul
 * interlocuteur la coquille, par messages.
 */
export function PageFrame({ page, kind, host }: { page: ResolvedPage; kind: "page" | "panel"; host?: string }) {
  const info = useShell((state) => state.info);
  const revision = useShell((state) => state.revision);
  const theme = useShell((state) => state.theme);
  const accent = useShell((state) => state.snapshot?.accent ?? null);
  const frame = useRef<HTMLIFrameElement>(null);
  const identity = useMemo<FrameIdentity>(
    () => ({ kind, module: page.module, reference: page.reference, host }),
    [kind, page.module, page.reference, host],
  );

  // Le thème de départ évite un éclair clair/sombre ; les changements suivants passent par un message.
  const initialTheme = useRef({ theme, accent });
  const source = useMemo(() => {
    if (!info) return undefined;
    const query = new URLSearchParams({
      module: page.module,
      page: page.id,
      v: String(revision),
      theme: initialTheme.current.theme,
    });
    if (initialTheme.current.accent) query.set("accent", initialTheme.current.accent);
    return `${frameBase(info.pageBase)}/host/page?${query}`;
  }, [info, page.module, page.id, revision]);

  useEffect(() => {
    const post = (message: FrameMessage) => frame.current?.contentWindow?.postMessage(message, "*");
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "event") {
        if (message.name === "error") frameErrors.set(identity.reference, sanitizeFrameError(message.payload));
        if (message.name === "ready") frameErrors.delete(identity.reference);
        if (message.name === "shortcut") {
          // Rejoué sur la fenêtre de la coquille, comme si la touche y avait été pressée (palette, Cmd+K).
          const shortcut = parseFrameShortcut(message.payload);
          if (shortcut) window.dispatchEvent(new KeyboardEvent("keydown", { ...shortcut, cancelable: true }));
        }
        return;
      }
      if (message.kind !== "request") return;
      handleFrameRequest(identity, message.method, (message.params ?? {}) as Record<string, unknown>).then(
        (result) => post({ alfred: ALFRED_MESSAGE, kind: "response", id: message.id, result }),
        (error: unknown) =>
          post({
            alfred: ALFRED_MESSAGE,
            kind: "response",
            id: message.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              detail: (error as { detail?: unknown })?.detail,
            },
          }),
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
    const stopPeer = registerPeer(identity, (message) =>
      post({ alfred: ALFRED_MESSAGE, kind: "event", name: "peer", payload: message }),
    );
    return () => {
      window.removeEventListener("message", onMessage);
      stopPeer();
      stopSelection();
      stopTheme();
    };
  }, [identity]);

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
