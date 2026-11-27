import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadyServicesReload } from "../features/setup/useModuleSetup";
import { frameBase, onNativeEvent } from "../lib/native";
import type { ResolvedPage } from "../lib/types";
import { ALFRED_MESSAGE, type FrameMessage, isFrameMessage, parseFrameShortcut } from "../sdk/protocol";
import { useExampleMode } from "./examples";
import { type DropFrameHandle, registerDropFrame } from "./fileDrop";
import {
  type FrameIdentity,
  frameContext,
  frameServices,
  handleFrameRequest,
  onSelectionChange,
  registerPeer,
  releaseFrame,
} from "./frameBridge";
import { frameErrors, sanitizeFrameError } from "./frameErrors";
import { frameKey } from "./frameKeys";
import { addFrameConsole, addFrameErrorLog, addFrameLog } from "./frameLogs";
import { registerEntryActions } from "./menuZones";
import { registerSnapshotTarget } from "./pageSnapshot";
import { useShell } from "./store";
import { onTopBarAction } from "./topBarActions";
import { onTopBarQuery, topBarQueryOf } from "./topBarSearchStore";

let frameSequence = 0;
/** Cadres de page montés, par page : une page peut en avoir deux (sa liste, et un onglet ouvert sur un élément). */
const mountedPages = new Map<string, number>();

/**
 * Ce qu’une page montre dans la coquille (barre du haut, sélection) : seul le cadre affiché le montre. Celui d’un cadre
 * masqué est retenu, et rejoué quand il réapparaît ; un autre cadre de la même page ne l’écrase donc jamais.
 */
const PRESENTED: Record<string, string> = {
  "shell.actions.set": "actions",
  "shell.search.declare": "search",
  "shell.search.remove": "search",
  "shell.publish": "selection",
};
/** Gestes d’une page qui n’ont de sens qu’affichée : un cadre masqué les fait sans effet. */
const SHOWN_ONLY = new Set(["shell.search.set", "shell.setPanelVisible", "menu.takeActions"]);

const isChangeMessage = (message: unknown) =>
  typeof message === "object" && message !== null && (message as { alfred?: unknown }).alfred === "changed";

/**
 * Affiche une page ou un panneau de l’espace dans un cadre isolé : origine opaque, aucun réseau, et pour seul
 * interlocuteur la coquille, par messages.
 */
