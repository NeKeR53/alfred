import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard";
import { StatusDot, type StatusDotTone } from "./StatusDot";
import type { TerminalEngine } from "./terminalEngine";
import "./ansi.css";
import "./terminal.css";

/** Ce que `Terminal` lit et écrit d’un canal WebSocket : le résultat de `useChannel(id)` de `@alfred/sdk`. */
export interface TerminalChannel {
  events: readonly { seq: number; type?: string; data?: string; base64?: boolean }[];
  closed?: boolean;
  reason?: string | null;
  error?: Error | undefined;
  write(message: string | { data: string }): Promise<unknown>;
}

/** Paire écriture/lecture fournie par la page, quand le service ne passe pas par un canal tel quel. */
export interface TerminalConnection {
  /** Envoie au service ce que tape ou colle l’utilisateur. */
  send(data: string): unknown;
  /** Reçoit ce que le service écrit (texte ou octets) ; rend le désabonnement. */
  subscribe(write: (data: string | Uint8Array) => void): () => void;
}

export interface TerminalProps {
  /** Nom du terminal, pour les lecteurs d’écran : « Console du conteneur web ». */
  label: string;
  /** Canal WebSocket ouvert par une fonction du module (`client(id).socket`), lu par `useChannel`. */
  channel?: TerminalChannel | null;
  /** Ou une paire écriture/lecture propre au service. */
  connection?: TerminalConnection | null;
  /**
   * Taille en colonnes et lignes, à l’ouverture puis à chaque redimensionnement : la page la transmet au service
   * (message de redimensionnement du protocole, ou fonction du connecteur).
   */
  onResize?: (size: { cols: number; rows: number }) => unknown;
  /** Lecture seule : la saisie n’est pas envoyée. */
  readOnly?: boolean;
  /** Occupe la hauteur restante d’une `Page fill`. */
  fill?: boolean;
}

function decode(data: string) {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** F6 sort du terminal, qui garde sinon Tab et toutes les touches (WCAG 2.1.2) : focus au contrôle voisin. */
function leave(container: HTMLElement, direction: "forward" | "backward") {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !container.contains(element) && element.getClientRects().length > 0,
  );
  const after = all.filter((element) => container.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  const before = all.filter((element) => container.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING);
  const target = direction === "forward" ? (after[0] ?? before[0]) : (before.at(-1) ?? after.at(-1));
  target?.focus();
}

/**
 * Terminal interactif (xterm.js) branché sur un canal WebSocket ou sur une paire écriture/lecture : saisie au clavier,
 * copier-coller, taille envoyée au service et thèmes d’Alfred. xterm se charge à la première ouverture.
 */
export function Terminal({ label, channel, connection, onResize, readOnly = false, fill = false }: TerminalProps) {
  const container = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<TerminalEngine | null>(null);
  /** Ce qui arrive avant que xterm soit prêt. */
  const pending = useRef<(string | Uint8Array)[]>([]);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const latest = useRef({ channel, connection, onResize, readOnly });
  latest.current = { channel, connection, onResize, readOnly };

  const output = useCallback((data: string | Uint8Array) => {
    if (engine.current) engine.current.write(data);
    else pending.current.push(data);
  }, []);

  // Ouverture de xterm, une fois par terminal : le libellé et la lecture seule sont fixés à l’ouverture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changer de session ou de libellé se fait avec `key`.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    void import("./terminalEngine")
      .then(({ openTerminal }) => {
        if (disposed) return;
        const opened = openTerminal(element, {
          label,
          description: readOnly
            ? "Terminal en lecture seule. F6 pour en sortir."
            : "Terminal interactif : la saisie est envoyée au service. Ctrl+Maj+C copie, Ctrl+V colle, F6 pour en sortir.",
          readOnly,
          onData: (data) => {
            const { channel: currentChannel, connection: currentConnection, readOnly: locked } = latest.current;
            if (locked) return;
            if (currentConnection) void Promise.resolve(currentConnection.send(data)).catch(() => undefined);
            else if (currentChannel && !currentChannel.closed) void currentChannel.write(data).catch(() => undefined);
          },
          onResize: (next) => {
            setSize(next);
            // La première taille part tout de suite ; un glissement de fenêtre n’en envoie qu’une à la fin.
            clearTimeout(resizeTimer);
            const send = () => void Promise.resolve(latest.current.onResize?.(next)).catch(() => undefined);
            if (first) {
              first = false;
              send();
            } else resizeTimer = setTimeout(send, 120);
          },
          onLeave: (direction) => {
            if (container.current) leave(container.current, direction);
          },
          onCopy: (text) => {
            void copyText(text).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            );
          },
        });
        engine.current = opened;
        for (const data of pending.current) opened.write(data);
        pending.current = [];
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);

  // Lecture d’un canal : chaque événement n’est écrit qu’une fois, d’après son rang.
  const lastSeq = useRef(-1);
  useEffect(() => {
    if (!channel) return;
    // `useChannel` repart d’une liste vide pour un nouveau canal.
    if (channel.events.length === 0) lastSeq.current = -1;
    for (const event of channel.events) {
      if (event.seq <= lastSeq.current) continue;
      lastSeq.current = event.seq;
      if ((event.type ?? "data") !== "data" || event.data === undefined) continue;
      output(event.base64 ? decode(event.data) : event.data);
    }
  });

  // Lecture d’une connexion fournie.
  useEffect(() => {
    if (!connection) return;
    return connection.subscribe(output);
  }, [connection, output]);

  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const state: { tone: StatusDotTone; text: string } = failure
    ? { tone: "danger", text: `Terminal indisponible : ${failure}` }
    : channel?.error
      ? { tone: "danger", text: `Connexion interrompue : ${channel.error.message}` }
      : channel?.closed
        ? { tone: "neutral", text: channel.reason ? `Session terminée : ${channel.reason}` : "Session terminée" }
        : channel || connection
          ? { tone: ready ? "success" : "pending", text: ready ? "Connecté" : "Ouverture du terminal…" }
          : { tone: "pending", text: "En attente de connexion…" };

  const classes = ["ui-terminal", fill ? "ui-terminal--fill" : ""].filter(Boolean).join(" ");
  return (
    <section ref={container} className={classes} aria-label={label}>
      <div ref={host} className="ui-terminal__screen" />
      <div className="ui-terminal__status">
        <span className={`ui-terminal__state ui-terminal__state--${state.tone}`} role="status">
          <StatusDot tone={state.tone} />
          {state.text}
        </span>
        <span className="ui-terminal__hint" aria-live="polite">
          {copied === "copied"
            ? "Sélection copiée"
            : copied === "failed"
              ? "Copie impossible"
              : readOnly
                ? "Lecture seule"
                : "F6 pour sortir"}
        </span>
        {size ? (
          <span className="ui-terminal__size">
            <span className="visually-hidden">Taille : </span>
            {size.cols} × {size.rows}
          </span>
        ) : null}
      </div>
    </section>
  );
}
