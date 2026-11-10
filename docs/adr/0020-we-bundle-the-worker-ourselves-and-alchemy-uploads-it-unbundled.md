# We bundle the Worker ourselves, and alchemy uploads it unbundled

alchemy 2.0.0-beta.85 passes a Worker's `build.input.plugins` to Rolldown on the first deploy only. On every update it bundles without them (it appears to copy the props it plans with, dropping functions), so our aliases, stubs and Patch silently vanish and the Worker fails at boot. Our `build.ts` therefore bundles with the same Rolldown options alchemy uses (its Cloudflare plugin, minify, `strictExecutionOrder`, `lazyBarrel`, `inlineConst`) plus our build shims, and `alchemy.run.ts` uploads the output with `bundle: false`. Patches are applied in memory at bundle time, so the submodule's tree stays clean; `git apply --check` validates them on a bump.

Revisit when alchemy keeps plugins on updates; the spike's evidence is in `docs/spike/step-0.md` for an upstream report.
