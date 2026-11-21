// The repository's checks (ADR-0030; was scripts/check.ts). `pnpm run check` runs `check:all`: every task it depends
// on must pass before a push to main. The tasks run at once, as check.ts ran them, and nothing is cached (plan D5).
//
//   - check:patches: every t3 Patch applies to the pinned t3code (`git apply --check`)
//   - check:fs: every node:fs member t3's bundled modules read is implemented by a State directory shim, or allowed
//     with its reason (SPI-1301; `build.ts --check-fs`, a bundle kept in memory)
//   - check:workspace: pnpm-workspace.yaml, package.json and mise.toml match the pinned t3code
//   - check:lock: t3's importers install exactly what t3's lock installs, one `effect`, patches, vendored links
//   - test:scripts: the root scripts' own tests, on `node --test`
//   - typecheck: `effect-tsgo tsrs` per package, and for the root `scripts/` (typecheck:scripts, its own tsconfig);
//     lint: oxlint, type-aware through tsrs-lint, which oxlint finds by itself (ADR-0030), with `--deny-warnings` and
//     `--report-unused-disable-directives-severity error`, so a suppression that suppresses nothing fails. Every t3flare
//     package and the root `scripts/` are linted (lint:scripts for the root); test: Vitest on Node
//
// Not run here, on purpose:
//   - lint of vendor/cloudpid: it is vendored unchanged (vendor/cloudpid/README.md), and each package's .oxlintrc.json
//     extends `../../.oxlintrc.json`, cloudpid's root config, which is not vendored.
//   - tools/demo-video: its own pnpm workspace and lock, outside this one (tools/demo-video/AGENTS.md); it is checked
//     there with `mise exec -- pnpm run check`, after its own install.
import { defineConfig } from "vite-plus";

const each = (pkg: string, ...tasks: Array<string>) => tasks.map((task) => `${pkg}#${task}`);

export default defineConfig({
  run: {
    cache: false,
    tasks: {
      "check:patches": { command: "node build.ts --check", cwd: "apps/environment" },
      "check:fs": { command: "node build.ts --check-fs", cwd: "apps/environment" },
      "check:workspace": "node scripts/gen-workspace.ts --check",
      "check:lock": "node scripts/verify-lock.ts",
      "typecheck:scripts": { command: "effect-tsgo tsrs --noEmit", cwd: "scripts" },
      "lint:scripts": "oxlint --type-aware --deny-warnings --report-unused-disable-directives-severity error scripts",
      "test:scripts": "node --test 'scripts/**/*.test.ts'",
      // cloudpid's MCP core, vendored (vendor/cloudpid/README.md): typecheck without emitting into vendor/, and its
      // own tests but those about cloudpid's repository layout. Root tasks, so vendor/ stays unedited. Root tasks see only the root's
      // bins on PATH, so the package's own vitest is named by path.
      "typecheck:cloudpid-mcp": { command: "effect-tsgo tsrs --noEmit", cwd: "vendor/cloudpid/mcp" },
      "test:cloudpid-mcp": {
        command: "node_modules/.bin/vitest run --exclude 'conformance/**' --exclude src/import-rule.test.ts --exclude src/sdk-isolation.test.ts",
        cwd: "vendor/cloudpid/mcp",
      },
      "check:all": {
        command: "node -e \"console.log('check passed')\"",
        dependsOn: [
          "check:patches",
          "check:fs",
          "check:workspace",
          "check:lock",
          "typecheck:scripts",
          "lint:scripts",
          "test:scripts",
          ...each("@t3flare/environment", "typecheck", "lint", "test"),
          ...each("@t3flare/infra", "typecheck", "lint", "test"),
          ...each("@t3flare/agents", "typecheck", "lint", "test"),
          "typecheck:cloudpid-mcp",
          "test:cloudpid-mcp",
          ...each("@t3flare/mcp-worker", "typecheck", "lint", "test"),
          ...each("@t3flare/codemode-sandbox", "typecheck", "lint"),
          // check.ts never typechecked these three (plan D8), nor linted them; they have no tests.
          ...["sandbox-image", "models", "session-protocol"].flatMap((name) => each(`@t3flare/${name}`, "typecheck", "lint")),
          ...["effect-durable", "computer-env", "github-app", "workspace-client", "harness-registry", "skills"].flatMap((name) =>
            each(`@t3flare/${name}`, "typecheck", "lint", "test"),
          ),
        ],
      },
    },
  },
});
