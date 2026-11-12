import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { alias } from "./vite.config";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Environnement d’exécution des pages et des fonctions : des modules ES aux noms fixes, que la carte d’imports du
 * document hôte relie aux imports nus (`react`, `@alfred/ui`, `@alfred/sdk`, `lucide-react`). Rust les embarque et
 * les sert par le protocole des pages.
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
        ui: entry("./src/ui/index.ts"),
        sdk: entry("./src/sdk/index.ts"),
        "page-host": entry("./src/runtime/pageHost.tsx"),
        "function-host": entry("./src/runtime/functionHost.ts"),
      },
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "alfred",
    },
    rollupOptions: {
      // Une seule instance de React et de la bibliothèque : chaque entrée les retrouve par la carte d’imports.
      external: (id, importer) => {
        if (!importer) return false;
        const generated = importer.includes("/src/runtime/generated/");
        if (["react", "react-dom", "react-dom/client", "react/jsx-runtime", "lucide-react"].includes(id)) {
          return !generated;
        }
        if (id === "@alfred/ui" || id === "@alfred/sdk") return true;
        return false;
      },
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
