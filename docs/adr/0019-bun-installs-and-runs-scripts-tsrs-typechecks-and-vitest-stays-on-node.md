# Bun installs and runs scripts, tsrs typechecks, and Vitest stays on Node

The owner wants the fastest possible devtools, so the repo follows cloudpid's ADR-0028 instead of t3code's pnpm toolchain. Bun installs dependencies, with the isolated linker and the global store, and runs scripts. Each package typechecks with `effect-tsgo tsrs`, the native checker from `@effect/tsgo` with the Effect language service built in. Vitest and Vite stay on Node, where cloudpid measured Bun slower and flaky for workerd tests. alchemy's CLI runs under Bun. cloudpid measured tsrs at about a third of `tsc`'s CPU and memory, and Bun's warm install at about a third of pnpm's wall time.

t3code is a pnpm workspace, so a Bun script generates the root `package.json`'s `catalog`, `overrides` and `patchedDependencies` from its `pnpm-workspace.yaml`. Only the t3code packages we import are workspace members. A single copy of `effect` remains mandatory, because duplicate copies break schema decoding.

## Considered Options

- **pnpm, to reuse t3's workspace file as is**: no translation script, but slower installs, and `tsc` remains the checker.
- **`bun check` for typecheck**: it runs no Effect diagnostics.
