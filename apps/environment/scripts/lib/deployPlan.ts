// What `stage.ts deploy` binds and sets up, decided before anything is built (SPI-1175), pure so it is tested
// (deployPlan.test.ts): the deploy-wide settings it needs, the Model proxy's (optional on a throwaway stage until the hard
// cut, SPI-1176; `--no-model-proxy` drops them; prod keeps them), prod's custom domain (prod's alone), and the stage's
// Model endpoint.
import { MODEL_ENDPOINT_VAR, type ModelEndpointSpecResult, stageEndpointSpec } from "./modelEndpointSpec.ts";

/** Required on every deploy: the GitHub App, and the CLI agents' own proxy key (step 4a). */
export const DEPLOY_SECRETS = ["T3FLARE_GITHUB_APP_ID", "T3FLARE_GITHUB_APP_PRIVATE_KEY", "COMMISSARY_CONTAINER_API_KEY"] as const;
/** The Model proxy's settings (ADR-0012): required on prod, optional on a throwaway stage. */
export const MODEL_PROXY_SETTINGS = ["MODEL_PROXY_URL", "MODEL_PROXY_API_KEY"] as const;
/** Parity G8: Commissary's management API for t3's Usage page and limit meters; each optional (alchemy.run.ts). */
export const OPTIONAL_DEPLOY_SECRETS = ["COMMISSARY_MANAGEMENT_URL", "COMMISSARY_MANAGEMENT_ORG", "COMMISSARY_MANAGEMENT_KEY", "COMMISSARY_ACCESS_CLIENT_ID", "COMMISSARY_ACCESS_CLIENT_SECRET"] as const;

const isModelProxy = (name: string) => (MODEL_PROXY_SETTINGS as ReadonlyArray<string>).includes(name);

const PROD_KEEPS_THE_PROXY = "prod keeps the Model proxy until the hard cut (SPI-1176)";

/** Every deploy-wide setting `stage.ts` reads, then `extra` (such as T3FLARE_MODEL_ENDPOINT). */
export const allDeploySettings = (extra: ReadonlyArray<string> = []): ReadonlyArray<string> => [...DEPLOY_SECRETS, ...MODEL_PROXY_SETTINGS, ...OPTIONAL_DEPLOY_SECRETS, ...extra];

/**
 * The names to read from ~/.config/t3flare/dev.env, given the settings the environment has (shell variables win):
 *
 * | The environment has                                         | Read from dev.env              |
 * | ----------------------------------------------------------- | ------------------------------ |
 * | not every required and Model proxy setting                  | every setting (`allDeploySettings(extra)`) |
 * | every required and Model proxy setting, not all of `extra`  | the `extra` names it lacks     |
 * | every required and Model proxy setting, and all of `extra`  | nothing                        |
 *
 * The middle row keeps CI's settings as they are while a laptop's T3FLARE_MODEL_ENDPOINT still comes from dev.env.
 */
export const devEnvNames = (fromEnv: Readonly<Record<string, string>>, extra: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hasCore = [...DEPLOY_SECRETS, ...MODEL_PROXY_SETTINGS].every((name) => fromEnv[name] !== undefined);
  if (!hasCore) return allDeploySettings(extra);
  return extra.filter((name) => fromEnv[name] === undefined);
};

export type DeployPlan =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      /** What alchemy gets: the proxy's settings blanked when it has none, so a shell's own cannot be bound. */
      readonly alchemyEnv: Readonly<Record<string, string>>;
      readonly endpoint: ModelEndpointSpecResult;
      readonly notes: ReadonlyArray<string>;
    };

/**
 * The deploy of `stage` with `args`, from the settings `read` (environment over dev.env, `T3FLARE_MODEL_ENDPOINT`
 * included) in an environment `env` (`GITHUB_ACTIONS`: CI derives no endpoint; `T3FLARE_DOMAIN`: prod's custom domain,
 * which alchemy reads from the environment).
 */
export const deployPlan = (input: {
  readonly stage: string;
  readonly args: ReadonlyArray<string>;
  readonly read: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DeployPlan => {
  const { stage, args, read, env } = input;
  const endpoint = stageEndpointSpec({ ...read, GITHUB_ACTIONS: env.GITHUB_ACTIONS });
  if (!endpoint.ok && endpoint.invalid) return { ok: false, error: endpoint.reason };
  const noProxy = args.includes("--no-model-proxy");
  // Only prod has a custom domain (README, "custom domain"). A throwaway stage deployed with one claims prod's host: its
  // Access application (found by domain) and the zone's rate-limit ruleset (owned whole by the stage that has the
  // domain). An environment that carries prod's T3FLARE_DOMAIN (a sourced dev.env) is refused, not stripped.
  const domain = env.T3FLARE_DOMAIN ?? "";
  if (stage !== "prod" && domain !== "") return { ok: false, error: `T3FLARE_DOMAIN is set (to ${domain}) for the stage ${stage}: only prod has a custom domain; unset it (was dev.env sourced into the shell?)` };
  if (stage === "prod" && noProxy) return { ok: false, error: `${PROD_KEEPS_THE_PROXY}: --no-model-proxy is for throwaway stages` };
  const secrets = Object.fromEntries(Object.entries(read).filter(([name]) => name !== MODEL_ENDPOINT_VAR && !(noProxy && isModelProxy(name))));
  const missing = DEPLOY_SECRETS.filter((name) => secrets[name] === undefined);
  if (missing.length > 0) return { ok: false, error: `missing ${missing.join(", ")} (set them, or put them in ~/.config/t3flare/dev.env)` };
  const notes: Array<string> = [];
  if (secrets.MODEL_PROXY_URL === undefined) {
    if (stage === "prod") return { ok: false, error: `${PROD_KEEPS_THE_PROXY}: set MODEL_PROXY_URL and MODEL_PROXY_API_KEY` };
    notes.push(`deploying without the Model proxy (${noProxy ? "--no-model-proxy" : "no MODEL_PROXY_URL"})`);
    return { ok: true, alchemyEnv: { ...secrets, MODEL_PROXY_URL: "", MODEL_PROXY_API_KEY: "" }, endpoint, notes };
  }
  if (secrets.MODEL_PROXY_API_KEY === undefined) return { ok: false, error: "MODEL_PROXY_URL is set without MODEL_PROXY_API_KEY" };
  return { ok: true, alchemyEnv: secrets, endpoint, notes };
};
