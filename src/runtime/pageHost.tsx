/**
 * Hôte d’un cadre de page ou de panneau : charge le module de la page, l’affiche avec la bibliothèque d’Alfred et
 * rapporte à la coquille ce qui se passe (prêt, erreur de compilation, erreur d’exécution).
 */

import { emitToShell, onShellEvent, type PageContext, request } from "@alfred/sdk";
import { EmptyState } from "@alfred/ui";
import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { frameShortcut, isShellShortcut } from "../sdk/protocol";
import { describePage } from "./describePage";
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

function applyTheme(context: Pick<PageContext, "theme"> & { accent?: string | null }) {
  document.documentElement.dataset.theme = context.theme;
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
      <EmptyState title={title} description="L’agent peut corriger cette page : l’erreur lui est transmise.">
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

window.addEventListener("error", (event) => report("runtime", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => report("runtime", event.reason));
// Le contexte complet (accent compris) arrive dès que la coquille répond.
void request<PageContext & { accent?: string | null }>("shell.context").then(applyTheme, () => undefined);

const root = document.getElementById("root");
if (root) createRoot(root).render(<Host />);
