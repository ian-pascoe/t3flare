// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// The upstream fingerprint (SPI-1011, fragility T2): checks the pinned t3code against
// test/fixtures/upstream-fingerprint.json, which `test/upstreamFingerprint.test.ts` also does in `pnpm run check`.
//
//   node apps/environment/scripts/upstream-fingerprint.ts            list what changed since the last review: watched
//                                                                    regions and literals, and other bytes of the
//                                                                    watched files (the land check compares whole files)
//   node apps/environment/scripts/upstream-fingerprint.ts --json     the same as one JSON line of findings, exit 0
//                                                                    (`scripts/bump.ts`'s step)
//   node apps/environment/scripts/upstream-fingerprint.ts --update   once each named file of ours is reviewed against
//                                                                    the change, record the pin's hashes
//
// A bump whose fingerprint changed is proven and proposed, but does not land by itself (ADR-0037's SPI-1011
// refinement): a person cuts a branch of their own from `bump/<tag>` (the hourly bump force-pushes that one), reviews
// the files its pull request names, runs `--update`, and merges their branch's pull request.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { checkFingerprint, FIXTURE_PATH, type Fingerprint, fingerprintFindings, gitBlobOf, updateFingerprint } from "./lib/upstreamFingerprint.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const t3Root = path.join(root, "t3code");
const fixturePath = path.join(root, FIXTURE_PATH);
const read = (file: string) => fs.readFileSync(path.join(t3Root, file), "utf8");
const blobOf = gitBlobOf(t3Root);
const fingerprint = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fingerprint;

if (process.argv.includes("--update")) {
  const reviewedCommit = execFileSync("git", ["-C", t3Root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let updated: Fingerprint;
  try {
    updated = updateFingerprint(fingerprint, read, blobOf, reviewedCommit);
  } catch (error) {
    console.error(`upstream fingerprint: not updated:\n${(error as Error).message}`);
    process.exit(1);
  }
  fs.writeFileSync(fixturePath, `${JSON.stringify(updated, null, 2)}\n`);
  const before = new Map(fingerprint.regions.map((region) => [`${region.file}#${region.symbol}`, region.hash]));
  const changed = updated.regions.filter((region) => before.get(`${region.file}#${region.symbol}`) !== region.hash);
  console.log(`upstream fingerprint: ${changed.length} region(s) re-recorded, reviewed at t3code ${reviewedCommit.slice(0, 12)}`);
  for (const region of changed) console.log(`  ${region.file} (${region.symbol}) for ${region.ourFile} (${region.entry})`);
} else if (process.argv.includes("--json")) {
  console.log(JSON.stringify(fingerprintFindings(fingerprint, read, blobOf)));
} else {
  const failures = checkFingerprint(fingerprint, read, blobOf);
  for (const failure of failures) console.log(failure);
  console.log(failures.length === 0 ? "upstream fingerprint: as last reviewed" : `upstream fingerprint: ${failures.length} to review`);
  process.exit(failures.length === 0 ? 0 : 1);
}
