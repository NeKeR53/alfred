/**
 * Hôte d’un cadre de page ou de panneau : charge le module de la page, l’affiche dans `SocleProvider` (thème de
 * l’hôte, densité desktop) et rapporte à la coquille ce qui se passe (prêt, erreur de compilation, erreur
 * d’exécution). Les notifications de la page partent à la coquille ; une confirmation reste dans le cadre.
 */

import "./frame.css";
import {
  emitToShell,
  initPageState,
  onShellEvent,
  type PageContext,
  request,
  setFrameConfirm,
  shell,
} from "@alfred/sdk";
import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Code,
  createNotifications,
  EmptyState,
  type Notifications,
  type NotifyOptions,
  type Platform,
  SocleProvider,
  useConfirm,
} from "socle-ui";
import { frameShortcut, isShellShortcut } from "../sdk/protocol";
import { accentColor } from "./accent";
import { describePage, describeRegion } from "./describePage";
import { reviewPage } from "./reviewPage";
import { screenshotPage } from "./screenshotPage";
import { sealNetwork } from "./sealNetwork";

sealNetwork();

interface Diagnostic {
  message: string;
  line?: number;
  column?: number;
}

const params = new URLSearchParams(window.location.search);
const moduleId = params.get("module") ?? "";
/** Clé que la coquille remet au cadre pour le code de son module, et de lui seul. */
const moduleKey = params.get("key") ?? "";
const pageId = params.get("page") ?? "";
const base = new URL(".", import.meta.url).href.replace(/runtime\/$/, "");

let accent: string | undefined = accentColor(params.get("accent"));
const accentListeners = new Set<(accent: string | undefined) => void>();

function applyTheme(context: Pick<PageContext, "theme"> & { accent?: string | null; surface?: string }) {
  document.documentElement.dataset.theme = context.theme;
  const next = accentColor(context.accent);
  if (next !== accent) {
    accent = next;
    for (const listener of accentListeners) listener(next);
  }
  // Une page placée dans les Réglages prend leur style (titres de bloc, lignes, tableaux sans cadre).
  if (context.surface === "settings") document.documentElement.dataset.surface = "settings";
  else delete document.documentElement.dataset.surface;
  if (context.accent) document.documentElement.dataset.accent = context.accent;
  else delete document.documentElement.dataset.accent;
}

applyTheme({ theme: params.get("theme") === "dark" ? "dark" : "light", accent: params.get("accent") });
onShellEvent("context", (payload) => applyTheme(payload as PageContext & { accent?: string | null }));

function describe(error: unknown): { message: string; diagnostics?: Diagnostic[]; stack?: string } {
  if (error && typeof error === "object") {
    const known = error as { message?: string; stack?: string; alfredDiagnostics?: Diagnostic[] };
    return {
      message: known.message ?? String(error),
      diagnostics: known.alfredDiagnostics,
      stack: known.stack,
    };
  }
  return { message: String(error) };
}

function report(phase: "load" | "render" | "runtime", error: unknown) {
  emitToShell("error", { phase, ...describe(error) });
}

function Failure({ title, error }: { title: string; error: unknown }) {
  const details = describe(error);
  const text = details.diagnostics?.length
    ? details.diagnostics.map((item) => `${item.line ? `ligne ${item.line} : ` : ""}${item.message}`).join("\n")
    : details.message;
  return (
    <div className="alfred-frame__failure flex min-h-full flex-col justify-center gap-3 p-6">
      <EmptyState title={title} description="Je peux corriger cette page : l’erreur m’a été transmise." />
      <div data-alfred-withheld="true" className="mx-auto w-full max-w-[760px] min-w-0">
        <Code block label="Erreur de la page">
          {text}
        </Code>
      </div>
    </div>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    report("render", error);
  }
  render() {
    if (this.state.error !== undefined) {
      return <Failure title="Cette page a rencontré une erreur" error={this.state.error} />;
    }
    return this.props.children;
  }
}

const quiet = (call: () => Promise<unknown>) => {
  call().catch(() => undefined);
};

