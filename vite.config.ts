import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const alias = {
  "@alfred/sdk": fileURLToPath(new URL("./src/sdk/index.ts", import.meta.url)),
};

export default defineConfig({
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
