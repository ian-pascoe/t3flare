// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
// The environment Worker (ADR-0014) for the step 0 spike: the front door, the
// Environment DO and the stock t3 web client as static assets.
//
//   T3_BOOTSTRAP_TOKEN=… T3FLARE_ADMIN_TOKEN=… bun alchemy deploy --stage spike
//
// The web client must be built first (`bun run prepare:web` copies t3's apps/web build to
// dist/web), and the Worker too (`bun build.ts`, which `bun run deploy` runs).
//
// The Worker is prebuilt and uploaded with `bundle: false`. Bundling through alchemy's
// `build.input` worked on the first deploy, but alchemy 2.0.0-beta.85 drops functions from
// the stored props on an update, so every later deploy bundled without our plugins (no
// `node:fs` alias, no stubs, no patches) and the Worker failed at boot. See
// docs/spike/step-0.md.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import { COMPATIBILITY } from "./build.ts";

const here = import.meta.dirname;

export default Alchemy.Stack(
  "t3flare",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const environment = yield* Cloudflare.Worker("Environment", {
      main: path.join(here, "dist/worker/worker.js"),
      bundle: false,
      compatibility: COMPATIBILITY,
      // One Environment DO; a deploy resets it when idle or after 5 minutes (ADR-0004 later
      // raises this to ~30 minutes).
      env: {
        ENVIRONMENT: Cloudflare.DurableObject("EnvironmentDO", { className: "EnvironmentDO" }),
        T3_BOOTSTRAP_TOKEN: Config.Redacted("T3_BOOTSTRAP_TOKEN"),
        T3FLARE_ADMIN_TOKEN: Config.Redacted("T3FLARE_ADMIN_TOKEN"),
      },
      assets: {
        directory: path.join(here, "dist/web"),
        notFoundHandling: "single-page-application",
        // t3's server paths (DEV_PROXIED_PATH_PREFIXES) reach the Worker before the assets.
        runWorkerFirst: ["/api/*", "/ws", "/oauth/*", "/.well-known/*", "/mcp", "/mcp/*", "/_t3flare/*"],
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    });
    return { url: environment.url };
  }),
);
