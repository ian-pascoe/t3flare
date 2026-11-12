// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
// The environment Worker (ADR-0014): the front door, the Environment DO and the stock t3 web client as static
// assets, plus the Access application that guards the admin routes. Deployed by scripts/stage.ts, which
// builds first and supplies the stage's secrets:
//
//   node scripts/stage.ts deploy <stage>      (build, web client, alchemy deploy)
//   node scripts/stage.ts destroy <stage>
//
// The Worker is prebuilt by build.ts and uploaded with `bundle: false` (ADR-0020): alchemy 2.0.0-beta.85 drops
// `build.input.plugins` on every update after the first deploy.
//
// A stage may also have a custom domain (`T3FLARE_DOMAIN`, a hostname in a Cloudflare zone of the account; prod's is
// `t3.ianpascoe.dev`, from the GitHub environment `prod` in CI and the laptop's environment otherwise). When set, it is
// attached as a Workers Custom Domain and becomes the stage's only host: its workers.dev URL and preview URLs are
// turned off, so the domain's rate limit (below) cannot be sidestepped. A stage without a domain is served at workers.dev.
//
// Access (ADR-0010): `/ws`, `/mcp` and t3's auth routes are public (stock clients cannot pass Access); only
// `<host>/_t3flare` (and below) has an Access application, admitting the owner by email and the stage's own service
// token (for the acceptance test and the bump job). The Worker verifies the assertion itself against the application's
// `aud` (src/access.ts), and also requires the admin token.
//
// A stage with a domain also rate-limits t3's credential-presenting auth routes on that host (ADR-0010), as the
// `http_ratelimit` phase of the domain's zone: see `AUTH_RATE_LIMIT` below.
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

import { MCP_WORKER_COMPATIBILITY } from "../mcp-worker/src/engine/compatibility.ts";

import { COMPATIBILITY } from "./build.ts";
import { credentialsFile } from "./stage-files.ts";

const here = import.meta.dirname;

/** The Access team (`<team>.cloudflareaccess.com`) of the owner's account, and the one person it admits. */
const ACCESS_TEAM_DOMAIN = "spirit-led-software.cloudflareaccess.com";
const OWNER_EMAIL = "ian.g.pascoe@gmail.com";
/** The account's workers.dev subdomain: the Worker's host has to be known to name the Access destination. */
const WORKERS_DEV_SUBDOMAIN = "ian-g-pascoe";

/**
 * The routes of t3's server (t3code, pinned) that take a credential from a caller who has no session yet, and so are
 * what a guesser or a flood would hit. All are POSTs:
 *
 *   /oauth/token               bootstrap token exchange: pairing a desktop/mobile client, bearer or DPoP-bound
 *                              (packages/contracts/src/environmentHttp.ts:577, apps/server/src/auth/http.ts:355)
 *   /api/auth/browser-session  bootstrap token -> session cookie: pairing the web client
 *                              (environmentHttp.ts:570, auth/http.ts:300)
 *   /oauth/mcp/register        MCP OAuth dynamic client registration (environmentHttp.ts:648, auth/mcpOAuthHttp.ts:103)
 *   /oauth/mcp/approval        MCP OAuth consent: the owner's session approves a client (environmentHttp.ts:656,
 *                              mcpOAuthHttp.ts:149)
 *   /oauth/mcp/decision        MCP OAuth consent decision (environmentHttp.ts:665, mcpOAuthHttp.ts:174)
 *   /oauth/mcp/token           MCP OAuth authorization code -> token (environmentHttp.ts:674, mcpOAuthHttp.ts:187)
 *
 * Not limited, because a paired client calls them on every (re)connect and they need its session anyway:
 * GET /api/auth/session, POST /api/auth/websocket-ticket[/:use] (environmentHttp.ts:563, 585, 592), `/ws` and `/mcp`.
 * Guest links (/api/guest/redeem) are not mounted here (src/t3/composition.ts). t3 has no refresh grant: a client's
 * session lasts 30 days (apps/server/src/auth/SessionStore.ts:428) and an MCP client's 30 days
 * (apps/server/src/auth/EnvironmentAuth.ts:79), so these routes see a request only when something pairs or signs in.
 */
const AUTH_PATHS = ["/oauth/token", "/api/auth/browser-session", "/oauth/mcp/register", "/oauth/mcp/approval", "/oauth/mcp/decision", "/oauth/mcp/token"];

/**
 * 10 such requests per 10 s from one IP (per Cloudflare data center), then 429 for 10 s. The zone (`ianpascoe.dev`) is
 * on the Free plan, which allows one rate limiting rule, a 10 s period and a 10 s block, counted by IP. Normal use
 * peaks well below: pairing is 1 request per client (desktop and web paired at once from one network: 2), an MCP
 * client's sign-in 3 to 4 (register, approval, decision, token), so even all of those at once from one network (6)
 * stays under 10, and a blocked caller waits only 10 s.
 * A guesser is held to 1 request a second per IP against 256-bit bootstrap tokens; the limit is there to keep floods
 * off the Environment DO, which every auth request wakes.
 */
