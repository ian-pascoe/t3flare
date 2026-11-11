// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
/**
 * CI credentials as code (ADR-0017): the GitHub Actions environment `bump`, a scoped Cloudflare API token for it, and
 * the secret and variable that hand them to .github/workflows/bump.yml; and the environment `prod` (deployable from
 * `main` only) with its own token and everything .github/workflows/deploy-prod.yml deploys prod with. Deployed once from a workstation with the
 * `admin` alchemy profile (a Cloudflare key that may create API tokens, and `gh`), and again to rotate the token or
 * change its permissions:
 *
 *   bun run --cwd infra ci:setup
 *
 * `ci:setup` also allows GitHub Actions to create pull requests on the repository (the job proposes each new pin as
 * `bump/<tag>`), which no alchemy resource covers.
 *
 Read from the environment (never committed; `ci:setup` exports ~/.config/t3flare/dev.env first):
 *
 *   GITHUB_REPOSITORY  owner/name (default: ian-pascoe/t3flare)
 *   MODEL_PROXY_URL, MODEL_PROXY_API_KEY, T3FLARE_GITHUB_APP_ID, T3FLARE_GITHUB_APP_PRIVATE_KEY   (required)
 *   T3FLARE_PROD_ENV_FILE  prod's bootstrap and admin tokens, the laptop's (default:
 *                      ../apps/environment/.alchemy/stages/prod.env.json; set it when running from a worktree)
 *
 * Run ci:setup again after rotating any of those (prod's tokens, the proxy key, the GitHub App's key).
 *
 * Rotate the token: `bun run --cwd infra ci:destroy`, then `ci:setup` again. The `bump` environment is retained on
 * destroy, so anything set on it by hand survives.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as fs from "node:fs";
import * as path from "node:path";

/** Account-scoped "Access: Apps and Policies Write" (the catalog name is shared with a zone-scoped group). */
const ACCESS_APPS_AND_POLICIES_WRITE = { id: "1e13c5124ca64b72b1969a67e8829049" };
/** "Access: Service Tokens Write": each stage declares its admin service token (ADR-0010), and "Apps and Policies
 * Write" does not cover `POST /access/service_tokens`. */
const ACCESS_SERVICE_TOKENS_WRITE = { id: "a1c0fec57cf94af79479a6d827fa518c" };

/**
 * Everything a stage deploy touches (apps/environment/alchemy.run.ts): the Workers and their workers.dev subdomain,
 * alchemy's state store (Secrets Store Write: it binds its token secret to a short-lived Worker on every run), and the
 * admin path's Access application, policies and service token. Workers Containers Write (step 2a): the Workspace DO's
 * Container application and the push of its image to Cloudflare's registry.
 */
const STAGE_DEPLOY_PERMISSIONS = [
  "Workers Scripts Write",
  "Workers Containers Write",
  "Secrets Store Write",
  "Account Settings Read",
  ACCESS_APPS_AND_POLICIES_WRITE,
  ACCESS_SERVICE_TOKENS_WRITE,
] as const;

/**
 * prod's custom domain (apps/environment/alchemy.run.ts reads it as T3FLARE_DOMAIN), and the zone it is in. Attaching a
 * Workers Custom Domain needs zone permissions the other stages do not: Zone Read (alchemy looks the zone up by name)
 * and Workers Routes Write ("Worker domains and routes"), on this zone only, for the prod token only. Zone WAF Write:
 * the rate limit on t3's auth routes (the zone's `http_ratelimit` phase, ADR-0010).
 */
const PROD_DOMAIN = "t3.ianpascoe.dev";
const PROD_DOMAIN_ZONE_ID = "c36c6e2b6bda856f9d4f6175059c6df4"; // ianpascoe.dev

/** prod's bootstrap and admin tokens from the laptop's stage file (apps/environment/stage-files.ts), never printed. */
const readStageTokens = (file: string) => {
  const tokens = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string | undefined>;
  return (name: string) => {
    const value = tokens[name];
    if (!value) throw new Error(`${file} has no ${name}`);
    return Redacted.make(value);
  };
};

