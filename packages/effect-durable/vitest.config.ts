import { configDefaults, defineConfig } from "vitest/config";

// Harness-level tests drive a real pi-durable Harness, which can exceed Vitest's 5 s default.
export default defineConfig({ test: { exclude: [...configDefaults.exclude], testTimeout: 30_000 } });
