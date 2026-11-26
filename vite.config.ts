/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5173, host: "0.0.0.0" },
  test: {
    environment: "node",
    setupFiles: ["test/ui/setup.ts"],
    testTimeout: 120000
  }
});
