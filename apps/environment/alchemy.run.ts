// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
// The environment Worker (ADR-0014) for the step 0 spike: the front door, the
// Environment DO and the stock t3 web client as static assets.
//
//   T3_BOOTSTRAP_TOKEN=… T3FLARE_ADMIN_TOKEN=… bun alchemy deploy --stage spike
//
// The web client must be built first (`bun run prepare:web` copies t3's apps/web build to
// dist/web). The Worker is bundled by alchemy with build.ts's options, including the
// import-scoped `node:fs` alias plugin (ADR-0007).
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import { COMPATIBILITY, workerBuild } from "./build.ts";

const here = import.meta.dirname;

export default Alchemy.Stack(
  "t3flare",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const environment = yield* Cloudflare.Worker("Environment", {
      main: path.join(here, "src/worker.ts"),
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
      build: workerBuild,
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    });
    return { url: environment.url };
  }),
);
