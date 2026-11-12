// The Container's credential scanner (step 4a, plan §4.7, review F3) on Node over fixture files: a credential is found
// by prefix, length and hash wherever it sits, a changed file with one is moved out of the synced tree, an unchanged
// one is not read, and nothing like a credential but not one is reported.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LEAKSCAN_JS, type LeakScanAnswer, type LeakScanInput, patternOf } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

const KEY = "cms_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZ";
const GH = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";

const scan = (input: LeakScanInput): LeakScanAnswer => {
  const result = spawnSync(process.execPath, ["-e", LEAKSCAN_JS, JSON.stringify(input)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as LeakScanAnswer;
};

describe("the leak scanner", () => {
  it("finds each credential wherever it sits, quarantines changed files, and skips unchanged ones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leakscan-"));
    const synced = path.join(root, "workspace");
    fs.mkdirSync(path.join(synced, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(synced, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(synced, "sessions", "rollout.jsonl"), `{"type":"tool","output":"key=${KEY}\\n"}\n`);
    fs.writeFileSync(path.join(synced, "sessions", "near-miss.jsonl"), `${KEY.slice(0, -1)}X ghs_short ${KEY.slice(0, 20)}\n`);
    fs.writeFileSync(path.join(synced, "token.txt"), `x${GH}y`);
    fs.writeFileSync(path.join(synced, "node_modules", "skipped.js"), KEY);
    const old = path.join(synced, "old.txt");
    fs.writeFileSync(old, KEY);
    const before = Date.now() - 1000;
    fs.utimesSync(old, new Date(before - 60_000), new Date(before - 60_000));
    const patterns = [await patternOf("model-key", KEY), await patternOf("github-token", GH)];
    expect(JSON.stringify(patterns)).not.toContain(KEY.slice(4));
    const answer = scan({ patterns, roots: [synced], since: before, quarantine: path.join(root, "quarantine"), skip: ["node_modules"] });
    expect(answer.hits.map((hit) => [hit.name, path.relative(synced, hit.path)]).toSorted((a, b) => a.join().localeCompare(b.join()))).toEqual([
      ["github-token", "token.txt"],
      ["model-key", "sessions/rollout.jsonl"],
    ]);
    expect(fs.existsSync(path.join(synced, "sessions", "rollout.jsonl"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "quarantine"))).toHaveLength(2);
    expect(fs.existsSync(old)).toBe(true);
    const full = scan({ patterns, roots: [synced], since: 0 });
    expect(full.hits.map((hit) => path.relative(synced, hit.path)).toSorted((a, b) => a.localeCompare(b))).toEqual(["node_modules/skipped.js", "old.txt"]);
  });
});
