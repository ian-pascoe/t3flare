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

## Refinement (step 2a, M2)

The order is a preference by default, not a rule over size: **a Patch beats a large Shadow when the change is tiny**, because `git apply --check` flags drift in the lines the Patch touches on every bump, while a Shadow of a large module silently freezes all of it. Step 2a's `0002-new-project-root-is-w.patch` changes one line of `ManagedProjectFolders` (the named-projects root becomes `/w`); the Shadow it replaces would have copied 472 lines. Evidence: `docs/steps/step-2a/m2-new-project.png` (New project creates `/w/<name>` with an initial commit), the bump's `git apply --check`. Counts after step 2a part 1: Shadows 1 (`builtInDrivers`), Patches 2.

## Counts after step 4a

Shadows 2: `builtInDrivers` (now registering the Codex and Pi CLI drivers too) and `processGroup` (`@t3tools/provider-core/server/processGroup`, imported by package subpath, so the Shadow plugin also resolves bare `@t3tools/*` specifiers): t3's pi adapter signals its process group with `process.kill`, which cannot reach a Container, so a process channel pid is signalled through the channel instead. Patches 3: `0003-provider-session-idle-10-minutes.patch` (one line of `runtimeLayer.ts`: `ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 10 minutes })`), chosen over a Shadow of the 300-line runtime layer. Build shims: the `node:fs` alias now skips `provider-pi/src/server/mcpExtensionSource.ts`, whose `node:fs` import is the text of a program pi runs in the Container (`FS_ALIAS_SKIP`).

## Counts after step 4b

Unchanged: Shadows 2 (`builtInDrivers` registers Claude Code and OpenCode too; `processGroup` now also stops their process groups, through t3's `AcpSessionRuntime`), Patches 3, no new Build shim (`@t3tools/provider-acp` and `effect-acp` were already in the Worker through `AcpRegistrySupport`). Everything else is a Layer: our flavors passed to t3's exported `makeAcpAdapterV2`, a runtime wrapper around t3's `AcpSessionRuntime`, and one composition departure (t3's idle compaction worker is not started, `composition.ts`). `reg/claudeAcp.ts`'s subagent extractors are imported by source path (not a package export).

## Counts after the parity batch (G7, G4, G12)

Shadows 2 (unchanged), Patches 4: `0004-scratch-root-is-a-workspace.patch` (parity G4) changes one line of `ManagedProjectFolders`, the No project folder, to `/w/t3-scratch`, so scratch threads run in a Workspace. A Layer could not do it: `ManagedProjectFolders` is built inside t3's private runtime graph (`orchestration-v2/runtimeLayer.ts`) from the one `ServerConfig`, whose `baseDir` everything else reads too, and the Shadow would copy 515 lines. The review guide's scratch checkout (G7) and the webhook origin and PR-watch wake (G12) are Layers and our own code. Evidence: `docs/steps/parity-batch.md`.