export function PageFrame({
  page,
  kind,
  host,
  capture = false,
  token,
  examples: forced = false,
  view = null,
  shown = true,
  selection,
}: {
  page: ResolvedPage;
  kind: "page" | "panel";
  host?: string;
  /** Onglet ouvert sur un élément que montre la page, avec sa section : `usePageContext().view`. */
  view?: FrameIdentity["view"] | null;
  /** Cadre invisible chargé pour une capture de l’agent : il ne rejoint pas les pairs de la page affichée. */
  capture?: boolean;
  /** Jeton de la capture qui a chargé ce cadre invisible. */
  token?: string;
  /** Montrer les données d’exemple même si le module n’est pas réglé ainsi (capture demandée par l’agent). */
  examples?: boolean;
  /** Faux : page gardée montée mais masquée ; elle n’est pas « affichée » pour une capture de l’agent. */
  shown?: boolean;
  /** Panneau capturé par l’agent : l’élément choisi qu’il montre (à la place de la sélection de la page). */
  selection?: { value: unknown };
}) {
  const info = useShell((state) => state.info);
  // Le code du module a changé (l’agent l’a réécrit) : ses pages se rechargent, et seulement elles. Le menu réordonné,
  // une section créée, un autre module écrit ne rechargent aucune page. Sans empreinte (ancien backend), la révision.
  const revision = useShell(
    (state) => state.snapshot?.modules.find((module) => module.id === page.module)?.code ?? String(state.revision),
  );
  // Un service de la page devient prêt (compte ajouté, connecté, testé) : la page se recharge d’elle-même.
  const ready = useReadyServicesReload(page.module, page.uses, !capture);
  const theme = useShell((state) => state.theme);
  const accent = useShell((state) => state.snapshot?.accent ?? null);
  const frame = useRef<HTMLIFrameElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const examples = useExampleMode(page.module) || forced;
  // Les comptes changent d’identité (pas de valeur) à chaque snapshot : le cadre suit leur valeur, en chaîne.
  const accountsKey = JSON.stringify(page.accounts ?? {});
  const viewJson = view ? JSON.stringify(view) : "";
  const selectionJson = capture && selection ? JSON.stringify(selection) : "";
  // Identité du cadre : un seul objet tout au long de sa vie, mis à jour sur place. Un onglet renommé, un compte
  // changé ne la remplacent pas : ses états suivis, ses flux et ses objets Python restent à lui.
  const frameId = useRef("");
  if (!frameId.current) frameId.current = String(++frameSequence);
  const identityKey = JSON.stringify([
    kind,
    page.module,
    page.reference,
    host,
    page.instance,
    accountsKey,
    examples,
    capture,
    viewJson,
    selectionJson,
  ]);
  const identityRef = useRef<FrameIdentity | null>(null);
  const next: FrameIdentity = {
    kind,
    module: page.module,
    reference: page.reference,
    host,
    instance: page.instance ?? undefined,
    frame: frameId.current,
    ...(accountsKey !== "{}" ? { accounts: JSON.parse(accountsKey) as Record<string, string> } : {}),
    ...(examples ? { examples: true } : {}),
    ...(capture ? { capture: true } : {}),
    ...(viewJson ? { view: JSON.parse(viewJson) as FrameIdentity["view"] } : {}),
    ...(selectionJson ? { selection: JSON.parse(selectionJson) as FrameIdentity["selection"] } : {}),
  };
  if (!identityRef.current) identityRef.current = next;
  else {
    const current = identityRef.current as unknown as Record<string, unknown>;
    for (const field of Object.keys(current)) if (!(field in next)) delete current[field];
    Object.assign(current, next);
  }
  const identity = identityRef.current;
  const post = useCallback((message: FrameMessage) => frame.current?.contentWindow?.postMessage(message, "*"), []);
  /** Ce que la page a montré dans la coquille, rejoué quand elle réapparaît (`PRESENTED`). */
  const presented = useRef(new Map<string, { method: string; params: Record<string, unknown> }>());
  const fileDrop = useRef<DropFrameHandle | null>(null);
  useEffect(() => {
    if (capture) return;
    const registered = registerDropFrame(
      () => frame.current,
      () => identity,
    );
    fileDrop.current = registered;
    return () => {
      registered.dispose();
      if (fileDrop.current === registered) fileDrop.current = null;
    };
  }, [capture, identity]);

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
      // Un panneau garde sa recherche dans son cadre : la barre du haut est celle de la page.
      kind,
      v: `${revision}.${ready}`,
      theme: initialTheme.current.theme,
    });
    if (initialTheme.current.accent) query.set("accent", initialTheme.current.accent);
    // Entrer dans les données d’exemple ou en sortir recharge la page : elle relit tout dans le nouveau mode.
    if (examples) query.set("examples", "1");
    // Une capture dessine ses actions dans sa propre barre : la barre du haut n’est pas sur l’image.
    if (capture) query.set("capture", "1");
    return `${frameBase(info.pageBase)}/host/page?${query}`;
  }, [info, moduleKey, page.module, page.id, kind, revision, ready, examples, capture]);

  // Ressources du document du cadre (états suivis, barre du haut, flux, objets Python) : libérées quand ce document
  // part (nouvelle adresse, cadre démonté), jamais quand seule son identité change.
  useEffect(() => {
    if (capture || !source) return;
    const reference = identity.reference;
    if (kind === "page") mountedPages.set(reference, (mountedPages.get(reference) ?? 0) + 1);
    return () => {
      const others = kind === "page" ? (mountedPages.get(reference) ?? 1) - 1 : 0;
      if (kind === "page") {
        if (others > 0) mountedPages.set(reference, others);
        else mountedPages.delete(reference);
      }
      presented.current.clear();
      // Un cadre masqué ne retire pas ce que montre un autre cadre de la même page, affiché.
      releaseFrame(identity, shownRef.current || others === 0);
    };
  }, [source, capture, kind, identity]);

  // Le cadre réapparaît : il remontre ce qu’il montrait, et lit ce qui a changé pendant qu’il était masqué.
  const wasShown = useRef(shown);
  useEffect(() => {
    const appeared = shown && !wasShown.current;
    wasShown.current = shown;
    if (!appeared || capture || kind !== "page") return;
    frameServices.revisitStates?.(identity);
    for (const { method, params } of presented.current.values())
      void handleFrameRequest(identity, method, params, () => undefined).catch(() => undefined);
    if (presented.current.get("search")?.method === "shell.search.declare")
      post({
        alfred: ALFRED_MESSAGE,
        kind: "event",
        name: "search",
        payload: { query: topBarQueryOf(identity.reference) },
      });
    post({ alfred: ALFRED_MESSAGE, kind: "event", name: "context", payload: frameContext(identity) });
    // Une action d’une entrée du menu arrivée pendant qu’il était masqué : la page la lit maintenant.
    post({ alfred: ALFRED_MESSAGE, kind: "event", name: "menuEntryAction", payload: null });
  }, [shown, capture, kind, identity, post]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `identityKey` réinscrit le cadre quand son identité change.
  useEffect(() => {
    const snapshot = registerSnapshotTarget(
      identity.reference,
      post,
      capture,
      () => frame.current,
      identity.examples === true,
      token,
      () => !shownRef.current,
    );
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
        // Un nouveau document dans le cadre : il redemandera le dépôt s’il le veut (avant `ready`, rien n’est monté).
        if (message.name === "ready") fileDrop.current?.reset();
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
      if (kind === "page" && !capture) {
        const slot = PRESENTED[message.method];
        if (slot) presented.current.set(slot, { method: message.method, params });
        // Masqué : ce qu’il montrerait est retenu (rejoué à son retour), ses gestes d’affichage sont sans effet.
        if (!shownRef.current && (slot || SHOWN_ONLY.has(message.method))) {
          const result =
            message.method === "shell.search.declare"
              ? { query: topBarQueryOf(identity.reference) }
              : message.method === "menu.takeActions"
                ? []
                : null;
          post({ alfred: ALFRED_MESSAGE, kind: "response", id: message.id, result });
          return;
        }
      }
      const started = Date.now();
      // L’examen d’une page attend la fin de ses requêtes : la page affiche alors ses données.
      snapshot.busy(1);
      handleFrameRequest(identity, message.method, params, (name, payload) =>
        post({ alfred: ALFRED_MESSAGE, kind: "event", name, payload }),
      ).then(
        (result) => {
          snapshot.busy(-1);
          // Les échanges internes de la coquille (contexte, sélection) ne disent rien de la page.
          if (!message.method.startsWith("shell."))
            addFrameLog(identity.reference, "request", describeRequest(message.method, params, result, started));
          post({ alfred: ALFRED_MESSAGE, kind: "response", id: message.id, result });
        },
        (error: unknown) => {
          snapshot.busy(-1);
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
    // L’onglet rouvert avec un autre libellé ou d’autres paramètres : la page reçoit son nouveau contexte.
    if (identity.view) pushContext();
    const stopSelection = onSelectionChange((changed) => {
      if (changed === identity.host) pushContext();
    });
    const entryPage = identity.host ?? identity.reference;
    const stopTheme = useShell.subscribe((state, previous) => {
      if (
        state.theme !== previous.theme ||
        state.snapshot?.accent !== previous.snapshot?.accent ||
        state.activeEntry[entryPage] !== previous.activeEntry[entryPage]
      )
        pushContext();
    });
    // Action d’une entrée de la zone du menu de la page : la page la lit (`useMenuEntryAction`).
    const stopEntryActions =
      kind === "page" && !capture
        ? registerEntryActions(
            identity.reference,
            () =>
              shownRef.current &&
              post({ alfred: ALFRED_MESSAGE, kind: "event", name: "menuEntryAction", payload: null }),
          )
        : () => undefined;
    // Des données du module ont changé hors de la page (partage en équipe) : la page relit ce qu’elle affiche.
    // Un dossier du poste surveillé par le module a changé (`folders.watch`).
    const stopFolders = onNativeEvent("folders:changed", (payload) => {
      const change = payload as { module?: string; folder?: string; paths?: string[] } | null;
      if (change?.module === identity.module)
        post({
          alfred: ALFRED_MESSAGE,
          kind: "event",
          name: "folderChanged",
          payload: { folder: change.folder, paths: change.paths ?? [] },
        });
    });
    const stopData = onNativeEvent("space:dataChanged", (payload) => {
      if ((payload as { module?: string } | null)?.module === identity.module)
        post({ alfred: ALFRED_MESSAGE, kind: "event", name: "dataChanged", payload: null });
    });
    // Frappe dans la recherche de la barre du haut : la page la reçoit (`useTopBarSearch`).
    const stopSearch =
      kind === "page" && !capture
        ? onTopBarQuery(
            identity.reference,
            (query) =>
              shownRef.current && post({ alfred: ALFRED_MESSAGE, kind: "event", name: "search", payload: { query } }),
          )
        : () => undefined;
    // Action choisie dans la barre du haut : la page l’exécute (`useTopBarActions`).
    const stopActions =
      kind === "page" && !capture
        ? onTopBarAction(
            identity.reference,
            (id) =>
              shownRef.current &&
              post({ alfred: ALFRED_MESSAGE, kind: "event", name: "topBarAction", payload: { id } }),
          )
        : () => undefined;
    const stopPeer = capture
      ? () => undefined
      : registerPeer(identity, (message) => {
          // Masqué, il ne reçoit que l’annonce d’une écriture (ses données se relisent en arrière-plan).
          if (!shownRef.current && !isChangeMessage(message)) return;
          post({ alfred: ALFRED_MESSAGE, kind: "event", name: "peer", payload: message });
        });
    return () => {
      snapshot.dispose();
      window.removeEventListener("message", onMessage);
      stopPeer();
      stopActions();
      stopSearch();
      stopData();
      stopFolders();
      stopSelection();
      stopTheme();
      stopEntryActions();
    };
  }, [identity, identityKey, capture, kind, token, post]);

  if (!source) return null;
  return (
    <iframe
      ref={frame}
      className="page-frame block h-full min-h-0 w-full flex-1 border-0 bg-surface"
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
