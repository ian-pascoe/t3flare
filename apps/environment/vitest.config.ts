// Vitest on Node (ADR-0019), in two projects: `node` for the pure pieces (against Node's own SQLite where
// SQL matters), and `workerd` for the platform pieces against real Durable Object storage, through
// @cloudflare/vitest-plugin.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig, defineProject } from "vitest/config";

const workerd = "test/**/*.workerd.test.ts";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: [...configDefaults.exclude, workerd] },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./test/workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-11-01",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: { TEST_OBJECTS: { className: "TestObject", useSQLite: true } },
            },
          }),
        ],
        test: { name: "workerd", include: [workerd], testTimeout: 30_000 },
      }),
    ],
  },
});
