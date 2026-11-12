// `bun run test:docker` (step 4a, plan §9): the real CLIs in Docker against the model proxy. Not in `bun run check`
// (it needs Docker, the network and the proxy's key); the nightly bump job runs it.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/docker/**/*.docker.test.ts"], testTimeout: 30 * 60_000, hookTimeout: 60_000 },
});
