/**
 * Hôte d’un cadre de page ou de panneau : charge le module de la page, l’affiche avec la bibliothèque d’Alfred et
 * rapporte à la coquille ce qui se passe (prêt, erreur de compilation, erreur d’exécution).
 */

import { emitToShell, onShellEvent, type PageContext, request, shell } from "@alfred/sdk";
import { EmptyState, type FrameServices, FrameServicesContext } from "@alfred/ui";
import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { frameShortcut, isShellShortcut } from "../sdk/protocol";
import { describePage, describeRegion } from "./describePage";
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

function applyTheme(context: Pick<PageContext, "theme"> & { accent?: string | null; surface?: string }) {
  document.documentElement.dataset.theme = context.theme;
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
  return (
    <div className="alfred-frame__failure">
      <EmptyState title={title} description="Je peux corriger cette page : l’erreur m’a été transmise.">
        <pre data-alfred-withheld="true">
          {details.diagnostics?.length
            ? details.diagnostics.map((item) => `${item.line ? `ligne ${item.line} : ` : ""}${item.message}`).join("\n")
            : details.message}
        </pre>
      </EmptyState>
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

/** Services des gabarits de `@alfred/ui`, branchés sur le pont : un échec d’appel n’interrompt jamais la page. */
const quiet = (call: () => Promise<unknown>) => {
  call().catch(() => undefined);
};
const services: FrameServices = {
  notify: (options) => quiet(() => shell.notify(options)),
  publish: (selection) => quiet(() => shell.publish(selection)),
  setPanelVisible: (visible) => quiet(() => shell.setPanelVisible(visible)),
  openExternal: (url) => quiet(() => shell.openExternal(url)),
  send: (message) => quiet(() => shell.send(message)),
  onPeer: (handler) => onShellEvent("peer", handler),
  onSelection: (handler) => {
    let active = true;
    void request<PageContext>("shell.context").then(
      (context) => active && handler(context.selection),
      () => undefined,
    );
    const stop = onShellEvent("context", (payload) => handler((payload as PageContext).selection));
    return () => {
      active = false;
      stop();
    };
  },
};

function Host() {
  const [loaded, setLoaded] = useState<{ Page?: ComponentType; error?: unknown }>();

  useEffect(() => {
    let active = true;
    import(/* @vite-ignore */ `${base}m/${moduleId}/${moduleKey}/pages/${pageId}?v=${params.get("v") ?? ""}`).then(
      (module: { default?: ComponentType }) => {
        if (!active) return;
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
    <FrameServicesContext.Provider value={services}>
      <Boundary>
        <Page />
      </Boundary>
    </FrameServicesContext.Provider>
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

// Capture en image pour l’agent (outil `page_screenshot`) : le cadre se dessine lui-même.
onShellEvent("screenshot", (payload) => {
  const request = (payload ?? {}) as { id?: unknown; fullPage?: unknown };
  const id = request.id;
  if (typeof id !== "string") return;
  screenshotPage({ fullPage: request.fullPage === true }).then(
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
if (root) createRoot(root).render(<Host />);
