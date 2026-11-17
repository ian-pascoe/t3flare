// What `stage.ts deploy` binds and sets up, decided before anything is built (SPI-1175), pure so it is tested
// (deployPlan.test.ts): the deploy-wide settings it needs, prod's custom domain (prod's alone), and the stage's Model
// endpoint. No model setting is bound: the Model proxy's (MODEL_PROXY_*, and COMMISSARY_* for the CLI agents' key and
// the Usage page) went at the hard cut (SPI-1176).
import { MODEL_ENDPOINT_VAR, type ModelEndpointSpecResult, stageEndpointSpec } from "./modelEndpointSpec.ts";

/** Required on every deploy: the GitHub App. */
export const DEPLOY_SECRETS = ["T3FLARE_GITHUB_APP_ID", "T3FLARE_GITHUB_APP_PRIVATE_KEY"] as const;

/** Every deploy-wide setting `stage.ts` reads, then `extra` (such as T3FLARE_MODEL_ENDPOINT). */
export const allDeploySettings = (extra: ReadonlyArray<string> = []): ReadonlyArray<string> => [...DEPLOY_SECRETS, ...extra];

/**
 * The names to read from ~/.config/t3flare/dev.env, given the settings the environment has (shell variables win):
 *
 * | The environment has                              | Read from dev.env              |
 * | ------------------------------------------------ | ------------------------------ |
 * | not every required setting                       | every setting (`allDeploySettings(extra)`) |
 * | every required setting, not all of `extra`       | the `extra` names it lacks     |
 * | every required setting, and all of `extra`       | nothing                        |
 *
 * The middle row keeps CI's settings as they are while a laptop's T3FLARE_MODEL_ENDPOINT still comes from dev.env.
 */
export const devEnvNames = (fromEnv: Readonly<Record<string, string>>, extra: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hasCore = DEPLOY_SECRETS.every((name) => fromEnv[name] !== undefined);
  if (!hasCore) return allDeploySettings(extra);
  return extra.filter((name) => fromEnv[name] === undefined);
};

export type DeployPlan =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      /** What alchemy gets: the deploy-wide settings read (never the Model endpoint's, which the panel's API takes). */
      readonly alchemyEnv: Readonly<Record<string, string>>;
      readonly endpoint: ModelEndpointSpecResult;
      readonly notes: ReadonlyArray<string>;
    };

/**
 * The deploy of `stage` with `args`, from the settings `read` (environment over dev.env, `T3FLARE_MODEL_ENDPOINT`
 * included) in an environment `env` (`T3FLARE_DOMAIN`: prod's custom domain, which alchemy reads from the environment).
 */
export const deployPlan = (input: {
  readonly stage: string;
  readonly args: ReadonlyArray<string>;
  readonly read: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DeployPlan => {
  const { stage, args, read, env } = input;
  const endpoint = stageEndpointSpec(read);
  if (!endpoint.ok && endpoint.invalid) return { ok: false, error: endpoint.reason };
  // Only prod has a custom domain (README, "custom domain"). A throwaway stage deployed with one claims prod's host: its
  // Access application (found by domain) and the zone's rate-limit ruleset (owned whole by the stage that has the
  // domain). An environment that carries prod's T3FLARE_DOMAIN (a sourced dev.env) is refused, not stripped.
  const domain = env.T3FLARE_DOMAIN ?? "";
  if (stage !== "prod" && domain !== "") return { ok: false, error: `T3FLARE_DOMAIN is set (to ${domain}) for the stage ${stage}: only prod has a custom domain; unset it (was dev.env sourced into the shell?)` };
  if (args.includes("--no-model-proxy")) return { ok: false, error: "--no-model-proxy is gone: there is no Model proxy since the hard cut (SPI-1176); deploy without it" };
  const secrets = Object.fromEntries(Object.entries(read).filter(([name]) => name !== MODEL_ENDPOINT_VAR));
  const missing = DEPLOY_SECRETS.filter((name) => secrets[name] === undefined);
  if (missing.length > 0) return { ok: false, error: `missing ${missing.join(", ")} (set them, or put them in ~/.config/t3flare/dev.env)` };
  return { ok: true, alchemyEnv: secrets, endpoint, notes: [] };
};
