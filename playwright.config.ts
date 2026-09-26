import { defineConfig, devices } from "@playwright/test";

// The browser suite is run as TWO sequential lanes (see scripts/verify-all.sh) so the heavy
// 3D journeys never contend. The split is a partition of the SAME full test set: every spec
// is matched by exactly one project, so the two `npx playwright test --project=...` lanes run
// all 97 tests between them, each exactly once. No test is skipped/removed and no per-test
// timeout is raised here.
//
// Lane A "heavy" = the contention-sensitive 3D journeys. Measured serial per-test cost is high
// enough that running two of them on two workers pushes tests toward the 60s per-test wall
// (orbit-rotate already reached 54.5s at workers=2). Run lane A at workers=1 so none contend.
const heavySpecs = [
  /camera-frame\.spec\.ts/,
  /orbit-rotate\.spec\.ts/,
  /chars\.spec\.ts/,
  /pan-relative\.spec\.ts/,
  /mouse-only\.spec\.ts/,
];

const projectUse = { ...devices["Desktop 1080p"] };

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
  projects: [
    {
      name: "heavy",
      testMatch: heavySpecs,
      use: projectUse,
    },
    {
      name: "rest",
      // default testMatch picks up the remaining *.spec.ts; heavy specs are ignored here so
      // the two projects partition the set with zero overlap.
      testIgnore: heavySpecs,
      use: projectUse,
    },
  ],
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
