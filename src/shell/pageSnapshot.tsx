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
  /** Élément `<iframe>` du cadre, pour retrouver un cadre affiché à sa place dans la fenêtre. */
  frame: () => HTMLIFrameElement | null;
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
export function registerSnapshotTarget(
  reference: string,
  post: (message: FrameMessage) => void,
  hidden = false,
  frame: () => HTMLIFrameElement | null = () => null,
) {
  const target: Target = {
    reference,
    frame,
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

/** Envoie `name` au cadre `target`, déjà chargé, et rend sa réponse. */
async function request(
  target: Target,
  name: "describe" | "screenshot" | "inspect",
  extra: Record<string, unknown>,
  timeout: number,
): Promise<unknown> {
  await waitReady(target, timeout);
  const settle = SETTLE_MS - (Date.now() - target.readyAt);
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
  sequence += 1;
  const id = `d${sequence}`;
  const current = target;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      current.waiting.delete(id);
      reject(new Error("La page n’a pas répondu à la demande de capture."));
    }, timeout);
    current.waiting.set(id, (answer) => {
      clearTimeout(timer);
      current.waiting.delete(id);
      resolve(answer);
    });
    current.post({ alfred: ALFRED_MESSAGE, kind: "event", name, payload: { id, ...extra } });
  });
}

/** Charge la page si besoin, lui envoie `name` et rend sa réponse ; `displayed` dit si elle était à l’écran. */
async function askFrame(
  reference: string,
  name: "describe" | "screenshot" | "inspect",
  extra: Record<string, unknown>,
  timeout: number,
): Promise<{ located: NonNullable<ReturnType<typeof findPage>>; displayed: boolean; answer: Record<string, unknown> }> {
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
    const payload = await request(target, name, extra, timeout);
    return { located, displayed: visible !== undefined, answer: (payload ?? {}) as Record<string, unknown> };
  } finally {
    if (token) setHidden(hiddenPages.filter((item) => item.token !== token));
  }
}

/** Décrit ce que montre la page `reference` ; la charge hors de la vue si elle n’est pas affichée. */
export async function capturePage(reference: string, timeout = 12_000): Promise<PageSnapshot> {
  const { located, displayed, answer } = await askFrame(reference, "describe", {}, timeout);
  return {
    page: reference,
    title: located.page.title,
    displayed,
    text: bounded(answer.text, MAX_TEXT),
    truncated: answer.truncated === true || (typeof answer.text === "string" && answer.text.length > MAX_TEXT),
    runtimeError: frameErrors.get(reference) ?? null,
  };
}

export interface PageScreenshotResult {
  page: string;
  title: string;
  displayed: boolean;
  /** PNG en base64. */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  clipped: boolean;
  runtimeError: unknown;
}

/** Plus grande image acceptée d’un cadre (base64) : au-delà, le cadre ment ou la page est démesurée. */
const MAX_IMAGE = 12_000_000;

/** Image rendue par un cadre : PNG base64 validé et ses dimensions. */
function frameImage(answer: Record<string, unknown>) {
  if (typeof answer.error === "string") throw new Error(`Capture impossible : ${bounded(answer.error, 500)}`);
  const image = (answer.image ?? {}) as Record<string, unknown>;
  const data = typeof image.data === "string" ? image.data : "";
  if (!data || data.length > MAX_IMAGE || !/^[A-Za-z0-9+/]+=*$/.test(data)) {
    throw new Error("La page n’a pas rendu d’image valide.");
  }
  const size = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
  return { data, width: size(image.width), height: size(image.height), clipped: image.clipped === true };
}

/** Cadre affiché dans l’élément `<iframe>` donné, s’il est inscrit. */
function targetOf(frame: HTMLIFrameElement): Target | undefined {
  return [...targets].find((target) => !target.hidden && target.frame() === frame);
}

/** Image de la partie visible d’un cadre affiché, désigné par son `<iframe>` (capture de toute la fenêtre). */
export async function screenshotFrameElement(frame: HTMLIFrameElement, timeout = 8_000) {
  const target = targetOf(frame);
  if (!target) throw new Error("Ce cadre n’est pas une page d’Alfred.");
  const answer = (await request(target, "screenshot", { fullPage: false }, timeout)) ?? {};
  return { reference: target.reference, ...frameImage(answer as Record<string, unknown>) };
}

/** Décrit ce qui se trouve sous `rect` (coordonnées du cadre) dans un cadre affiché, désigné par son `<iframe>`. */
export async function inspectFrameElement(
  frame: HTMLIFrameElement,
  rect: { x: number; y: number; width: number; height: number },
  timeout = 5_000,
): Promise<PageRegion & { reference: string }> {
  const target = targetOf(frame);
  if (!target) throw new Error("Ce cadre n’est pas une page d’Alfred.");
  const answer = ((await request(target, "inspect", { rect }, timeout)) ?? {}) as Record<string, unknown>;
  const region = (answer.region ?? {}) as Record<string, unknown>;
  const path = Array.isArray(region.path) ? region.path.slice(0, 12).map((item) => bounded(item, 200)) : [];
  return { reference: target.reference, path, text: bounded(region.text, 8000), truncated: region.truncated === true };
}

/** Image de la page `reference`, dessinée par son cadre ; la charge hors de la vue si elle n’est pas affichée. */
export async function screenshotPage(
  reference: string,
  options: { fullPage?: boolean } = {},
  timeout = 15_000,
): Promise<PageScreenshotResult> {
  const { located, displayed, answer } = await askFrame(
    reference,
    "screenshot",
    { fullPage: options.fullPage === true },
    timeout,
  );
  const image = frameImage(answer);
  return {
    page: reference,
    title: located.page.title,
    displayed,
    data: image.data,
    mimeType: "image/png",
    width: image.width,
    height: image.height,
    clipped: image.clipped,
    runtimeError: frameErrors.get(reference) ?? null,
  };
}

export interface PageRegion {
  /** Ancêtres de l’élément encadré, du plus large au plus précis. */
  path: string[];
  text: string;
  truncated: boolean;
}

/** Décrit l’élément que l’utilisateur a encadré sur la page affichée (coordonnées de la partie visible du cadre). */
export async function inspectRegion(
  reference: string,
  rect: { x: number; y: number; width: number; height: number },
  timeout = 5_000,
): Promise<PageRegion> {
  const { answer } = await askFrame(reference, "inspect", { rect }, timeout);
  const region = (answer.region ?? {}) as Record<string, unknown>;
  const path = Array.isArray(region.path) ? region.path.slice(0, 12).map((item) => bounded(item, 200)) : [];
  return { path, text: bounded(region.text, 8000), truncated: region.truncated === true };
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
