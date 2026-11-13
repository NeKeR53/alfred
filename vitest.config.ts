import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { alias } from "./vite.config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    // jsdom fournit `localStorage` aux tests ; celui, expérimental, de Node ne sert pas et avertit à chaque worker.
    execArgv: ["--no-experimental-webstorage"],
  },
});
