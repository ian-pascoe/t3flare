// The repository's checks (ADR-0030; was scripts/check.ts). `pnpm run check` runs `check:all`: every task it depends
// on must pass before a push to main. The tasks run at once, as check.ts ran them, and nothing is cached (plan D5).
//
//   - check:patches: every t3 Patch applies to the pinned t3code (`git apply --check`)
//   - check:workspace: pnpm-workspace.yaml, package.json and mise.toml match the pinned t3code
//   - check:lock: t3's importers install exactly what t3's lock installs, one `effect`, patches, vendored links
//   - typecheck: `effect-tsgo tsrs` per package; lint: oxlint, type-aware through tsrslint; test: Vitest on Node
import { defineConfig } from "vite-plus";

const each = (pkg: string, ...tasks: Array<string>) => tasks.map((task) => `${pkg}#${task}`);

export default defineConfig({
  run: {
    cache: false,
    tasks: {
      "check:patches": { command: "node build.ts --check", cwd: "apps/environment" },
      "check:workspace": "node scripts/gen-workspace.ts --check",
      "check:lock": "node scripts/verify-lock.ts",
      "lint:scripts": "oxlint scripts",
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
          "check:workspace",
          "check:lock",
          "lint:scripts",
          ...each("@t3flare/environment", "typecheck", "lint", "test"),
          ...each("@t3flare/infra", "typecheck", "lint", "test"),
          ...each("@t3flare/agents", "typecheck", "lint", "test"),
          "typecheck:cloudpid-mcp",
          "test:cloudpid-mcp",
          ...each("@t3flare/mcp-worker", "typecheck", "test"),
          ...each("@t3flare/codemode-sandbox", "typecheck"),
          ...["effect-durable", "computer-env", "github-app", "workspace-client", "harness-registry"].flatMap((name) =>
            each(`@t3flare/${name}`, "typecheck", "test"),
          ),
        ],
      },
    },
  },
});
