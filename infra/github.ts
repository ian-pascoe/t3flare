// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off
/**
 * CI credentials as code (ADR-0017): the GitHub Actions environment `bump`, a scoped Cloudflare API token for it, and
 * the secret and variable that hand them to .github/workflows/bump.yml. Deployed once from a workstation with the
 * `admin` alchemy profile (a Cloudflare key that may create API tokens, and `gh`), and again to rotate the token or
 * change its permissions:
 *
 *   bun run --cwd infra ci:setup
 *
 * `ci:setup` also allows GitHub Actions to create pull requests on the repository (the job proposes each new pin as
 * `bump/<tag>`), which no alchemy resource covers.
 *
 * Optional, read from the environment (never committed):
 *
 *   GITHUB_REPOSITORY  owner/name (default: ian-pascoe/t3flare)
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

/** Account-scoped "Access: Apps and Policies Write" (the catalog name is shared with a zone-scoped group). */
const ACCESS_APPS_AND_POLICIES_WRITE = { id: "1e13c5124ca64b72b1969a67e8829049" };
/** "Access: Service Tokens Write": each stage declares its admin service token (ADR-0010), and "Apps and Policies
 * Write" does not cover `POST /access/service_tokens`. */
const ACCESS_SERVICE_TOKENS_WRITE = { id: "a1c0fec57cf94af79479a6d827fa518c" };

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

    // Everything `bun run bump` deploys and destroys on the `bump` stage (apps/environment/alchemy.run.ts): the
    // Worker and its workers.dev subdomain, alchemy's state store (Secrets Store Write: it binds its token secret to a
    // short-lived Worker on every run), and the admin path's Access application, policies and service token.
    // Containers join this list when a stage first declares one (step 2a).
    const token = yield* Cloudflare.ApiToken.AccountApiToken("BumpToken", {
      name: "t3flare-ci-bump",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Secrets Store Write",
            "Account Settings Read",
            ACCESS_APPS_AND_POLICIES_WRITE,
            ACCESS_SERVICE_TOKENS_WRITE,
          ],
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

    return { environments: ["bump"], token: "t3flare-ci-bump" };
  }),
);