/**
 * File de notifications du cadre : `useNotify()` de `socle-ui` part à la coquille, qui l’affiche (toast et cloche).
 * Aucun toast n’est dessiné dans le cadre. L’action d’une notification (`onAction`) ne traverse pas le pont.
 */
const local = createNotifications();
let sent = 0;
const notifications: Notifications = {
  ...local,
  toastQueue: local.toastQueue,
  notify(options: NotifyOptions) {
    sent += 1;
    const tone = options.tone === "danger" ? "error" : options.tone;
    quiet(() =>
      shell.notify({
        title: options.title,
        ...(options.description ? { description: options.description } : {}),
        ...(tone ? { tone } : {}),
        ...(options.duration === null ? { persistent: true } : {}),
      }),
    );
    return `cadre-${sent}`;
  },
};

function platform(): Platform {
  const agent = navigator.userAgent;
  if (/Mac/i.test(agent)) return "macos";
  if (/Windows/i.test(agent)) return "windows";
  return "web";
}

/** Branche la confirmation des actions de la barre du haut (`useTopBarActions`) sur la modale de `socle-ui`. */
function ConfirmBridge() {
  const confirm = useConfirm();
  useEffect(() => {
    setFrameConfirm((options) => confirm(options));
    return () => setFrameConfirm(null);
  }, [confirm]);
  return null;
}

