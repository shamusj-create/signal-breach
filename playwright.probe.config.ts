import { defineConfig } from "@playwright/test";

// Config for the visual FOUNDATION probe tool only (e2e/tools.probe.ts).
// Kept separate from the default testMatch so verify-all does not collect it.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "tools.probe.ts",
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "off",
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: "chromium" }],
  webServer: [
    {
      command: "npx tsx packages/server/src/index.ts",
      url: "http://127.0.0.1:8787/api/health",
      cwd: ".",
      timeout: 60000,
      reuseExistingServer: true,
    },
    {
      command: "npx vite --config packages/web/vite.config.ts --port 5199 --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:5199",
      cwd: ".",
      timeout: 60000,
      reuseExistingServer: true,
    },
  ],
});