const AUTH_RATE_LIMIT = { requestsPerPeriod: 10, period: 10, mitigationTimeout: 10 };

export default Alchemy.Stack(
  "t3flare",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const name = `t3flare-environment-${stage}`;
    const agentsName = `t3flare-agents-${stage}`;
    const codemodeName = `t3flare-codemode-${stage}`;
    const mcpName = `t3flare-mcp-${stage}`;
    const fixtureName = `t3flare-mcpfixture-${stage}`;
    // Test stages: the tools step's fixture MCP server, when the stage has its bearer (scripts/stage.ts).
    const fixtureBearer = stage === "prod" ? "" : yield* Config.String("T3FLARE_FIXTURE_BEARER").pipe(Config.withDefault(""));
    const workersDevHost = `${name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
    // The stage's custom domain, if it has one (unset or empty: workers.dev only).
    const domain = yield* Config.String("T3FLARE_DOMAIN").pipe(Config.withDefault(""));
    const host = domain === "" ? workersDevHost : domain;
    const teamDomain = yield* Config.String("T3FLARE_ACCESS_TEAM_DOMAIN").pipe(Config.withDefault(ACCESS_TEAM_DOMAIN));
    const ownerEmail = yield* Config.String("T3FLARE_OWNER_EMAIL").pipe(Config.withDefault(OWNER_EMAIL));
    // A shorter idle delay for test stages (ADR-0003's default is 60 s).
    const idleAfterMs = yield* Config.String("T3FLARE_IDLE_AFTER_MS").pipe(Config.withDefault(""));
    // Prod's sweep purges only when the owner sets it (the `prod` GitHub environment variable, SPI-974).
    const sweepPurge = (yield* Config.String("T3FLARE_SWEEP_PURGE").pipe(Config.withDefault(""))) === "1";
    // The first pass of a deploy to a new stage: no Durable Object bindings across the two Workers (scripts/stage.ts).
    const bootstrapPass = (yield* Config.String("T3FLARE_DEPLOY_BOOTSTRAP").pipe(Config.withDefault(""))) === "1";
    // The turn deadline (2 h) shortened on a stage for its check (step 2a M5): unset in normal deploys.
    const turnDeadlineMs = yield* Config.String("T3FLARE_TURN_DEADLINE_MS").pipe(Config.withDefault(""));
    // The terminal hold (30 min) and the sweep's grace (7 days) shortened on a stage for their checks (step 2b).
    const terminalIdleMs = yield* Config.String("T3FLARE_TERMINAL_IDLE_MS").pipe(Config.withDefault(""));
    const terminalPromptIdleMs = yield* Config.String("T3FLARE_TERMINAL_PROMPT_IDLE_MS").pipe(Config.withDefault(""));
    const sweepGraceMs = yield* Config.String("T3FLARE_SWEEP_GRACE_MS").pipe(Config.withDefault(""));
    // A test stage's way to replace the codemode sandbox's code (its objects reset), for the sandbox-loss probe (M0 P14).
    const sandboxGeneration = yield* Config.String("T3FLARE_SANDBOX_GEN").pipe(Config.withDefault(""));

    const serviceToken = yield* Cloudflare.Access.ServiceToken("AdminServiceToken", {
      name: `${name}-admin`,
      duration: "8760h",
    });
    const admin = yield* Cloudflare.Access.Application("AdminAccess", {
      name: `${name} admin`,
      type: "self_hosted",
      // `domain` too: Cloudflare keeps the application's primary domain unless it is given, and refuses one that is not
      // among the destinations (prod's was its workers.dev host).
      domain: `${host}/_t3flare`,
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
    // Step 4a (ADR-0016, A′): the CLI agents' own proxy key, answered by the Workspace DO's key route only while a CLI
    // process lives there. Never the Workers' MODEL_PROXY_API_KEY; bound to the agents Worker alone.
    const containerModelKey = Config.Redacted("COMMISSARY_CONTAINER_API_KEY");

    const workspaceContainer = Cloudflare.Container("WorkspaceContainer", {
      schedulingPolicy: "durable_object",
      context: sandboxImageContext,
    } as never);

    // Code mode's sandbox (ADR-0027): pi-codemode's QuickJS Durable Object, one object per Session, in a Worker of its own
    // so a computing script holds this isolate's thread rather than the Session's. Bundled by alchemy (ADR-0020's
    // refinement: a wasm module, nothing of t3). No URL; only the agents Worker's binding reaches it.
    yield* Cloudflare.Worker("CodemodeSandbox", {
      name: codemodeName,
      main: path.join(here, "../codemode-sandbox/src/worker.ts"),
      compatibility: COMPATIBILITY,
      workersDev: { enabled: false, previewsEnabled: false },
      env: {
        CODEMODE_SANDBOX: Cloudflare.DurableObject("CodemodeSandbox", { className: "CodemodeSandbox" }),
        ...(sandboxGeneration === "" || stage === "prod" ? {} : { T3FLARE_SANDBOX_GEN: sandboxGeneration }),
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    } as never);

    // The MCP Worker (ADR-0028; cloudpid's ADR-0038): the MCP SDK's engine, kept out of the agents and Environment
    // isolates. No bindings (review M3), `global_fetch_strictly_public` (review M5), no URL: only the Environment's
    // `MCP_ENGINE` binding reaches it. Bundled by alchemy (ADR-0020's refinement: nothing of t3).
    const mcpWorker = yield* Cloudflare.Worker("McpWorker", {
      name: mcpName,
      main: path.join(here, "../mcp-worker/src/worker.ts"),
      compatibility: { date: MCP_WORKER_COMPATIBILITY.date, flags: [...MCP_WORKER_COMPATIBILITY.flags] },
      workersDev: { enabled: false, previewsEnabled: false },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    } as never);

    if (fixtureBearer !== "") {
      yield* Cloudflare.Worker("McpFixture", {
        name: fixtureName,
        main: path.join(here, "scripts/tools/fixtureMcp.ts"),
        compatibility: COMPATIBILITY,
        workersDev: { enabled: true, previewsEnabled: false },
        env: {
          FIXTURE_BEARER: Config.Redacted("T3FLARE_FIXTURE_BEARER"),
          LOG: Cloudflare.DurableObject("FixtureLog", { className: "FixtureLog" }),
        },
      } as never);
    }

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
        ...(bootstrapPass
          ? {}
          : {
              ENVIRONMENT: Cloudflare.DurableObject("EnvironmentDO", { className: "EnvironmentDO", scriptName: name }),
              CODEMODE_SANDBOX: Cloudflare.DurableObject("CodemodeSandbox", { className: "CodemodeSandbox", scriptName: codemodeName }),
            }),
        LOADER: Cloudflare.WorkerLoader(),
        MODEL_PROXY_URL: modelProxyUrl,
        MODEL_PROXY_API_KEY: modelProxyKey,
        COMMISSARY_CONTAINER_API_KEY: containerModelKey,
        // The model proxy fault route (step 2a part 2) answers on test stages only.
        ...(stage === "prod" ? {} : { T3FLARE_FAULTS: "1" }),
        ...(turnDeadlineMs === "" ? {} : { T3FLARE_TURN_DEADLINE_MS: turnDeadlineMs }),
        ...(terminalIdleMs === "" ? {} : { T3FLARE_TERMINAL_IDLE_MS: terminalIdleMs }),
        ...(terminalPromptIdleMs === "" ? {} : { T3FLARE_TERMINAL_PROMPT_IDLE_MS: terminalPromptIdleMs }),
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    } as never);

    const environment = yield* Cloudflare.Worker("Environment", {
      name,
      main: path.join(here, "dist/worker/worker.js"),
      bundle: false,
      compatibility: COMPATIBILITY,
      // Cloudflare defers a Durable Object's code update by up to five minutes while it is active (an open client socket),
      // so a deploy would otherwise leave the Environment on its old code, and a check made right after it would see the
      // old build. The Environment adopts new code at once, as a restart does (ADR-0004): clients reconnect, and running
      // turns continue from their Sessions. The agents Worker keeps the default: its Sessions finish in-flight work first.
      codeUpdateStrategy: { mode: "immediate" },
      // A stage with a domain is served there only (no workers.dev URL, no version preview URLs).
      ...(domain === "" ? {} : { domain, workersDev: false }),
      env: {
        ENVIRONMENT: Cloudflare.DurableObject("EnvironmentDO", { className: "EnvironmentDO" }),
        T3_BOOTSTRAP_TOKEN: Config.Redacted("T3_BOOTSTRAP_TOKEN"),
        T3FLARE_ADMIN_TOKEN: Config.Redacted("T3FLARE_ADMIN_TOKEN"),
        T3FLARE_ACCESS_TEAM_DOMAIN: teamDomain,
        T3FLARE_ACCESS_AUD: admin.aud,
        // The t3 host as deployed (ADR-0026): what the panel's `Origin` must name, the OAuth redirect's host, and the
        // `/mcp` a CLI is given (never taken from a request).
        T3FLARE_HOST: host,
        T3FLARE_OWNER_EMAIL: ownerEmail,
        T3FLARE_ACCESS_SERVICE_CLIENT_ID: serviceToken.clientId,
        MCP_ENGINE: Cloudflare.WorkerEntrypoint(mcpWorker as never, "McpEngine"),
        MCP_OAUTH: Cloudflare.WorkerEntrypoint(mcpWorker as never, "McpOAuth"),
        ...(bootstrapPass
          ? {}
          : {
              SESSIONS: Cloudflare.DurableObject("SessionDO", { className: "SessionDO", scriptName: agentsName }),
              WORKSPACES: Cloudflare.DurableObject("WorkspaceDO", { className: "WorkspaceDO", scriptName: agentsName }),
              CONTAINER_BUDGET: Cloudflare.DurableObject("ContainerBudget", { className: "ContainerBudget", scriptName: agentsName }),
            }),
        T3FLARE_GITHUB_APP_ID: Config.String("T3FLARE_GITHUB_APP_ID"),
        T3FLARE_GITHUB_APP_PRIVATE_KEY: Config.Redacted("T3FLARE_GITHUB_APP_PRIVATE_KEY"),
        MODEL_PROXY_URL: modelProxyUrl,
        MODEL_PROXY_API_KEY: modelProxyKey,
        ...(idleAfterMs === "" ? {} : { T3FLARE_IDLE_AFTER_MS: idleAfterMs }),
        // Step 2b (review F3): the Workspace sweep purges on test stages; prod's reports what it would do until the owner
        // sets T3FLARE_SWEEP_PURGE=1 for it (the `prod` environment's variable, passed by deploy-prod.yml; on 2026-11-12, SPI-974).
        ...(stage === "prod" && !sweepPurge ? {} : { T3FLARE_SWEEP_PURGE: "1" }),
        // Step 3+ (ADR-0025): test stages keep the T3 Connect account token and let the service token run the Connect
        // routes; prod discards the token after the link and admits only the owner's own identity there.
        ...(stage === "prod" ? {} : { T3FLARE_CONNECT_KEEP_ACCOUNT_TOKEN: "1", T3FLARE_CONNECT_SERVICE_TOKEN: "1" }),
        // Step 4a: the process channel's probe program and stage-only checks answer on test stages only.
        ...(stage === "prod" ? {} : { T3FLARE_FAULTS: "1" }),
        ...(sweepGraceMs === "" ? {} : { T3FLARE_SWEEP_GRACE_MS: sweepGraceMs }),
      },
      assets: {
        directory: path.join(here, "dist/web"),
        notFoundHandling: "single-page-application",
        // t3's server paths (DEV_PROXIED_PATH_PREFIXES) reach the Worker before the assets.
        // `/t3flare/oauth/*`: the direct MCP servers' OAuth callback and client document (public; ADR-0026, ADR-0010).
        runWorkerFirst: ["/api/*", "/ws", "/oauth/*", "/.well-known/*", "/mcp", "/mcp/*", "/_t3flare", "/_t3flare/*", "/t3flare/oauth/*"],
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    });

    if (domain !== "") {
      // Owns the zone's whole http_ratelimit entrypoint (one per zone; the Free plan allows one rule in it), so only one
      // stage may have a domain in a given zone.
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const zoneId = yield* Cloudflare.Zone.resolveZoneId({ accountId, zone: undefined, hostname: domain }).pipe(Effect.orDie);
      yield* Cloudflare.Ruleset.Ruleset("AuthRateLimit", {
        zone: { zoneId } as never,
        phase: "http_ratelimit",
        name: "t3flare auth rate limit",
        description: `t3's auth routes on ${domain} (apps/environment/alchemy.run.ts)`,
        rules: [
          {
            ref: `t3flare-auth-${stage}`,
            description: `t3flare ${stage}: t3's auth routes on ${domain}`,
            expression: `(http.host eq "${domain}" and http.request.method eq "POST" and http.request.uri.path in {${AUTH_PATHS.map((p) => `"${p}"`).join(" ")}})`,
            action: "block",
            ratelimit: { characteristics: ["cf.colo.id", "ip.src"], ...AUTH_RATE_LIMIT },
          },
        ],
      });
    }

    // The stage's service-token credentials and URL (its custom domain when it has one), for the stage scripts; never
    // printed.
    const credentials = Output.map(
      Output.all(serviceToken.clientId, serviceToken.clientSecret, environment.url),
      ([clientId, clientSecret]) => {
        const url = `https://${host}`;
        const file = credentialsFile(stage);
        if (clientSecret !== undefined) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(
            file,
            JSON.stringify({ url, clientId, clientSecret: Redacted.value(clientSecret as Redacted.Redacted<string>) }),
            { mode: 0o600 },
          );
        }
        return path.relative(here, file);
      },
    );
    return { url: environment.url, host, accessAud: admin.aud, credentials, agents: agents.workerName };
  }),
);
