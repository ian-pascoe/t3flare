// @effect-diagnostics nodeBuiltinImport:off
// Where a stage's local files live (gitignored, 0600): the secrets scripts/stage.ts makes for it, and the
// Access service-token credentials alchemy.run.ts writes on deploy.
import * as path from "node:path";

const dir = path.join(import.meta.dirname, ".alchemy", "stages");

export const secretsFile = (stage: string) => path.join(dir, `${stage}.env.json`);
export const credentialsFile = (stage: string) => path.join(dir, `${stage}.access.json`);
