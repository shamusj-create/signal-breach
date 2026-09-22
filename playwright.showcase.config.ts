import { defineConfig } from "@playwright/test";

// Headed showcase/capture config for the final visual pass. Deliberately separate from
// playwright.config.ts so `npx playwright test` (verify-all) does NOT pick this up.
// Reuses the healthy dev server on 5199 if one is already running.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "visual.showcase.ts",
  timeout: 300000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "off",
    headless: false,
    launchOptions: { slowMo: 150 },
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "npx vite --config packages/web/vite.config.ts --port 5199 --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:5199",
    cwd: ".",
    timeout: 60000,
    reuseExistingServer: true,
  },
});
