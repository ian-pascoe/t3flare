# We bundle the Worker ourselves, and alchemy uploads it unbundled

alchemy 2.0.0-beta.85 passes a Worker's `build.input.plugins` to Rolldown on the first deploy only. On every update it bundles without them (it appears to copy the props it plans with, dropping functions), so our aliases, stubs and Patch silently vanish and the Worker fails at boot. Our `build.ts` therefore bundles with the same Rolldown options alchemy uses (its Cloudflare plugin, minify, `strictExecutionOrder`, `lazyBarrel`, `inlineConst`) plus our build shims, and `alchemy.run.ts` uploads the output with `bundle: false`. Patches are applied in memory at bundle time, so the submodule's tree stays clean; `git apply --check` validates them on a bump.

`node scripts/stage.ts deploy <stage>` is the only deploy path: it builds, then runs `alchemy deploy`. Revisit when alchemy keeps plugins on updates; the spike's evidence is in `docs-archive-1:docs/spike/step-0.md`, and the report was drafted in `docs-archive-1:docs/upstream/alchemy-plugins-dropped-on-update.md`.

## Refinement (tools step): the codemode and MCP Workers are bundled by alchemy

`t3flare-codemode-<stage>` and `t3flare-mcp-<stage>` import nothing of t3, so they need none of our Rolldown build's shims. pi-codemode imports `quickjs-wasi/quickjs.wasm`, which alchemy's bundler uploads as a compiled module by its default rule. Both Workers are bundled by alchemy (OD-T5). cloudpid's `sdk-isolation.test.ts` checks that the MCP Worker's bundle keeps the SDK apart.

## Refinement (2026-11-21): fixed upstream

alchemy has since fixed the dropped plugins (owner, 2026-11-21), so the draft issue was not filed. The pin is still 2.0.0-beta.85, so the build stays as above; revisit when the pin moves past it.
