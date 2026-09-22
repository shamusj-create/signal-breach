import { defineConfig } from "@playwright/test";

// Config for the review capture tool only (e2e/tools.review.ts). Kept separate so the default
// `npx playwright test` (used by scripts/verify-all.sh) does NOT collect the capture tool.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "tools.review.ts",
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "off",
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
