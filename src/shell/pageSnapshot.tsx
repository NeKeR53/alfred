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
  /** Le cadre montre des données d’exemple. */
  examples: boolean;
  /** Jeton du cadre invisible chargé pour une capture : deux captures de la même page ne se confondent pas. */
  token?: string;
  /** Requêtes de la page en cours (fonctions, base, services) et heure de la dernière. */
  inflight: number;
  lastActivity: number;
  waiting: Map<string, (payload: unknown) => void>;
  onReady: Set<() => void>;
}

const targets = new Set<Target>();
const MAX_TEXT = 30_000;
/** Laisse aux données de la page le temps d’arriver après son chargement. */
const SETTLE_MS = 800;
/** Examen : la page est prête quand elle n’a plus de requête en cours depuis ce délai… */
const QUIET_MS = 400;
/** … ou au bout de ce délai, pour une page qui interroge sans cesse. */
const QUIET_MAX_MS = 6_000;

/**
 * Tailles des cadres invisibles : celle d’une capture (`page_snapshot`, `page_screenshot`), et celles de l’examen de
 * `check`, la zone de la page dans une fenêtre de 1440 × 900 (sous la barre du haut de 38 px et à droite du menu de
 * 240 px ; panneau de 272 px ouvert si la page en a un) et dans une fenêtre de 1024 de large.
 */
export const VIEWPORTS = {
  capture: { width: 1280, height: 800, window: "", className: "h-[800px] w-[1280px]" },
  wide: { width: 1200, height: 862, window: "1440 × 900", className: "h-[862px] w-[1200px]" },
  widePanel: { width: 928, height: 862, window: "1440 × 900, panneau ouvert", className: "h-[862px] w-[928px]" },
  narrow: { width: 784, height: 862, window: "1024 × 900", className: "h-[862px] w-[784px]" },
} as const;
export type Viewport = keyof typeof VIEWPORTS;

/**
 * Inscrit le cadre d’une page affichée. PageFrame transmet `ready`, `error` (une page en échec se décrit aussi) et
 * `description` ; renvoie la fonction qui désinscrit le cadre.
 */
export function registerSnapshotTarget(
  reference: string,
  post: (message: FrameMessage) => void,
  hidden = false,
  frame: () => HTMLIFrameElement | null = () => null,
  examples = false,
  token?: string,
) {
  const target: Target = {
    reference,
    frame,
    post,
    ready: false,
    readyAt: 0,
    hidden,
    examples,
    ...(token ? { token } : {}),
    inflight: 0,
    lastActivity: 0,
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
    /** Une requête de la page commence (`1`) ou se termine (`-1`). */
    busy(delta: 1 | -1) {
      target.inflight = Math.max(0, target.inflight + delta);
      target.lastActivity = Date.now();
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
  /** Capture demandée en données d’exemple. */
  examples?: boolean;
  /** Taille du cadre (`capture` par défaut). */
  viewport?: Viewport;
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

function waitTarget(reference: string, timeout: number, examples: boolean, token?: string): Promise<Target> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = [...targets].find(
        (target) =>
          target.reference === reference &&
          (token ? target.token === token : !examples || (target.hidden && target.examples)),
      );
      if (found) return resolve(found);
      if (Date.now() - started > timeout) return reject(new Error("La page n’a pas pu être chargée pour la capture."));
      setTimeout(tick, 50);
    };
    tick();
  });
}

let sequence = 0;

type FrameRequest = "describe" | "screenshot" | "inspect" | "review";

