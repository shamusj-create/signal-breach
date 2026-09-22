import { defineConfig, devices } from "@playwright/test";

// Config for the visual capture tool only. Kept separate so the default `npx playwright test`
// (used by scripts/verify-all.sh) does NOT collect the capture tool.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "tools.capture.ts",
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop 1080p"] } }],
  webServer: {
    command: "npx vite --config packages/web/vite.config.ts --port 5199 --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:5199",
    cwd: ".",
    timeout: 60000,
    reuseExistingServer: true,
  },
});
