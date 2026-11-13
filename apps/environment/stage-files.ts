// @effect-diagnostics nodeBuiltinImport:off
// Where a stage's local files live (gitignored, 0600): the secrets scripts/stage.ts makes for it, and the
// Access service-token credentials alchemy.run.ts writes on deploy, and (SPI-1061) the stage stand-in's tunnel token.
import * as path from "node:path";

const dir = path.join(import.meta.dirname, ".alchemy", "stages");

export const secretsFile = (stage: string) => path.join(dir, `${stage}.env.json`);
export const credentialsFile = (stage: string) => path.join(dir, `${stage}.access.json`);
/** SPI-1061: the stand-in's Cloudflare Tunnel token and hostname, for its container's `cloudflared` (never printed). */
export const standinFile = (stage: string) => path.join(dir, `${stage}.standin.json`);
