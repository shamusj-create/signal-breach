import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sb/sim": r("./packages/sim/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    include: [
      "packages/sim/test/**/*.test.ts",
      "packages/server/test/**/*.test.ts",
    ],
    testTimeout: 30000,
  },
});