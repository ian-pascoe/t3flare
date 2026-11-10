// Vitest on Node (ADR-0019): `node` for pure pieces, `workerd` for the Durable Objects against real storage.
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
              bindings: { T3FLARE_LEASE_MS: "300", T3FLARE_MAX_CONTAINERS: "2" },
              durableObjects: { CONTAINER_BUDGET: { className: "ContainerBudget", useSQLite: true } },
            },
          }),
        ],
        test: { name: "workerd", include: [workerd], testTimeout: 30_000 },
      }),
    ],
  },
});
