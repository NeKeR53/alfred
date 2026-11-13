/**
 * Capture du rendu d’une page pour l’agent (outil `page_snapshot`). La coquille ne lit pas le document d’un cadre
 * (origine opaque) : elle demande au cadre de se décrire par le pont, et charge la page dans un cadre invisible le
 * temps de la capture quand elle n’est pas affichée. La description vient du cadre, donc du code de la page : elle
 * est bornée ici et présentée à l’agent comme une donnée, jamais comme une consigne.
 */

import { useEffect, useState } from "react";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { ALFRED_MESSAGE, type FrameMessage } from "../sdk/protocol";
import { frameErrors } from "./frameErrors";
import { PageFrame } from "./PageFrame";
import { useShell } from "./store";

export interface PageSnapshot {
  page: string;
  title: string;
  /** La page était à l’écran (sinon elle a été chargée hors de la vue pour la capture). */
  displayed: boolean;
  text: string;
  truncated: boolean;
  runtimeError: unknown;
}

interface Target {
  reference: string;
  post: (message: FrameMessage) => void;
  ready: boolean;
  readyAt: number;
  hidden: boolean;
  waiting: Map<string, (payload: unknown) => void>;
  onReady: Set<() => void>;
}

const targets = new Set<Target>();
const MAX_TEXT = 30_000;
/** Laisse aux données de la page le temps d’arriver après son chargement. */
const SETTLE_MS = 800;

/**
 * Inscrit le cadre d’une page affichée. PageFrame transmet `ready`, `error` (une page en échec se décrit aussi) et
 * `description` ; renvoie la fonction qui désinscrit le cadre.
 */
export function registerSnapshotTarget(reference: string, post: (message: FrameMessage) => void, hidden = false) {
  const target: Target = {
    reference,
    post,
    ready: false,
    readyAt: 0,
    hidden,
    waiting: new Map(),
    onReady: new Set(),
  };
  targets.add(target);
  return {
    ready() {
      if (target.ready) return;
      target.ready = true;
      target.readyAt = Date.now();
      for (const listener of [...target.onReady]) listener();
    },
    receive(payload: unknown) {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return;
      target.waiting.get(id)?.(payload);
    },
    dispose() {
      targets.delete(target);
    },
  };
}

/** Pages chargées hors de la vue pour une capture ; SnapshotFrames les affiche dans des cadres invisibles. */
const hiddenListeners = new Set<(pages: HiddenPage[]) => void>();
let hiddenPages: HiddenPage[] = [];

interface HiddenPage {
  token: string;
  page: ResolvedPage;
  kind: "page" | "panel";
  host?: string;
}

function setHidden(next: HiddenPage[]) {
  hiddenPages = next;
  for (const listener of hiddenListeners) listener(next);
}

/** Trouve une page (onglet, panneau ou page des Réglages) et, pour un panneau, la page qui l’héberge. */
export function findPage(
  snapshot: Snapshot | null | undefined,
  reference: string,
): { page: ResolvedPage; kind: "page" | "panel"; host?: string } | undefined {
  for (const section of snapshot?.sections ?? []) {
    for (const page of section.pages) {
      if (page.reference === reference) return { page, kind: "page" };
      if (page.panel?.reference === reference) return { page: page.panel, kind: "panel", host: page.reference };
    }
  }
  const settings = snapshot?.settingsPages.find((page) => page.reference === reference);
  return settings ? { page: settings, kind: "page" } : undefined;
}

function bounded(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function waitReady(target: Target, timeout: number): Promise<void> {
  if (target.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.onReady.delete(listener);
      reject(new Error("La page ne s’est pas chargée à temps."));
    }, timeout);
    const listener = () => {
      clearTimeout(timer);
      target.onReady.delete(listener);
      resolve();
    };
    target.onReady.add(listener);
  });
}

function waitTarget(reference: string, timeout: number): Promise<Target> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = [...targets].find((target) => target.reference === reference);
      if (found) return resolve(found);
      if (Date.now() - started > timeout) return reject(new Error("La page n’a pas pu être chargée pour la capture."));
      setTimeout(tick, 50);
    };
    tick();
  });
}

let sequence = 0;

/** Décrit ce que montre la page `reference` ; la charge hors de la vue si elle n’est pas affichée. */
export async function capturePage(reference: string, timeout = 12_000): Promise<PageSnapshot> {
  const located = findPage(useShell.getState().snapshot, reference);
  if (!located) throw new Error(`La page « ${reference} » n’existe pas dans l’espace.`);
  const visible = [...targets].find((target) => target.reference === reference && !target.hidden);
  let token: string | undefined;
  let target = visible;
  try {
    if (!target) {
      sequence += 1;
      token = `capture-${sequence}`;
      setHidden([...hiddenPages, { token, ...located }]);
      target = await waitTarget(reference, timeout);
    }
    await waitReady(target, timeout);
    const settle = SETTLE_MS - (Date.now() - target.readyAt);
    if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
    sequence += 1;
    const id = `d${sequence}`;
    const current = target;
    const payload = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        current.waiting.delete(id);
        reject(new Error("La page n’a pas répondu à la demande de capture."));
      }, timeout);
      current.waiting.set(id, (answer) => {
        clearTimeout(timer);
        current.waiting.delete(id);
        resolve(answer);
      });
      current.post({ alfred: ALFRED_MESSAGE, kind: "event", name: "describe", payload: { id } });
    });
    const answer = (payload ?? {}) as Record<string, unknown>;
    return {
      page: reference,
      title: located.page.title,
      displayed: visible !== undefined,
      text: bounded(answer.text, MAX_TEXT),
      truncated: answer.truncated === true || (typeof answer.text === "string" && answer.text.length > MAX_TEXT),
      runtimeError: frameErrors.get(reference) ?? null,
    };
  } finally {
    if (token) setHidden(hiddenPages.filter((item) => item.token !== token));
  }
}

/** Cadres invisibles des captures en cours : hors de la vue, sans focus, ignorés des lecteurs d’écran. */
export function SnapshotFrames() {
  const [pages, setPages] = useState<HiddenPage[]>(hiddenPages);
  useEffect(() => {
    hiddenListeners.add(setPages);
    setPages(hiddenPages);
    return () => {
      hiddenListeners.delete(setPages);
    };
  }, []);
  if (pages.length === 0) return null;
  return (
    <div className="page-snapshot-host" aria-hidden="true" inert>
      {pages.map((item) => (
        <PageFrame key={item.token} page={item.page} kind={item.kind} host={item.host} capture />
      ))}
    </div>
  );
}
