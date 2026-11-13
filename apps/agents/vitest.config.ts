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
              compatibilityFlags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
              bindings: { T3FLARE_LEASE_MS: "300", T3FLARE_MAX_CONTAINERS: "2" },
              durableObjects: {
                // The fake-clock subclass for lease timing; the real class (wall clock) for the one test of the default.
                CONTAINER_BUDGET: { className: "FakeClockContainerBudget", useSQLite: true },
                WALL_CLOCK_BUDGET: { className: "ContainerBudget", useSQLite: true },
                SETTING_BUDGET: { className: "SettingContainerBudget", useSQLite: true },
                VFS_PROBE: { className: "VfsProbe", useSQLite: true },
              },
            },
          }),
        ],
        test: { name: "workerd", include: [workerd], testTimeout: 30_000 },
      }),
    ],
  },
});
