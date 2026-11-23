/**
 * Moteur du composant `Terminal` : xterm.js, chargé à la première ouverture d’un terminal (comme pdf.js pour
 * `DocumentViewer`), ajusté à son conteneur et aux thèmes clair, sombre et contraste élevé.
 */
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TerminalEngine {
  write(data: string | Uint8Array): void;
  focus(): void;
  size(): { cols: number; rows: number };
  /** Vide l’écran et l’historique ; l’invite courante reste. */
  clear(): void;
  /** Texte de l’historique et de l’écran, ses `lines` dernières lignes seulement si précisé. */
  text(lines?: number): string;
  /** Texte sélectionné, vide sans sélection. */
  selection(): string;
  /** Colle le texte comme l’utilisateur (collage encadré si le programme l’a demandé). */
  paste(value: string): void;
  /** Le programme a demandé le collage encadré (`ESC [?2004h`) : un texte sur plusieurs lignes ne s’exécute pas. */
  bracketedPaste(): boolean;
  dispose(): void;
}

export interface TerminalEngineOptions {
  label: string;
  description: string;
  readOnly: boolean;
  onData(data: string): void;
  onResize(size: { cols: number; rows: number }): void;
  onLeave(direction: "forward" | "backward"): void;
  onCopy(text: string): void;
}

export type TerminalKeyAction = "copy" | "paste" | "leave-forward" | "leave-backward" | "terminal";

/**
 * Raccourcis de Windows Terminal : Ctrl+C copie seulement quand du texte est sélectionné (sinon il interrompt le
 * programme), Ctrl+Maj+C copie toujours, Ctrl+V et Ctrl+Maj+V collent, F6 et Maj+F6 sortent du terminal. Sur macOS,
 * Cmd+C et Cmd+V restent ceux du système.
 */
export function terminalKeyAction(
  event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  hasSelection: boolean,
): TerminalKeyAction {
  if (event.type !== "keydown" || event.altKey || event.metaKey) return "terminal";
  if (event.key === "F6" && !event.ctrlKey) return event.shiftKey ? "leave-backward" : "leave-forward";
  if (!event.ctrlKey) return "terminal";
  const key = event.key.toLowerCase();
  if (key === "c" && (event.shiftKey || hasSelection)) return "copy";
  if (key === "v") return "paste";
  return "terminal";
}

let colorCanvas: CanvasRenderingContext2D | null | undefined;

