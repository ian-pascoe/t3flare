# t3code is a pinned submodule, changed by Layer, then Shadow, then Patch

t3flare runs t3code's own server code so that stock t3 clients and Peer links work unchanged. We take t3code as a git submodule pinned to a nightly tag (ADR-0017), and our packages import its modules. A change to t3's behaviour is made, in order of preference:

1. our own Layer for one of t3's Effect services;
2. a **Shadow**: a bundler alias that replaces a whole module;
3. a **Patch** file, applied in memory at bundle time (ADR-0020).

Beside these sit **Build shims**: import-scoped aliases of Node builtins, stubs for dependencies that do something workerd forbids at module load, and build-time defines (`import.meta.url` and friends). They are counted apart from Shadows. The step 0 spike needed 1 Patch, 0 Shadows and six Build shims. Step 1 keeps 1 Patch and 0 Shadows; its Build shims are the import-scoped `node:fs`/`fs`/`node:fs/promises`/`fs/promises` and `node:module`/`module` aliases of t3's modules, the `node:sea` stub, the generated `@anthropic-ai/claude-agent-sdk` stub and the three `import.meta` defines, plus one diagnostic transform that changes no behaviour: the module-state probe, which registers t3's module-level mutable bindings for the twice-in-one-isolate boot check (ADR-0003). `apps/environment/build.ts` writes the counts to `dist/build-report.json` on every build, and refuses to build when a Patch fails `git apply --check`.

Most of the Node-only code (`server.ts`, the platform Layers) is never imported, because we write our own composition root. The outer workspace's catalog, overrides and patched dependencies are generated from t3's `pnpm-workspace.yaml`, so we resolve the same versions t3 does (toolchain in ADR-0019).

## Considered Options

- **A straight fork with our app in-tree**: no workspace mechanics, but edits in place cost nothing, so the fork drifts silently.
- **A vendored subtree**: easier to hack on, harder to rebase.
