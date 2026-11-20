// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// The upstream fingerprint (SPI-1011, fragility T2): checks the pinned t3code against
// test/fixtures/upstream-fingerprint.json, which `test/upstreamFingerprint.test.ts` also does in `pnpm run check`.
//
//   node apps/environment/scripts/upstream-fingerprint.ts            list what changed since the last review
//   node apps/environment/scripts/upstream-fingerprint.ts --update   once each named file of ours is reviewed against
//                                                                    the change, record the pin's hashes; the PR that
//                                                                    bumps the pin carries the update
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { type Fingerprint, checkFingerprint, updateFingerprint } from "./lib/upstreamFingerprint.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const t3Root = path.join(root, "t3code");
const fixturePath = path.join(root, "apps/environment/test/fixtures/upstream-fingerprint.json");
const read = (file: string) => fs.readFileSync(path.join(t3Root, file), "utf8");
const fingerprint = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fingerprint;

if (process.argv.includes("--update")) {
  const pin = execFileSync("git", ["-C", t3Root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let updated: Fingerprint;
  try {
    updated = updateFingerprint(fingerprint, read, pin);
  } catch (error) {
    console.error(`upstream fingerprint: not updated:\n${(error as Error).message}`);
    process.exit(1);
  }
  fs.writeFileSync(fixturePath, `${JSON.stringify(updated, null, 2)}\n`);
  const changed = updated.regions.filter((region, index) => region.hash !== fingerprint.regions[index]!.hash);
  console.log(`upstream fingerprint: ${changed.length} region(s) re-recorded at t3code ${pin.slice(0, 12)}`);
  for (const region of changed) console.log(`  ${region.file} (${region.symbol}) for ${region.ourFile} (${region.entry})`);
} else {
  const failures = checkFingerprint(fingerprint, read);
  for (const failure of failures) console.log(failure);
  console.log(failures.length === 0 ? "upstream fingerprint: as last reviewed" : `upstream fingerprint: ${failures.length} to review`);
  process.exit(failures.length === 0 ? 0 : 1);
}
