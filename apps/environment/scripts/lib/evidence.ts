// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalDate:off
// Step 3's evidence files: JSON under docs/steps/step-3/, written by the stage scripts.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../../../docs/steps/step-3");

export const writeEvidence = (name: string, value: unknown): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify({ at: new Date().toISOString(), ...(value as object) }, null, 1)}\n`);
  console.log(`wrote docs/steps/step-3/${name}`);
};
