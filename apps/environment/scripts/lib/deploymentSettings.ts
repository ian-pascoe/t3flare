// Deployment settings (docs/deploy.md): the Owner's own values a Deployment is made with, which the source never holds.
// Each is read from the environment with no default, and a missing or malformed one fails closed with a message naming
// it. Pure, so it is tested (test/deploymentSettings.test.ts); stage.ts, alchemy.run.ts, infra (ci:setup) and the stage
// scripts (lib/scriptSettings.ts) all read the settings through it.

/** The shapes a setting's value must have. */
export type SettingShape = "email" | "accessTeamDomain" | "dnsLabel" | "repo" | "hostname" | "zoneId" | "t3Track";

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

const SHAPES: Readonly<Record<SettingShape, { readonly pattern: RegExp; readonly description: string }>> = {
  email: { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, description: "an email address" },
  accessTeamDomain: { pattern: new RegExp(`^${LABEL}\\.cloudflareaccess\\.com$`), description: "a Cloudflare Access team domain (<team>.cloudflareaccess.com)" },
  dnsLabel: { pattern: new RegExp(`^${LABEL}$`), description: "a DNS label (the account's workers.dev subdomain, without .workers.dev)" },
  repo: { pattern: /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, description: "a GitHub repository as owner/name" },
  hostname: { pattern: new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`), description: "a hostname (such as t3.example.com)" },
  zoneId: { pattern: /^[0-9a-f]{32}$/, description: "a Cloudflare zone id (32 hexadecimal characters)" },
  t3Track: { pattern: /^(?:stable|nightly)$/, description: "a t3 track: stable or nightly (ADR-0041)" },
};

/** Every Deployment setting and the shape of its value. docs/deploy.md says when each is required and where it lives. */
export const DEPLOYMENT_SETTINGS = {
  T3FLARE_ACCESS_TEAM_DOMAIN: "accessTeamDomain",
  T3FLARE_OWNER_EMAIL: "email",
  T3FLARE_WORKERS_DEV_SUBDOMAIN: "dnsLabel",
  T3FLARE_T3_TRACK: "t3Track",
  T3FLARE_DOMAIN: "hostname",
  T3FLARE_DOMAIN_ZONE_ID: "zoneId",
  T3FLARE_UPDATE_REPO: "repo",
  GITHUB_REPOSITORY: "repo",
  T3FLARE_STANDIN_ZONE: "hostname",
  T3FLARE_FIXTURE_REPO: "repo",
} as const satisfies Readonly<Record<string, SettingShape>>;

export type DeploymentSettingName = keyof typeof DEPLOYMENT_SETTINGS;

/** Required on every deploy of every stage (stage.ts and alchemy.run.ts). */
export const EVERY_DEPLOY_SETTINGS = ["T3FLARE_ACCESS_TEAM_DOMAIN", "T3FLARE_OWNER_EMAIL", "T3FLARE_WORKERS_DEV_SUBDOMAIN", "T3FLARE_T3_TRACK"] as const satisfies ReadonlyArray<DeploymentSettingName>;

const WHERE = "Deployment settings are listed in docs/deploy.md: put them in ~/.config/t3flare/dev.env, or in the Deployment repository's variables for CI.";

/** The message for a setting that is not set. */
export const missingSettingMessage = (name: DeploymentSettingName): string => `t3flare: ${name} is not set. ${WHERE}`;

/** The message for a setting whose value is not its shape. The value is never repeated: one of them is a secret in CI. */
export const malformedSettingMessage = (name: DeploymentSettingName): string => `t3flare: ${name} is not ${SHAPES[DEPLOYMENT_SETTINGS[name]].description}. ${WHERE}`;

export type SettingResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string };

type Env = Readonly<Record<string, string | undefined>>;

/** `name` from `env`, if it is set; empty counts as unset (a workflow passes an unset variable as ""). */
export const optionalSetting = (env: Env, name: DeploymentSettingName): SettingResult<string | undefined> => {
  const value = env[name];
  if (value === undefined || value === "") return { ok: true, value: undefined };
  return SHAPES[DEPLOYMENT_SETTINGS[name]].pattern.test(value) ? { ok: true, value } : { ok: false, error: malformedSettingMessage(name) };
};

/** `name` from `env`, which must be set and have its shape. */
export const requiredSetting = (env: Env, name: DeploymentSettingName): SettingResult<string> => {
  const result = optionalSetting(env, name);
  if (!result.ok) return result;
  return result.value === undefined ? { ok: false, error: missingSettingMessage(name) } : { ok: true, value: result.value };
};

/** Every one of `names` from `env`, or every message for those missing or malformed, one per line. */
export const requiredSettings = <const N extends DeploymentSettingName>(env: Env, names: ReadonlyArray<N>): SettingResult<Readonly<Record<N, string>>> => {
  const results = names.map((name) => [name, requiredSetting(env, name)] as const);
  const errors = results.flatMap(([, result]) => (result.ok ? [] : [result.error]));
  if (errors.length > 0) return { ok: false, error: errors.join("\n") };
  return { ok: true, value: Object.fromEntries(results.map(([name, result]) => [name, result.ok ? result.value : ""])) as Record<N, string> };
};

/** `name` from `env`, or throws its message: for scripts, which stop there. */
export const requireSetting = (env: Env, name: DeploymentSettingName): string => {
  const result = requiredSetting(env, name);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
