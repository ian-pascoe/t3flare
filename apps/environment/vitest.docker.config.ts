// `pnpm run test:docker` (step 4a, plan §9): the real CLIs in Docker, launched by our profiles, against a stand-in
// `computer.internal` and model relay (no model is called). Not in `pnpm run check` (it needs Docker and the network);
// the t3 bump job runs it.
import { defineConfig } from "vitest/config";

import { T3_CONNECT_DEFINES } from "./src/t3/connectPublicConfig.ts";

export default defineConfig({
  // T3 Connect's public values, as build.ts defines them for the Worker (as in vitest.config.ts).
  define: T3_CONNECT_DEFINES,
  test: { include: ["test/docker/**/*.docker.test.ts"], testTimeout: 30 * 60_000, hookTimeout: 60_000 },
});
