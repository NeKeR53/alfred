/**
 * Fichiers glissés depuis le système (Finder, Explorateur) sur une page de l’espace. Tauri capte le glisser-déposer
 * de la fenêtre (`dragDropEnabled`) : le cadre isolé d’une page ne voit aucun événement du DOM. La coquille écoute
 * donc le dépôt natif, trouve le cadre sous le pointeur et lui signale le survol, que son gabarit montre
 * (`isDraggingFiles`). Au dépôt, elle copie les fichiers dans ceux du module, avec les contrôles de `files.save`
 * (50 Mo, types acceptés par la page), puis remet leurs `FileInfo` au cadre. Seul un cadre qui l’a demandé
 * (`useFileDrop` du SDK, `files.acceptDrops`) reçoit des fichiers ; ailleurs, la conversation de l’agent garde le
 * dépôt (`Composer`). Le cadre ne nomme jamais un chemin : les chemins viennent du geste de l’utilisateur.
 */
import { inTauri, invoke } from "../lib/native";
import type { FrameIdentity, FramePush } from "./frameBridge";
import { notify } from "./notifications";

/** Position du pointeur donnée par Tauri : en pixels physiques, depuis le coin haut gauche de la webview. */
export interface DropPosition {
  x: number;
  y: number;
}

/** Ce que Tauri signale d’un glisser de fichiers au-dessus de la fenêtre (`onDragDropEvent`). */
export type NativeDrag =
  | { type: "enter"; paths: string[]; position: DropPosition }
  | { type: "over"; position: DropPosition }
  | { type: "drop"; paths: string[]; position: DropPosition }
  | { type: "leave" };

/** Ce qu’une page a demandé (`files.acceptDrops`) : les types qu’elle accepte, et le canal vers son cadre. */
export interface DropAcceptance {
  /** Extensions acceptées, sans point ; `null` : tous les types. */
  accept: string[] | null;
  /** Pousse un événement au cadre qui a fait la demande. */
  push: FramePush;
  /** Le demandeur, tel que Rust le reçoit (`subject` du pont). */
  subject: Record<string, unknown>;
  /** Page à qui rattacher la notification d’un fichier refusé. */
  source: string;
}

interface DropFrame {
  element: () => HTMLElement | null;
  identity: () => FrameIdentity;
  acceptance: DropAcceptance | null;
}

/** Inscription d’un cadre affiché : `reset` quand il charge un nouveau document, `dispose` quand il disparaît. */
export interface DropFrameHandle {
  reset(): void;
  dispose(): void;
}

interface Refused {
  name: string;
  reason: string;
}

const frames = new Set<DropFrame>();
/** Cadre que survolent des fichiers, s’il en accepte. */
let hovered: DropFrame | null = null;
let listening = false;

/** Survol : seul le cadre sous le pointeur montre son cadre de dépôt ; celui qu’on quitte le retire. */
function hover(frame: DropFrame | null) {
  if (hovered === frame) return;
  hovered?.acceptance?.push("fileDrag", { dragging: false });
  hovered = frame;
  frame?.acceptance?.push("fileDrag", { dragging: true });
}

function forget(frame: DropFrame) {
  if (hovered === frame) hover(null);
  frame.acceptance = null;
}

/**
 * Inscrit le cadre d’une page affichée (`PageFrame`), jamais celui d’une capture. `identity` rend l’identité
 * courante du cadre : elle peut changer sans que son document change.
 */
export function registerDropFrame(element: () => HTMLElement | null, identity: () => FrameIdentity): DropFrameHandle {
  const frame: DropFrame = { element, identity, acceptance: null };
  frames.add(frame);
  listen();
  return {
    // Un nouveau document dans le cadre : ce que l’ancien acceptait ne vaut plus ; le nouveau le redemande.
    reset: () => forget(frame),
    dispose: () => {
      forget(frame);
      frames.delete(frame);
    },
  };
}

/** La page du cadre reçoit désormais les fichiers déposés sur elle. Faux si son cadre n’est pas affiché. */
export function acceptFileDrops(identity: FrameIdentity, acceptance: DropAcceptance): boolean {
  const frame = [...frames].find((candidate) => candidate.identity() === identity);
  if (!frame) return false;
  frame.acceptance = acceptance;
  return true;
}

/** La page du cadre ne reçoit plus de fichiers (son `useFileDrop` est démonté ou coupé). */
export function refuseFileDrops(identity: FrameIdentity) {
  for (const frame of frames) if (frame.identity() === identity) forget(frame);
}

/**
 * Cadre qui prend les fichiers sous ce point : celui qui est au premier plan à cet endroit (une fenêtre ou une modale
 * posée dessus le cache), s’il en accepte.
 */
function frameAt(position: DropPosition | undefined): DropFrame | null {
  if (!position || frames.size === 0) return null;
  const ratio = window.devicePixelRatio || 1;
  const hit = document.elementFromPoint?.(position.x / ratio, position.y / ratio);
  if (!hit) return null;
  for (const frame of frames) {
    const element = frame.element();
    if (frame.acceptance && element && (element === hit || element.contains(hit))) return frame;
  }
  return null;
}

/** Une page de l’espace prend-elle les fichiers déposés à cet endroit ? La conversation de l’agent les laisse alors. */
export function pageTakesDrop(position: DropPosition | undefined): boolean {
  return frameAt(position) !== null;
}

/** « 2 fichiers non ajoutés » : chaque nom avec sa raison, trois au plus. */
export function refusedNotice(refused: readonly Refused[]): { title: string; description: string } {
  const title = refused.length > 1 ? `${refused.length} fichiers non ajoutés` : "1 fichier non ajouté";
  const shown = refused.slice(0, 3).map(({ name, reason }) => `« ${name} » : ${reason}.`);
  if (refused.length > 3) shown.push(`Et ${refused.length - 3} autres.`);
  return { title, description: shown.join(" ") };
}

/** Copie les fichiers déposés dans ceux du module, puis les remet au cadre ; les refusés sont dits à l’utilisateur. */
async function deliver({ accept, push, subject, source }: DropAcceptance, paths: string[]) {
  push("fileDrag", { dragging: false, importing: true });
  try {
    const { files, refused } = await invoke<{ files: unknown[]; refused: Refused[] }>("frame.files.importDropped", {
      paths,
      accept,
      subject,
    });
    if (files.length) push("filesDropped", { files });
    if (refused.length) notify({ ...refusedNotice(refused), tone: "warning", source });
  } catch (error) {
    notify({
      title: "Fichiers non ajoutés",
      description: error instanceof Error ? error.message : String(error),
      tone: "error",
      source,
    });
  } finally {
    push("fileDrag", { dragging: false, importing: false });
  }
}

/** Un événement de glisser-déposer du système : survol, sortie ou dépôt. */
export function handleNativeDrag(event: NativeDrag) {
  if (event.type === "leave") return hover(null);
  const target = frameAt(event.position);
  if (event.type !== "drop") return hover(target);
  hover(null);
  if (target?.acceptance && event.paths.length) void deliver(target.acceptance, event.paths);
}

/** Écoute le glisser-déposer de la fenêtre, une fois, dès qu’un cadre de page s’affiche. */
function listen() {
  if (listening || !inTauri) return;
  listening = true;
  void import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => handleNativeDrag(event.payload as NativeDrag)),
    )
    .catch(() => {
      listening = false;
    });
}
