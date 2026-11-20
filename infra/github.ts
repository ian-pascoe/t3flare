// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off nodeBuiltinImport:off
/**
 * CI credentials as code (ADR-0017): the GitHub Actions environment `bump`, a scoped Cloudflare API token for it, and
 * the secret and variable that hand them to .github/workflows/bump.yml; and the environment `prod` (deployable from
 * `main` only) with its own token and everything .github/workflows/deploy-prod.yml deploys prod with. Deployed once from a workstation with the
 * `admin` alchemy profile (a Cloudflare key that may create API tokens, and `gh`), and again to rotate the token or
 * change its permissions:
 *
 *   pnpm --filter @t3flare/infra run ci:setup
 *
 * `ci:setup` also allows GitHub Actions to create pull requests on the repository (the job proposes each new pin as
 * `bump/<tag>`), which no alchemy resource covers.
 *
 * Read from the environment (never committed; `ci:setup` exports ~/.config/t3flare/dev.env first). The Deployment
 * settings (docs/deploy.md) have no default; a missing or malformed one stops the run with its message
 * (apps/environment/scripts/lib/deploymentSettings.ts):
 *
 *   GITHUB_REPOSITORY  the Deployment repository, owner/name (required)
 *   T3FLARE_DOMAIN, T3FLARE_DOMAIN_ZONE_ID   prod's custom domain and the id of its zone (required): the variable
 *                      T3FLARE_DOMAIN on `prod`, and the zone permissions of prod's token
 *   T3FLARE_ACCESS_TEAM_DOMAIN, T3FLARE_WORKERS_DEV_SUBDOMAIN, T3FLARE_T3_TRACK   (required) repository variables of
 *                      those names (the t3 track, stable or nightly: ADR-0041)
 *   T3FLARE_OWNER_EMAIL  (required) a repository secret: Actions logs are public, and a variable prints unmasked
 *   T3FLARE_FIXTURE_REPO  (required) the variable of that name on `bump`: the fixture its acceptance test uses
 *   T3FLARE_UPDATE_REPO  (optional) the variable of that name on `prod`, prod's update target; unset, none is set (and a
 *                      run removes one an earlier run set), and prod has no in-app Update
 *   T3FLARE_GITHUB_APP_ID, T3FLARE_GITHUB_APP_PRIVATE_KEY   (required)
 *   T3FLARE_MODEL_ENDPOINT  the Model endpoints CI's stages set up through the panel's API (SPI-1175; the format is in
 *                      apps/environment/scripts/lib/modelEndpointSpec.ts): one, or a list with one per API. The bump's
 *                      acceptance needs Anthropic Messages (Claude Code) and OpenAI Responses (Codex). Set as the secret
 *                      T3FLARE_MODEL_ENDPOINT on `bump` and `prod`. Unset, neither gets it (and a run removes one an
 *                      earlier run set): CI's stages then have no model, and the bump's real turn fails.
 *
 * MODEL_PROXY_URL, MODEL_PROXY_API_KEY and COMMISSARY_CONTAINER_API_KEY are not read: a run removes them where an
 * earlier run set them (`docs/steps/spi-1176-owner-setup.md`).
 *   T3FLARE_PROD_ENV_FILE  prod's bootstrap and admin tokens, the laptop's (default:
 *                      ../apps/environment/.alchemy/stages/prod.env.json; set it when running from a worktree)
 *
 * Run ci:setup again after rotating any of those (prod's tokens, the GitHub App's key, the endpoint's key).
 *
 * Not managed here (set by hand, ADR-0037 §7; SPI-1266): the environment `land` (main only), whose one secret is
 * T3FLARE_LAND_DEPLOY_KEY, the repo's deploy key that land.yml pushes `main` with, and the ruleset bypass for it.
 *
 * Rotate the token: `pnpm --filter @t3flare/infra run ci:destroy`, then `ci:setup` again. The `bump` environment is retained on
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

import { optionalSetting, requiredSettings } from "../apps/environment/scripts/lib/deploymentSettings.ts";
import { MODEL_ENDPOINT_VAR, modelEndpointSecret, modelEndpointSpec } from "../apps/environment/scripts/lib/modelEndpointSpec.ts";

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

/** The Deployment settings this run needs (docs/deploy.md), every one required. */
const SETTINGS = [
  "GITHUB_REPOSITORY",
  "T3FLARE_DOMAIN",
  "T3FLARE_DOMAIN_ZONE_ID",
  "T3FLARE_ACCESS_TEAM_DOMAIN",
  "T3FLARE_WORKERS_DEV_SUBDOMAIN",
  "T3FLARE_T3_TRACK",
  "T3FLARE_OWNER_EMAIL",
  "T3FLARE_FIXTURE_REPO",
] as const;

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

    // Every setting is checked before anything is planned, and every problem reported at once.
    const settings = requiredSettings(process.env, SETTINGS);
    if (!settings.ok) return yield* Effect.die(new Error(settings.error));
    const updateRepo = optionalSetting(process.env, "T3FLARE_UPDATE_REPO");
    if (!updateRepo.ok) return yield* Effect.die(new Error(updateRepo.error));
    const {
      GITHUB_REPOSITORY,
      T3FLARE_DOMAIN: prodDomain,
      // The zone prod's custom domain is in (apps/environment/alchemy.run.ts reads the domain as T3FLARE_DOMAIN). Attaching
      // a Workers Custom Domain needs zone permissions the other stages do not: Zone Read (alchemy looks the zone up by
      // name) and Workers Routes Write ("Worker domains and routes"), on this zone only, for the prod token only. Zone WAF
      // Write: the rate limit on t3's auth routes (the zone's `http_ratelimit` phase, ADR-0010).
      T3FLARE_DOMAIN_ZONE_ID: prodDomainZoneId,
    } = settings.value;

    const [owner = "", repository = ""] = GITHUB_REPOSITORY.split("/");
    const repo = { owner, repository };

    // The Deployment settings every deploy needs (apps/environment/alchemy.run.ts), for every workflow: three repository
    // variables, and the Owner's email as a repository secret (a variable's value prints unmasked in the public logs).
    // The t3 track is the repository's, not an environment's: the bump's plan, the land and every deploy read it.
    yield* GitHub.Variable("AccessTeamDomain", { ...repo, name: "T3FLARE_ACCESS_TEAM_DOMAIN", value: settings.value.T3FLARE_ACCESS_TEAM_DOMAIN });
    yield* GitHub.Variable("WorkersDevSubdomain", { ...repo, name: "T3FLARE_WORKERS_DEV_SUBDOMAIN", value: settings.value.T3FLARE_WORKERS_DEV_SUBDOMAIN });
    yield* GitHub.Variable("T3Track", { ...repo, name: "T3FLARE_T3_TRACK", value: settings.value.T3FLARE_T3_TRACK });
    yield* GitHub.Secret("OwnerEmail", { ...repo, name: "T3FLARE_OWNER_EMAIL", value: Redacted.make(settings.value.T3FLARE_OWNER_EMAIL) });

    // Retained on destroy: deleting a GitHub environment also deletes whatever was set on it by hand. Deployable from
    // `main` only, like `prod`: bump.yml and cli-bump.yml run from `main`, and a run sends the whole policy, so one left
    // out here would clear the policy set on the environment.
    const bump = yield* GitHub.Environment("Bump", {
      ...repo,
      name: "bump",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    }).pipe(
      Alchemy.RemovalPolicy.retain(),
    );

    // Everything `pnpm run bump` deploys and destroys on the `bump` stage.
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

    // The fixture repository the bump's acceptance test clones and pushes to.
    yield* GitHub.Variable("BumpFixtureRepo", { ...repo, environment: bump, name: "T3FLARE_FIXTURE_REPO", value: settings.value.T3FLARE_FIXTURE_REPO });

    // SPI-1175: the Model endpoints both workflows' stages set up through the panel's API, one JSON secret holding their
    // keys: dev.env's T3FLARE_MODEL_ENDPOINT (an endpoint, or a list of them). Never printed.
    const endpoint = modelEndpointSpec(process.env);
    if (!endpoint.ok && endpoint.invalid) return yield* Effect.die(new Error(endpoint.reason));
    const endpointSecret = endpoint.ok ? Redacted.make(modelEndpointSecret(endpoint.specs)) : undefined;
    if (endpointSecret === undefined) yield* Effect.logWarning(`ci:setup: no ${MODEL_ENDPOINT_VAR} secret: ${endpoint.ok ? "" : endpoint.reason}`);
    else yield* GitHub.Secret("BumpModelEndpoint", { ...repo, environment: bump, name: MODEL_ENDPOINT_VAR, value: endpointSecret });

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
            [`com.cloudflare.api.account.${accountId}`]: { [`com.cloudflare.api.account.zone.${prodDomainZoneId}`]: "*" },
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
      T3FLARE_GITHUB_APP_ID: yield* Config.Redacted("T3FLARE_GITHUB_APP_ID"),
      T3FLARE_GITHUB_APP_PRIVATE_KEY: yield* Config.Redacted("T3FLARE_GITHUB_APP_PRIVATE_KEY"),
      T3_BOOTSTRAP_TOKEN: fromProdEnvFile("T3_BOOTSTRAP_TOKEN"),
      T3FLARE_ADMIN_TOKEN: fromProdEnvFile("T3FLARE_ADMIN_TOKEN"),
      ...(endpointSecret === undefined ? {} : { [MODEL_ENDPOINT_VAR]: endpointSecret }),
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
    yield* GitHub.Variable("ProdDomain", {
      ...repo,
      environment: prod,
      name: "T3FLARE_DOMAIN",
      value: prodDomain,
    });
    // prod's update target (in-app Updates, ADR-0037), when dev.env names one; deploy-prod.yml logs whether it is set.
    if (updateRepo.value === undefined) yield* Effect.logWarning("ci:setup: no T3FLARE_UPDATE_REPO: prod gets no update target, so it has no in-app Update");
    else yield* GitHub.Variable("ProdUpdateRepo", { ...repo, environment: prod, name: "T3FLARE_UPDATE_REPO", value: updateRepo.value });

    return { environments: ["bump", "prod"], tokens: ["t3flare-ci-bump", "t3flare-ci-prod"] };
  }),
);
