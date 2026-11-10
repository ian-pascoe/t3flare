// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// R5 (step 2a plan, section 8; moved to M3): the heap the Workspace DO's isomorphic-git work takes on a 2,000-file repo,
// measured in Node (V8, as workerd) with forced GCs around each step: a checkpoint capture (status of every file, a
// blob per changed file, the trees, a commit), the checkpoint diff, and a stale status patch. workerd has no heap API,
// so the deployed run (`m3-memory.json`) reports timings and the absence of memory errors; this reports the heap.
//
//   node --expose-gc --experimental-strip-types apps/agents/scripts/r5-memory.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCheckpoint, diffCommits, repoFacts, resolveCommit } from "../src/workspace/gitRepo.ts";
import { patchAnswer } from "../src/workspace/staleReads.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("run with --expose-gc");
const FILES = 2000;
const dir = fs.mkdtempSync(join(tmpdir(), "t3flare-r5-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, env }).toString();
git("init", "-q", "-b", "main");
for (let file = 0; file < FILES; file++) {
  const sub = join(dir, `pkg${file % 40}`, `mod${file % 7}`);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(join(sub, `file${file}.ts`), `export const value${file} = ${file};\n`.repeat(40));
}
git("add", "-A");
git("commit", "-q", "-m", "2000 files");
const status = git("status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind");
// An agent's turn: 20 files edited, 5 added.
const journal: Array<string> = [];
for (let file = 0; file < 20; file++) {
  const path = `pkg${file % 40}/mod${file % 7}/file${file}.ts`;
  fs.appendFileSync(join(dir, path), "// edited\n");
  journal.push(path);
}
for (let file = 0; file < 5; file++) {
  fs.writeFileSync(join(dir, `new${file}.ts`), "new\n");
  journal.push(`new${file}.ts`);
}

const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const steps: Array<Record<string, unknown>> = [];
const step = async <A>(name: string, run: () => Promise<A>): Promise<A> => {
  const before = heap();
  let peak = before;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 1);
  const started = performance.now();
  const value = await run();
  const ms = Math.round(performance.now() - started);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  steps.push({ step: name, ms, heapBeforeMb: mb(before), heapPeakMb: mb(peak), retainedMb: mb(heap() - before) });
  return value;
};

const repo = () => ({ fs, dir, cache: {} });
const start = await step("capture (from)", () => captureCheckpoint(repo(), "refs/t3/r5/from", 1));
fs.appendFileSync(join(dir, "pkg0/mod0/file0.ts"), "// more\n");
const end = await step("capture (to)", () => captureCheckpoint(repo(), "refs/t3/r5/to", 2));
const patch = await step("diff (patch)", () => diffCommits(repo(), start, end, { format: "patch" }));
await step("stale status patch (25 journal paths)", async () => patchAnswer("status", status, journal, await repoFacts(repo())));
const out = {
  measured: true,
  where: "Node (V8) with --expose-gc; workerd has no heap API",
  repo: { trackedFiles: FILES, head: await resolveCommit(repo(), "HEAD") },
  patchBytes: patch.length,
  steps,
  isolateLimitMb: 128,
};
console.log(JSON.stringify(out, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
