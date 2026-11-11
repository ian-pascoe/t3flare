// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalDate:off
// Step 3's evidence files: JSON under docs/steps/step-3/, written by the stage scripts.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../../../docs/steps/step-3");

/** Writes `value` to `name` in docs/steps/step-3/, or to `name` itself when it is an absolute path (the bump job's). */
export const writeEvidence = (name: string, value: unknown): void => {
  const file = path.isAbsolute(name) ? name : path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...(value as object) }, null, 1)}\n`);
  console.log(`wrote ${path.isAbsolute(name) ? file : `docs/steps/step-3/${name}`}`);
};
