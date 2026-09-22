import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop 1080p"] } }],
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