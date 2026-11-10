// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
// The environment Worker (ADR-0014): the front door, the Environment DO and the stock t3 web client as static
// assets, plus the Access application that guards the admin routes. Deployed by scripts/stage.ts, which
// builds first and supplies the stage's secrets:
//
//   bun scripts/stage.ts deploy <stage>      (build, web client, alchemy deploy)
//   bun scripts/stage.ts destroy <stage>
//
// The Worker is prebuilt by build.ts and uploaded with `bundle: false` (ADR-0020): alchemy 2.0.0-beta.85 drops
// `build.input.plugins` on every update after the first deploy.
//
// Access (ADR-0010): `/ws`, `/mcp` and t3's auth routes are public (stock clients cannot pass Access); only
// `<host>/_t3flare` (and below) has an Access application, admitting the owner by email and the stage's own
// service token (for the acceptance test and the bump job). The Worker verifies the assertion itself against
// the application's `aud` (src/access.ts), and also requires the admin token.
//
// The agents Worker (ADR-0014, step 2a) deploys in the same stack: its Session DOs, Workspace DOs with their Container
// (the image in apps/sandbox-image, built here with Docker), and the Container budget. It has no public URL. The two
// Workers bind each other's Durable Objects by script name, so their names are fixed per stage.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxImageContext } from "@t3flare/sandbox-image";

import { COMPATIBILITY } from "./build.ts";
import { credentialsFile } from "./stage-files.ts";

const here = import.meta.dirname;

/** The Access team (`<team>.cloudflareaccess.com`) of the owner's account, and the one person it admits. */
const ACCESS_TEAM_DOMAIN = "spirit-led-software.cloudflareaccess.com";
const OWNER_EMAIL = "ian.g.pascoe@gmail.com";
/** The account's workers.dev subdomain: the Worker's host has to be known to name the Access destination. */
const WORKERS_DEV_SUBDOMAIN = "ian-g-pascoe";


export default Alchemy.Stack(
  "t3flare",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const name = `t3flare-environment-${stage}`;
    const agentsName = `t3flare-agents-${stage}`;
    const host = `${name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
    const teamDomain = yield* Config.String("T3FLARE_ACCESS_TEAM_DOMAIN").pipe(Config.withDefault(ACCESS_TEAM_DOMAIN));
    const ownerEmail = yield* Config.String("T3FLARE_OWNER_EMAIL").pipe(Config.withDefault(OWNER_EMAIL));
    // A shorter idle delay for test stages (ADR-0003's default is 60 s).
    const idleAfterMs = yield* Config.String("T3FLARE_IDLE_AFTER_MS").pipe(Config.withDefault(""));

    const serviceToken = yield* Cloudflare.Access.ServiceToken("AdminServiceToken", {
      name: `${name}-admin`,
      duration: "8760h",
    });
    const admin = yield* Cloudflare.Access.Application("AdminAccess", {
      name: `${name} admin`,
      type: "self_hosted",
      destinations: [{ type: "public", uri: `${host}/_t3flare` }],
      sessionDuration: "24h",
      appLauncherVisible: false,
      policies: [
        { name: "owner", decision: "allow", include: [{ email: ownerEmail }] },
        { name: "stage service token", decision: "non_identity", include: [{ serviceToken: serviceToken.serviceTokenId }] },
      ],
    } as never);

    // The model proxy (ADR-0012) and the GitHub App (ADR-0013), from ~/.config/t3flare/dev.env or CI's environment.
    const modelProxyUrl = yield* Config.String("MODEL_PROXY_URL");
    const modelProxyKey = Config.Redacted("MODEL_PROXY_API_KEY");

    const workspaceContainer = yield* Cloudflare.Container("WorkspaceContainer", {
      schedulingPolicy: "durable_object",
      context: sandboxImageContext,
    } as never);

    const agents = yield* Cloudflare.Worker("Agents", {
      name: agentsName,
      main: path.join(here, "../agents/dist/worker/worker.js"),
      bundle: false,
      compatibility: COMPATIBILITY,
      workersDev: { enabled: false, previewsEnabled: false },
      env: {
        SESSIONS: Cloudflare.DurableObject("SessionDO", { className: "SessionDO" }),
        WORKSPACES: Cloudflare.DurableObject("WorkspaceDO", { className: "WorkspaceDO", containers: [workspaceContainer] } as never),
        CONTAINER_BUDGET: Cloudflare.DurableObject("ContainerBudget", { className: "ContainerBudget" }),
        ENVIRONMENT: Cloudflare.DurableObject("EnvironmentDO", { className: "EnvironmentDO", scriptName: name }),
        LOADER: Cloudflare.WorkerLoader(),
        MODEL_PROXY_URL: modelProxyUrl,
        MODEL_PROXY_API_KEY: modelProxyKey,
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    } as never);

    const environment = yield* Cloudflare.Worker("Environment", {
      name,
      main: path.join(here, "dist/worker/worker.js"),
      bundle: false,
      compatibility: COMPATIBILITY,
      env: {
        ENVIRONMENT: Cloudflare.DurableObject("EnvironmentDO", { className: "EnvironmentDO" }),
        T3_BOOTSTRAP_TOKEN: Config.Redacted("T3_BOOTSTRAP_TOKEN"),
        T3FLARE_ADMIN_TOKEN: Config.Redacted("T3FLARE_ADMIN_TOKEN"),
        T3FLARE_ACCESS_TEAM_DOMAIN: teamDomain,
        T3FLARE_ACCESS_AUD: admin.aud,
        T3FLARE_OWNER_EMAIL: ownerEmail,
        T3FLARE_ACCESS_SERVICE_CLIENT_ID: serviceToken.clientId,
        SESSIONS: Cloudflare.DurableObject("SessionDO", { className: "SessionDO", scriptName: agentsName }),
        WORKSPACES: Cloudflare.DurableObject("WorkspaceDO", { className: "WorkspaceDO", scriptName: agentsName }),
        CONTAINER_BUDGET: Cloudflare.DurableObject("ContainerBudget", { className: "ContainerBudget", scriptName: agentsName }),
        T3FLARE_GITHUB_APP_ID: Config.String("T3FLARE_GITHUB_APP_ID"),
        T3FLARE_GITHUB_APP_PRIVATE_KEY: Config.Redacted("T3FLARE_GITHUB_APP_PRIVATE_KEY"),
        MODEL_PROXY_URL: modelProxyUrl,
        MODEL_PROXY_API_KEY: modelProxyKey,
        ...(idleAfterMs === "" ? {} : { T3FLARE_IDLE_AFTER_MS: idleAfterMs }),
      },
      assets: {
        directory: path.join(here, "dist/web"),
        notFoundHandling: "single-page-application",
        // t3's server paths (DEV_PROXIED_PATH_PREFIXES) reach the Worker before the assets.
        runWorkerFirst: ["/api/*", "/ws", "/oauth/*", "/.well-known/*", "/mcp", "/mcp/*", "/_t3flare", "/_t3flare/*"],
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    });

    // The stage's service-token credentials, for scripts/acceptance.ts; never printed.
    const credentials = Output.map(
      Output.all(serviceToken.clientId, serviceToken.clientSecret, environment.url),
      ([clientId, clientSecret, url]) => {
        const file = credentialsFile(stage);
        if (clientSecret !== undefined) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ url, clientId, clientSecret: Redacted.value(clientSecret as Redacted.Redacted<string>) }), { mode: 0o600 });
        }
        return path.relative(here, file);
      },
    );
    return { url: environment.url, host, accessAud: admin.aud, credentials, agents: agents.workerName };
  }),
);
