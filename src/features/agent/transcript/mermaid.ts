/**
 * Schémas Mermaid (flux, séquence, classes, états, Gantt…), repris de `mermaidDiagram` de OneApp. La bibliothèque
 * est un fichier du dépôt, `public/vendor/mermaid`, chargé à la première utilisation : son poids ne pèse pas sur le
 * démarrage.
 */
type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
};
declare global {
  interface Window {
    mermaid?: MermaidApi;
  }
}
export type MermaidTheme = "light" | "dark";

let library: Promise<MermaidApi> | undefined;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  library ??= new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}vendor/mermaid/mermaid.min.js`;
    script.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("Mermaid est indisponible.")));
    script.onerror = () => {
      library = undefined;
      reject(new Error("Mermaid n’a pas pu être chargé."));
    };
    document.head.append(script);
  });
  return library;
}

// Mermaid garde une configuration globale : les rendus passent l’un après l’autre, chacun avec son thème.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  const task = queue
    .catch(() => undefined)
    .then(async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: theme === "dark" ? "dark" : "default",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      sequence += 1;
      return (await mermaid.render(`alfred-mermaid-${sequence}`, source)).svg;
    });
  queue = task;
  return task;
}
