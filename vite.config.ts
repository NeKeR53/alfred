import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const alias = {
  "@alfred/sdk": fileURLToPath(new URL("./src/sdk/index.ts", import.meta.url)),
};

/**
 * socle-ui arrive par yalc : une nouvelle publication ne change pas toujours `pnpm-lock.yaml`, et Vite garderait
 * son ancienne copie pré-compilée. La signature de `yalc.lock` nomme le cache : chaque publication a le sien.
 */
function socleSignature(): string {
  try {
    const lock = JSON.parse(readFileSync(new URL("./yalc.lock", import.meta.url), "utf8"));
    return String(lock.packages?.["socle-ui"]?.signature ?? "npm");
  } catch {
    return "npm";
  }
}

export default defineConfig({
  cacheDir: `node_modules/.vite/socle-${socleSignature()}`,
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  clearScreen: false,
  server: {
    port: 14730,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
