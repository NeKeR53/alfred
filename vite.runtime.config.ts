import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { alias } from "./vite.config";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Environnement d’exécution des pages et des fonctions : des modules ES aux noms fixes, que la carte d’imports du
 * document hôte relie aux imports nus (`react`, `socle-ui`, `socle-ui/markdown`, `socle-ui/markdown-editor`,
 * `@alfred/sdk`, `@alfred/kit`, `lucide-react`). Rust les embarque et les sert par le protocole des pages.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "src-tauri/runtime",
    emptyOutDir: true,
    minify: true,
    cssCodeSplit: false,
    lib: {
      formats: ["es"],
      entry: {
        react: entry("./src/runtime/generated/react.js"),
        "react-dom": entry("./src/runtime/generated/react-dom.js"),
        "react-dom-client": entry("./src/runtime/generated/react-dom-client.js"),
        "jsx-runtime": entry("./src/runtime/generated/jsx-runtime.js"),
        lucide: entry("./src/runtime/generated/lucide.js"),
        socle: entry("./src/runtime/generated/socle.js"),
        "socle-markdown": entry("./src/runtime/generated/socle-markdown.js"),
        "socle-markdown-editor": entry("./src/runtime/generated/socle-markdown-editor.js"),
        kit: entry("./src/kit/index.tsx"),
        sdk: entry("./src/sdk/index.ts"),
        "page-host": entry("./src/runtime/pageHost.tsx"),
        "function-host": entry("./src/runtime/functionHost.ts"),
      },
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "alfred",
    },
    rollupOptions: {
      // Une seule instance de React, de socle-ui et du SDK : chaque entrée les retrouve par la carte d’imports. Les
      // trois entrées de socle-ui partagent leurs morceaux communs (un seul `SocleProvider`).
      external: (id, importer) => {
        if (!importer) return false;
        const generated = importer.includes("/src/runtime/generated/");
        if (
          [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "lucide-react",
            "socle-ui",
            "socle-ui/markdown",
            "socle-ui/markdown-editor",
          ].includes(id)
        ) {
          return !generated;
        }
        if (id === "@alfred/sdk" || id === "@alfred/kit") return true;
        return false;
      },
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
