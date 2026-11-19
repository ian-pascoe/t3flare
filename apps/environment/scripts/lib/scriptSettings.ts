// The Deployment settings the stage scripts need (lib/deploymentSettings.ts), from their environment: `stage.ts run`
// passes the shell's and ~/.config/t3flare/dev.env's (the shell's win). Each throws its setting's message when it is
// missing or malformed; call them where the value is used, so a script that does not need one runs without it.
import { requireSetting } from "./deploymentSettings.ts";

/** The fixture repository (`owner/name`) the acceptance harness and the step scripts clone and push to. */
export const fixtureRepo = (): string => requireSetting(process.env, "T3FLARE_FIXTURE_REPO");

/** The https URL of the account's Worker `worker` at its workers.dev host. */
export const workersDevUrl = (worker: string): string => `https://${worker}.${requireSetting(process.env, "T3FLARE_WORKERS_DEV_SUBDOMAIN")}.workers.dev`;

/** The account's Access team domain (`<team>.cloudflareaccess.com`). */
export const accessTeamDomain = (): string => requireSetting(process.env, "T3FLARE_ACCESS_TEAM_DOMAIN");

/** prod's custom domain. */
export const prodDomain = (): string => requireSetting(process.env, "T3FLARE_DOMAIN");
