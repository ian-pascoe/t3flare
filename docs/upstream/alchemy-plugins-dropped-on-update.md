# Draft issue for alchemy: a Worker's `build.input.plugins` are dropped on every update

For the owner to file at alchemy-run/alchemy (not sent). Evidence from t3flare's step 0 spike
(`docs/spike/step-0.md`, acceptance item 5); our workaround is ADR-0020.

---

**Title:** Cloudflare Worker: `build.input.plugins` used on the first deploy, silently dropped on updates (2.0.0-beta.85)

**Versions:** `alchemy` 2.0.0-beta.85, `@alchemy.run/cloudflare` 2.0.0-beta.85, `rolldown` 1.2.13, Bun 1.4.4, macOS.

**What happens**

A `Cloudflare.Worker` with Rolldown plugins in `build.input.plugins` deploys correctly the first time: the
plugins run. Every later `alchemy deploy` of the same stage bundles **without** them, and nothing reports it.

Our plugins were an import-scoped alias of `node:fs` (a `transform`), stubs for two dependencies (a
`resolveId` + `load` pair) and in-memory patches of a few modules (`load`). Observed across six deploys of one
stage:

1. **First deploy:** the plugins ran (our `buildEnd` hook logged "node:fs alias rewrote 42 imports in 37
   modules"); the Worker booted.
2. **Second deploy (an update):** Rolldown failed inside our `resolveId` hook with `handler.call is not a
   function`. The hook was written as `{ order: "pre", handler }`; the object reached Rolldown without its
   `handler` function, so the plugin object had been copied in a way that drops nested functions.
3. **Third deploy, hooks rewritten as plain functions:** the update "succeeded", but the bundle alchemy
   wrote to `.alchemy/bundles/<stack>-<stage>-<id>/` contained no alias, no stub and no patch; the deployed
   Worker then failed at boot ("Disallowed operation called within global scope", from a dependency our stub
   replaced).
4. **A later deploy** planned "no changes" although the bundle the plugins would produce differed.

Our reading: on an update, the provider builds from the props it stored or planned with (a serialised
copy), not from the live props, so every function in `build.input` (plugins, and any function-valued
option) is lost; and the plan's hash does not cover what the plugins change.

**Expected:** an update bundles with the same `build.input` as the first deploy, including its plugins,
or fails loudly if it cannot.

**Repro sketch**

```ts
// alchemy.run.ts
const marker = (): import("rolldown").Plugin => ({
  name: "marker",
  transform(code, id) {
    return id.endsWith("/worker.ts") ? `${code}\nexport const marker = "plugin ran";` : null;
  },
});
export default Alchemy.Stack("repro", { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const w = yield* Cloudflare.Worker("W", { main: "./worker.ts", build: { input: { plugins: [marker()] } } });
    return { url: w.url };
  }));
```

`alchemy deploy`, then change `worker.ts` and `alchemy deploy` again: the second bundle in
`.alchemy/bundles/` has no `marker` export. (With `{ order, handler }` hooks the second deploy throws
`handler.call is not a function` instead.)

**Workaround we use:** bundle with Rolldown ourselves (same options alchemy uses: its Cloudflare plugin,
`minify`, `strictExecutionOrder`, `experimental.lazyBarrel`, `optimization.inlineConst`) and deploy with
`bundle: false` and `main` pointing at the output.

**Related, smaller:** `@alchemy.run/cloudflare-runtime/rolldown`'s Cloudflare plugin claims `node:*`
builtins in a `"pre"` `resolveId` hook, so a user plugin cannot alias a builtin with `resolveId` at all; we
use a `transform`. Worth a note in the docs for `build.input.plugins`.
