import { defineConfig } from "vitest/config";

// The MCP tests drive real SDK clients against fake servers, many at once under `pnpm run check`: past Vitest's 5 s default.
export default defineConfig({ test: { testTimeout: 30_000 } });