export default Alchemy.Stack(
  "t3flare-github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const [owner = "", repository = ""] = (yield* Config.String("GITHUB_REPOSITORY").pipe(
      Config.withDefault("ian-pascoe/t3flare"),
    )).split("/");
    const repo = { owner, repository };

    // Retained on destroy: deleting a GitHub environment also deletes whatever was set on it by hand.
    const bump = yield* GitHub.Environment("Bump", { ...repo, name: "bump" }).pipe(
      Alchemy.RemovalPolicy.retain(),
    );

    // Everything `bun run bump` deploys and destroys on the `bump` stage.
    const token = yield* Cloudflare.ApiToken.AccountApiToken("BumpToken", {
      name: "t3flare-ci-bump",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [...STAGE_DEPLOY_PERMISSIONS],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    yield* GitHub.Secret("CloudflareApiToken", {
      ...repo,
      environment: bump,
      name: "CLOUDFLARE_API_TOKEN",
      value: token.value,
    });

    yield* GitHub.Variable("CloudflareAccountId", {
      ...repo,
      environment: bump,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    });

    // The model proxy's base URL for the bump stage's real turn (step 2a); its key, MODEL_PROXY_API_KEY, is a secret
    // set on the environment by hand. Read from ~/.config/t3flare/dev.env when ci:setup runs.
    const modelProxyUrl = yield* Config.String("MODEL_PROXY_URL");
    yield* GitHub.Variable("ModelProxyUrl", {
      ...repo,
      environment: bump,
      name: "MODEL_PROXY_URL",
      value: modelProxyUrl,
    });

    // prod (deploy-prod.yml): deployable from main only, retained on destroy like `bump`. Its own token, with the same
    // permissions (a prod deploy touches the same kinds of resource; Cloudflare cannot scope these groups to a stage),
    // plus its custom domain's zone permissions.
    const prod = yield* GitHub.Environment("Prod", {
      ...repo,
      name: "prod",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    }).pipe(Alchemy.RemovalPolicy.retain());
    const prodToken = yield* Cloudflare.ApiToken.AccountApiToken("ProdToken", {
      name: "t3flare-ci-prod",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [...STAGE_DEPLOY_PERMISSIONS],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["Zone Read", "Workers Routes Write", "Zone WAF Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: { [`com.cloudflare.api.account.zone.${PROD_DOMAIN_ZONE_ID}`]: "*" },
          },
        },
      ],
    });

    // prod's bootstrap and admin tokens are the laptop's: new ones would lock the owner's clients out.
    const prodEnvFile = yield* Config.String("T3FLARE_PROD_ENV_FILE").pipe(
      Config.withDefault(path.join(import.meta.dirname, "../apps/environment/.alchemy/stages/prod.env.json")),
    );
    const fromProdEnvFile = readStageTokens(prodEnvFile);

    yield* GitHub.Secret("ProdCloudflareApiToken", {
      ...repo,
      environment: prod,
      name: "CLOUDFLARE_API_TOKEN",
      value: prodToken.value,
    });
    const prodSecrets: Record<string, Redacted.Redacted<string>> = {
      MODEL_PROXY_API_KEY: yield* Config.Redacted("MODEL_PROXY_API_KEY"),
      T3FLARE_GITHUB_APP_ID: yield* Config.Redacted("T3FLARE_GITHUB_APP_ID"),
      T3FLARE_GITHUB_APP_PRIVATE_KEY: yield* Config.Redacted("T3FLARE_GITHUB_APP_PRIVATE_KEY"),
      T3_BOOTSTRAP_TOKEN: fromProdEnvFile("T3_BOOTSTRAP_TOKEN"),
      T3FLARE_ADMIN_TOKEN: fromProdEnvFile("T3FLARE_ADMIN_TOKEN"),
    };
    for (const [name, value] of Object.entries(prodSecrets)) {
      yield* GitHub.Secret(`Prod${name}`, { ...repo, environment: prod, name, value });
    }
    yield* GitHub.Variable("ProdCloudflareAccountId", {
      ...repo,
      environment: prod,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    });
    yield* GitHub.Variable("ProdModelProxyUrl", {
      ...repo,
      environment: prod,
      name: "MODEL_PROXY_URL",
      value: modelProxyUrl,
    });
    yield* GitHub.Variable("ProdDomain", {
      ...repo,
      environment: prod,
      name: "T3FLARE_DOMAIN",
      value: PROD_DOMAIN,
    });

    return { environments: ["bump", "prod"], tokens: ["t3flare-ci-bump", "t3flare-ci-prod"] };
  }),
);
