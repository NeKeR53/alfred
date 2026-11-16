/**
 * « Corriger un élément » : l’utilisateur capture toute la fenêtre d’Alfred (barre de gauche, page, panneau de
 * droite), encadre l’élément qui ne va pas, et une
 * conversation d’agent s’ouvre dans le panneau de droite avec la capture annotée et la description de l’élément
 * déjà jointes. Il n’a plus qu’à écrire ce qu’il veut changer.
 */

import { Button, IconButton } from "@alfred/ui";
import { Crosshair, LoaderCircle } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ResolvedPage } from "../../lib/types";
import { type AppScreenshot, inspectApp, screenshotApp } from "../../shell/appScreenshot";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { setComposerDraft } from "./drafts";
import { saveBlob } from "./files";
import { useAgents } from "./store";
import { fixContext, type Rect, rectBetween } from "./uiFixModel";
import "./ui-fix.css";

/** En deçà, le geste est un clic : il ne désigne pas de zone. */
const MIN_SIZE = 6;

type Phase =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "selecting"; shot: AppScreenshot; url: string }
  | { kind: "preparing" };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Capture illisible."));
    image.src = url;
  });
}

/** La capture avec la zone choisie cerclée de rouge et le reste assombri. */
async function annotate(url: string, rect: Rect | null): Promise<Blob> {
  const image = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canevas indisponible.");
  context.drawImage(image, 0, 0);
  if (rect) {
    context.fillStyle = "rgba(0, 0, 0, 0.28)";
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.fill("evenodd");
    context.strokeStyle = "#e5484d";
    context.lineWidth = 3;
    context.strokeRect(rect.x - 1.5, rect.y - 1.5, rect.width + 3, rect.height + 3);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Capture non encodée."))), "image/png"),
  );
}

function failure(title: string, error: unknown) {
  notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });
}

/** Bouton de la barre du haut et calque de sélection posé sur la page. */
export function UiFixTool({ page }: { page: ResolvedPage; container: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const showAgentPanel = useShell((state) => state.showAgentPanel);

  // L’image vit jusqu’à la fin de l’annotation (confirm) ou l’annulation ; une fermeture de la page la libère aussi.
  const imageUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );
  const release = () => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = null;
  };

  const start = async () => {
    if (phase.kind !== "idle") return;
    setPhase({ kind: "capturing" });
    try {
      const shot = await screenshotApp();
      const bytes = Uint8Array.from(atob(shot.data), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      imageUrl.current = url;
      setPhase({ kind: "selecting", shot, url });
    } catch (error) {
      setPhase({ kind: "idle" });
      failure("Capture impossible", error);
    }
  };

  const confirm = async (rect: Rect | null) => {
    if (phase.kind !== "selecting") return;
    const { shot, url: keep } = phase;
    setPhase({ kind: "preparing" });
    try {
      const region = rect ? await inspectApp(rect, document.querySelector(".ui-fix")).catch(() => null) : null;
      const blob = await annotate(keep, rect);
      const agents = useAgents.getState();
      if (!agents.ready) await agents.load();
      const conversation = useAgents.getState().create({
        title: `Corriger · ${page.title}`,
        origin: { reference: page.reference, title: page.title },
      });
      const attachment = await saveBlob(
        conversation.id,
        new File([blob], `capture-${page.id}.png`, { type: "image/png" }),
      );
      setComposerDraft(conversation.id, {
        attachments: [attachment],
        contexts: [
          {
            id: crypto.randomUUID(),
            title: rect ? `Élément à corriger · ${page.title}` : `Page à corriger · ${page.title}`,
            text: fixContext(page, shot, rect, region, attachment.path),
          },
        ],
      });
      showAgentPanel(page.reference, conversation.id);
    } catch (error) {
      failure("Conversation non ouverte", error);
    } finally {
      release();
      setPhase({ kind: "idle" });
    }
  };

  const busy = phase.kind === "capturing" || phase.kind === "preparing";
  return (
    <>
      <IconButton
        label="Corriger un élément avec l’agent"
        aria-pressed={phase.kind === "selecting"}
        disabled={busy || page.missing}
        onClick={() => void start()}
      >
        {busy ? (
          <LoaderCircle className="is-spinning" size={15} aria-hidden="true" />
        ) : (
          <Crosshair size={15} aria-hidden="true" />
        )}
      </IconButton>
      {phase.kind === "selecting"
        ? createPortal(
            <RegionPicker
              url={phase.url}
              width={phase.shot.width}
              height={phase.shot.height}
              onConfirm={(rect) => void confirm(rect)}
              onCancel={() => {
                release();
                setPhase({ kind: "idle" });
              }}
            />,
            // Le calque couvre toute la fenêtre : la barre de gauche et le panneau de droite se corrigent aussi.
            document.body,
          )
        : null}
    </>
  );
}

/** Calque posé sur la page : la capture figée, sur laquelle l’utilisateur trace un cadre. */
function RegionPicker({
  url,
  width,
  height,
  onConfirm,
  onCancel,
}: {
  url: string;
  width: number;
  height: number;
  onConfirm: (rect: Rect | null) => void;
  onCancel: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    layer.current?.focus();
  }, []);

  /** Point du pointeur en pixels de la capture, quelle que soit la taille affichée de l’image. */
  const toImage = (event: ReactPointerEvent) => {
    const box = image.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - box.left) / box.width) * width,
      y: ((event.clientY - box.top) / box.height) * height,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest(".ui-fix__bar")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = toImage(event);
    setRect(null);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    setRect(rectBetween(origin.current, toImage(event), { width, height }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    const final = rectBetween(origin.current, toImage(event), { width, height });
    origin.current = null;
    if (final.width < MIN_SIZE || final.height < MIN_SIZE) {
      setRect(null);
      return;
    }
    onConfirm(final);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onConfirm(null);
    }
  };

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return (
    <div
      ref={layer}
      className="ui-fix"
      role="application"
      aria-label="Encadrer l’élément à corriger"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div className="ui-fix__canvas">
        <img ref={image} className="ui-fix__shot" src={url} alt="" draggable={false} />
        {rect ? (
          <div
            className="ui-fix__rect"
            style={{
              left: percent(rect.x, width),
              top: percent(rect.y, height),
              width: percent(rect.width, width),
              height: percent(rect.height, height),
            }}
          />
        ) : null}
      </div>
      <div className="ui-fix__bar" role="toolbar" aria-label="Correction d’un élément">
        <span className="ui-fix__hint">Encadrez l’élément à corriger</span>
        <Button onClick={() => onConfirm(null)}>Toute la fenêtre</Button>
        <Button onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}