function Frame({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState(accent);
  useEffect(() => {
    accentListeners.add(setCurrent);
    return () => {
      accentListeners.delete(setCurrent);
    };
  }, []);
  return (
    <SocleProvider
      density="desktop"
      platform={platform()}
      storageKey={`alfred:${moduleId}:${pageId}`}
      notifications={notifications}
      {...(current ? { accent: current } : {})}
    >
      <ConfirmBridge />
      {children}
    </SocleProvider>
  );
}

function Host() {
  const [loaded, setLoaded] = useState<{ Page?: ComponentType; error?: unknown }>();

  useEffect(() => {
    let active = true;
    // L’état retenu de la page arrive avec son code : elle s’affiche d’emblée telle qu’on l’a laissée.
    const kept = request<Record<string, unknown>>("shell.state.get").catch(() => ({}));
    Promise.all([
      import(/* @vite-ignore */ `${base}m/${moduleId}/${moduleKey}/pages/${pageId}?v=${params.get("v") ?? ""}`),
      kept,
    ]).then(
      ([module, initial]: [{ default?: ComponentType }, Record<string, unknown>]) => {
        if (!active) return;
        initPageState(initial);
        if (typeof module.default !== "function") {
          const error = new Error("La page doit exporter son composant par défaut : `export default function Page()`.");
          report("load", error);
          setLoaded({ error });
          return;
        }
        setLoaded({ Page: module.default });
        emitToShell("ready");
      },
      (error: unknown) => {
        if (!active) return;
        report("load", error);
        setLoaded({ error });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (!loaded) return null;
  if (loaded.error !== undefined || !loaded.Page) {
    return <Failure title="Cette page ne compile pas" error={loaded.error} />;
  }
  const { Page } = loaded;
  return (
    <Boundary>
      <Page />
    </Boundary>
  );
}

// Raccourcis de la coquille (palette) : le focus est dans le cadre, la coquille ne les verrait pas.
window.addEventListener(
  "keydown",
  (event) => {
    const shortcut = frameShortcut(event);
    if (!shortcut) return;
    if (isShellShortcut(shortcut)) event.preventDefault();
    emitToShell("shortcut", shortcut);
  },
  true,
);

// Capture demandée par la coquille pour l’agent (outil `page_snapshot`) : ce que l’utilisateur voit, en texte.
onShellEvent("describe", (payload) => {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return;
  emitToShell("description", { id, ...describePage() });
});

// Élément encadré par l’utilisateur (« Corriger un élément ») : ce qu’il contient et où il se trouve dans la page.
onShellEvent("inspect", (payload) => {
  const request = (payload ?? {}) as { id?: unknown; rect?: unknown };
  const rect = request.rect as Record<string, unknown> | undefined;
  if (typeof request.id !== "string" || !rect) return;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  emitToShell("description", {
    id: request.id,
    region: describeRegion({
      x: number(rect.x),
      y: number(rect.y),
      width: number(rect.width),
      height: number(rect.height),
    }),
  });
});

// Examen de la page pour l’agent (outil `check`) : mesures de sa mise en page, puis du contraste dans chaque thème.
onShellEvent("review", (payload) => {
  const request = (payload ?? {}) as { id?: unknown; themes?: unknown };
  const id = request.id;
  if (typeof id !== "string") return;
  const themes = Array.isArray(request.themes)
    ? request.themes.filter((theme): theme is "light" | "dark" => theme === "light" || theme === "dark")
    : [];
  reviewPage({ themes }).then(
    (review) => emitToShell("description", { id, review }),
    (error: unknown) =>
      emitToShell("description", { id, error: error instanceof Error ? error.message : String(error) }),
  );
});

// Capture en image pour l’agent (outil `page_screenshot`) : le cadre se dessine lui-même.
onShellEvent("screenshot", (payload) => {
  const request = (payload ?? {}) as { id?: unknown; fullPage?: unknown; scale?: unknown };
  const id = request.id;
  if (typeof id !== "string") return;
  const scale = typeof request.scale === "number" ? request.scale : 1;
  screenshotPage({ fullPage: request.fullPage === true, scale }).then(
    (image) => emitToShell("description", { id, image }),
    (error: unknown) =>
      emitToShell("description", { id, error: error instanceof Error ? error.message : String(error) }),
  );
});

/** Message et pile : WebKit ne met pas le message dans `stack`. */
function errorText(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  if (!error.stack) return head;
  return error.stack.startsWith(head) ? error.stack : `${head}\n${error.stack}`;
}

// Console de la page : chaque ligne part aussi au journal de la page, que l’agent lit (outil `page_logs`).
function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return errorText(value);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circulaire]";
        seen.add(item);
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

for (const level of ["debug", "log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      emitToShell("log", { level, text: args.map(formatArgument).join(" ").slice(0, 8000) });
    } catch {
      // Le journal ne doit jamais casser la page.
    }
  };
}

// Le cadre a une origine opaque : une exception levée dans un minuteur ou un écouteur n’arrive à `window.onerror`
// que sous la forme « Script error. ». Les rappels sont donc enveloppés pour rapporter l’erreur elle-même.
let reportedAt = 0;
function guard<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  return function (this: unknown, ...args: Args): Result {
    try {
      return callback.apply(this, args);
    } catch (error) {
      reportedAt = Date.now();
      report("runtime", error);
      throw error;
    }
  };
}
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeSetInterval = window.setInterval.bind(window);
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
  nativeSetTimeout(
    typeof handler === "function" ? guard(handler as (...args: unknown[]) => unknown) : handler,
    timeout,
    ...rest,
  )) as typeof window.setTimeout;
window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
  nativeSetInterval(
    typeof handler === "function" ? guard(handler as (...args: unknown[]) => unknown) : handler,
    timeout,
    ...rest,
  )) as typeof window.setInterval;
window.requestAnimationFrame = (callback) => nativeRequestAnimationFrame(guard(callback));
const wrappedListeners = new WeakMap<(...args: never[]) => unknown, EventListener>();
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (typeof listener !== "function") return nativeAdd.call(this, type, listener, options);
  let wrapped = wrappedListeners.get(listener);
  if (!wrapped) {
    wrapped = guard(listener);
    wrappedListeners.set(listener, wrapped);
  }
  return nativeAdd.call(this, type, wrapped, options);
};
EventTarget.prototype.removeEventListener = function (type, listener, options) {
  const wrapped = typeof listener === "function" ? wrappedListeners.get(listener) : undefined;
  return nativeRemove.call(this, type, wrapped ?? listener, options);
};

window.addEventListener("error", (event) => {
  // Déjà rapportée, avec son message, par le rappel enveloppé.
  if (!event.error && Date.now() - reportedAt < 1000) return;
  report("runtime", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => report("runtime", event.reason));
// Le contexte complet (accent compris) arrive dès que la coquille répond.
void request<PageContext & { accent?: string | null }>("shell.context").then(applyTheme, () => undefined);

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <Frame>
      <Host />
    </Frame>,
  );