/** xterm ne lit pas oklch : la couleur calculée est ramenée en rgb par un canevas. */
function rgbColor(value: string, alpha?: number) {
  try {
    colorCanvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  } catch {
    colorCanvas = null;
  }
  if (!colorCanvas) return value;
  colorCanvas.clearRect(0, 0, 1, 1);
  colorCanvas.fillStyle = value;
  colorCanvas.fillRect(0, 0, 1, 1);
  const [red, green, blue] = colorCanvas.getImageData(0, 0, 1, 1).data;
  return alpha === undefined ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Couleurs du thème courant : les jetons d’Alfred et la palette ANSI de `ansi.css`. */
export function terminalTheme(element: HTMLElement): { theme: ITheme; minimumContrastRatio: number } {
  const forced = window.matchMedia?.("(forced-colors: active)").matches ?? false;
  const probe = document.createElement("span");
  element.append(probe);
  const resolve = (color: string, alpha?: number) => {
    probe.style.color = color;
    return rgbColor(getComputedStyle(probe).color, alpha);
  };
  try {
    if (forced) {
      const text = resolve("CanvasText");
      return {
        theme: {
          background: resolve("Canvas"),
          foreground: text,
          cursor: text,
          cursorAccent: resolve("Canvas"),
          selectionBackground: resolve("Highlight"),
          selectionForeground: resolve("HighlightText"),
          ...Object.fromEntries(ANSI_NAMES.map((name) => [name, text])),
        },
        minimumContrastRatio: 7,
      };
    }
    return {
      theme: {
        background: resolve("var(--color-surface)"),
        foreground: resolve("var(--color-ink)"),
        cursor: resolve("var(--color-primary)"),
        cursorAccent: resolve("var(--color-surface)"),
        selectionBackground: resolve("var(--color-primary)", 0.32),
        ...Object.fromEntries(ANSI_NAMES.map((name, index) => [name, resolve(`var(--ui-ansi-${index})`)])),
      },
      // Garde lisibles les couleurs 256 et RVB prévues pour un fond sombre quand le thème est clair.
      minimumContrastRatio: 4.5,
    };
  } finally {
    probe.remove();
  }
}

function monoFont(element: HTMLElement) {
  return (
    getComputedStyle(element).getPropertyValue("--font-mono").trim() ||
    'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace'
  );
}

export function openTerminal(element: HTMLElement, options: TerminalEngineOptions): TerminalEngine {
  const instance = new XTerm({
    allowProposedApi: false,
    cursorBlink: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    disableStdin: options.readOnly,
    fontFamily: monoFont(element),
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5_000,
    screenReaderMode: true,
    ...terminalTheme(element),
  });
  const fit = new FitAddon();
  instance.loadAddon(fit);
  instance.attachCustomKeyEventHandler((event) => {
    const action = terminalKeyAction(event, instance.hasSelection());
    if (action === "copy") {
      event.preventDefault();
      const selection = instance.getSelection();
      if (selection) options.onCopy(selection);
      return false;
    }
    // Laisse le navigateur produire l’évènement « coller », que xterm transmet au programme.
    if (action === "paste") return false;
    if (action === "leave-forward" || action === "leave-backward") {
      event.preventDefault();
      options.onLeave(action === "leave-forward" ? "forward" : "backward");
      return false;
    }
    return true;
  });
  const data = instance.onData((value) => {
    if (!options.readOnly) options.onData(value);
  });
  // La taille est dite au service une fois ajustée au conteneur, puis à chaque changement, jamais deux fois la même.
  let reported = "";
  const report = () => {
    const key = `${instance.cols}x${instance.rows}`;
    if (key === reported) return;
    reported = key;
    options.onResize({ cols: instance.cols, rows: instance.rows });
  };
  const resize = instance.onResize(report);
  instance.open(element);
  instance.textarea?.setAttribute("aria-label", options.label);
  instance.textarea?.setAttribute("aria-description", options.description);

  let frame = 0;
  const refit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (element.clientWidth && element.clientHeight) fit.fit();
      report();
    });
  };
  refit();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
  observer?.observe(element);

  const applyTheme = () => {
    const { theme, minimumContrastRatio } = terminalTheme(element);
    instance.options.theme = theme;
    instance.options.minimumContrastRatio = minimumContrastRatio;
  };
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent", "class"],
  });
  const media = ["(prefers-color-scheme: dark)", "(forced-colors: active)"].flatMap((query) => {
    const list = window.matchMedia?.(query);
    return list ? [list] : [];
  });
  for (const list of media) list.addEventListener("change", applyTheme);

  return {
    write: (value) => instance.write(value),
    focus: () => instance.focus(),
    size: () => ({ cols: instance.cols, rows: instance.rows }),
    clear: () => instance.clear(),
    text: (lines) => {
      const buffer = instance.buffer.active;
      const all: string[] = [];
      for (let index = 0; index < buffer.length; index += 1)
        all.push(buffer.getLine(index)?.translateToString(true) ?? "");
      while (all.length && !all[all.length - 1]) all.pop();
      return (lines ? all.slice(-lines) : all).join("\n");
    },
    selection: () => instance.getSelection(),
    paste: (value) => instance.paste(value),
    bracketedPaste: () => instance.modes.bracketedPasteMode,
    dispose: () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      themeObserver.disconnect();
      for (const list of media) list.removeEventListener("change", applyTheme);
      data.dispose();
      resize.dispose();
      instance.dispose();
    },
  };
}