/** Attend que la page n’ait plus de requête en cours depuis `QUIET_MS`, au plus `QUIET_MAX_MS`. */
async function waitQuiet(target: Target) {
  const started = Date.now();
  while (Date.now() - started < QUIET_MAX_MS) {
    if (target.inflight === 0 && Date.now() - target.lastActivity >= QUIET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Envoie `name` au cadre `target`, déjà chargé, et rend sa réponse. */
async function request(
  target: Target,
  name: FrameRequest,
  extra: Record<string, unknown>,
  timeout: number,
  quiet = false,
): Promise<unknown> {
  await waitReady(target, timeout);
  const settle = SETTLE_MS - (Date.now() - target.readyAt);
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
  if (quiet) await waitQuiet(target);
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

/**
 * Charge la page si besoin, lui envoie `name` et rend sa réponse ; `displayed` dit si elle était à l’écran. Avec
 * `viewport`, la page est toujours chargée dans un cadre invisible de cette taille ; avec `quiet`, la demande attend
 * que la page ait reçu ses données.
 */
async function askFrame(
  reference: string,
  name: FrameRequest,
  extra: Record<string, unknown>,
  timeout: number,
  examples = false,
  options: { viewport?: Viewport; quiet?: boolean } = {},
): Promise<{ located: NonNullable<ReturnType<typeof findPage>>; displayed: boolean; answer: Record<string, unknown> }> {
  const located = findPage(useShell.getState().snapshot, reference);
  if (!located) throw new Error(`La page « ${reference} » n’existe pas dans l’espace de travail.`);
  // En données d’exemple, la page affichée ne sert que si elle les montre déjà ; sinon un cadre invisible les charge.
  const visible = options.viewport
    ? undefined
    : [...targets].find((target) => target.reference === reference && !target.hidden && (!examples || target.examples));
  let token: string | undefined;
  let target = visible;
  try {
    if (!target) {
      sequence += 1;
      token = `capture-${sequence}`;
      setHidden([
        ...hiddenPages,
        {
          token,
          ...located,
          ...(examples ? { examples: true } : {}),
          ...(options.viewport ? { viewport: options.viewport } : {}),
        },
      ]);
      target = await waitTarget(reference, timeout, examples, token);
    }
    const payload = await request(target, name, extra, timeout, options.quiet === true);
    return { located, displayed: visible !== undefined, answer: (payload ?? {}) as Record<string, unknown> };
  } finally {
    if (token) setHidden(hiddenPages.filter((item) => item.token !== token));
  }
}

/** Décrit ce que montre la page `reference` ; la charge hors de la vue si elle n’est pas affichée. */
export async function capturePage(
  reference: string,
  timeout = 12_000,
  options: { examples?: boolean } = {},
): Promise<PageSnapshot> {
  const { located, displayed, answer } = await askFrame(reference, "describe", {}, timeout, options.examples === true);
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
export async function screenshotFrameElement(frame: HTMLIFrameElement, timeout = 8_000, scale = 1) {
  const target = targetOf(frame);
  if (!target) throw new Error("Ce cadre n’est pas une page d’Alfred.");
  const answer = (await request(target, "screenshot", { fullPage: false, scale }, timeout)) ?? {};
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
  options: { fullPage?: boolean; examples?: boolean } = {},
  timeout = 15_000,
): Promise<PageScreenshotResult> {
  const { located, displayed, answer } = await askFrame(
    reference,
    "screenshot",
    { fullPage: options.fullPage === true },
    timeout,
    options.examples === true,
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

/** Nombre, borné, venu d’un cadre. */
function count(value: unknown, max = 100_000): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-max, Math.min(max, Math.round(value * 100) / 100))
    : 0;
}

function list<T>(value: unknown, read: (item: Record<string, unknown>) => T, limit = 8): T[] {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => read((item ?? {}) as Record<string, unknown>)) : [];
}

/**
 * Mesures d’un examen, relues champ par champ : elles viennent du cadre, donc du code de la page. Les textes sont
 * bornés et restent une donnée pour l’agent.
 */
export function sanitizeReview(answer: Record<string, unknown>) {
  if (typeof answer.error === "string") throw new Error(`Examen impossible : ${bounded(answer.error, 500)}`);
  const review = (answer.review ?? {}) as Record<string, unknown>;
  const layout = (review.layout ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => bounded(value, 120);
  return {
    layout: {
      width: count(layout.width),
      height: count(layout.height),
      busy: layout.busy === true,
      contentTop: count(layout.contentTop),
      contentBottom: count(layout.contentBottom),
      contentLeft: count(layout.contentLeft),
      contentRight: count(layout.contentRight),
      belowFold: list(layout.belowFold, (item) => ({
        kind: ["heading", "collection", "alert", "action"].includes(String(item.kind)) ? String(item.kind) : "heading",
        text: text(item.text),
        top: count(item.top),
      })),
      gaps: list(layout.gaps, (item) => ({
        top: count(item.top),
        height: count(item.height),
        above: text(item.above),
        below: text(item.below),
      })),
      truncated: list(layout.truncated, (item) => ({ text: text(item.text), shown: count(item.shown, 1) })),
      truncatedCount: count(layout.truncatedCount),
      overflow: list(layout.overflow, (item) => ({
        kind: item.kind === "page" ? "page" : "table",
        text: text(item.text),
        hidden: count(item.hidden),
      })),
      filledButtons: list(layout.filledButtons, (item) => ({ text: text(item.text), top: count(item.top) })),
    },
    contrast: list(
      review.contrast,
      (item) => ({
        theme: item.theme === "dark" ? "dark" : "light",
        count: count(item.count),
        items: list(item.items, (entry) => ({ text: text(entry.text), ratio: count(entry.ratio, 21) })),
      }),
      2,
    ),
  };
}

export type PageReviewMeasure = ReturnType<typeof sanitizeReview> & {
  /** Fenêtre simulée, et taille du cadre de la page. */
  window: string;
  width: number;
  height: number;
};

export interface PageReviewResult {
  page: string;
  viewports?: PageReviewMeasure[];
  error?: string;
}

/**
 * Examen d’une page pour `check` : deux cadres invisibles chargés en même temps, à la taille de la page dans une
 * fenêtre de 1440 × 900 (panneau ouvert si la page en a un) et de 1024 de large ; contraste en clair et en sombre
 * dans le premier.
 */
export async function reviewPage(
  reference: string,
  options: { examples?: boolean; panel?: boolean } = {},
  timeout = 15_000,
): Promise<PageReviewResult> {
  const wide: Viewport = options.panel ? "widePanel" : "wide";
  const ask = async (viewport: Viewport, themes: string[]): Promise<PageReviewMeasure> => {
    const { answer } = await askFrame(reference, "review", { themes }, timeout, options.examples === true, {
      viewport,
      quiet: true,
    });
    const { window, width, height } = VIEWPORTS[viewport];
    return { window, width, height, ...sanitizeReview(answer) };
  };
  const viewports = await Promise.all([ask(wide, ["light", "dark"]), ask("narrow", [])]);
  return { page: reference, viewports };
}

/** Examine les pages une à une ; une page qui ne se charge pas rend son erreur sans arrêter les autres. */
export async function reviewPages(
  pages: { page: string; examples?: boolean; panel?: boolean }[],
): Promise<PageReviewResult[]> {
  const results: PageReviewResult[] = [];
  for (const item of pages.slice(0, 12)) {
    try {
      results.push(await reviewPage(item.page, item));
    } catch (error) {
      results.push({ page: item.page, error: bounded(error instanceof Error ? error.message : String(error), 300) });
    }
  }
  return results;
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
    <div className="pointer-events-none fixed top-0 left-[-20000px] opacity-0" aria-hidden="true" inert>
      {pages.map((item) => (
        <div key={item.token} className={`flex ${VIEWPORTS[item.viewport ?? "capture"].className}`}>
          <PageFrame
            page={item.page}
            kind={item.kind}
            host={item.host}
            capture
            token={item.token}
            examples={item.examples === true}
          />
        </div>
      ))}
    </div>
  );
}
