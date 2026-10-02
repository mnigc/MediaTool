import { defineConfig } from "vitest/config";

// The rough-cut tests are pure-function only (timeline model, view math,
// compat fields, project-store parsing): no DOM, no component tree, no IPC.
// This config stays separate from the app's vite.config.ts on purpose, so the
// react + tailwind plugins never load in a test run.
export default defineConfig({
  test: {
    environment: "node",
  },
});
