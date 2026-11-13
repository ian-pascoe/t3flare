// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1050: a 100 MiB file in a small repo must not run the Workspace DO out of memory.
//
//   node scripts/stage.ts run <stage> spi1050 [--repo octocat/Hello-World] [--mib 100] [--out <file>]
//
// Clones a small repo as a Workspace; writes a big random file in the Container; then, with the Container running and
// stopped, captures checkpoints and reads status (the reads t3 polls). Then commits the file (a big loose object),
// repeats, removes it and runs `git gc`, and checks the DO's git answers by itself again.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { admin, pair, sleep, wsCall } from "./lib/client.ts";

// Both Workers' logs, as logs-check.ts streams them (the alchemy profile's token, never printed): the outcome and
// exceptions of each event, and the Workspace DO's own JSON log lines, are kept in the report.
const here = path.resolve(import.meta.dirname, "..");
const environmentScript = new URL(process.env.T3_URL!).hostname.split(".")[0]!;
const tails = (() => {
  const profile = process.env.ALCHEMY_PROFILE ?? "default";
  const stored = process.env.CLOUDFLARE_API_TOKEN
    ? { access: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
    : JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return [environmentScript, environmentScript.replace("t3flare-environment-", "t3flare-agents-")].map((script) => {
    const file = path.join(os.tmpdir(), `t3flare-spi1050-${script}-${Date.now()}.ndjson`);
    const out = fs.openSync(file, "w", 0o600);
    const child = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", script, "--format", "json"], {
      cwd: here,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: stored.access as string, CLOUDFLARE_ACCOUNT_ID: (stored.accountId as string) ?? "" },
      stdio: ["ignore", out, "ignore"],
    });
    return { script, file, child };
  });
})();
await sleep(8000);
const tailEvents = () =>
  tails.flatMap(({ script, file }) => {
    const text = fs.readFileSync(file, "utf8");
    const events: Array<unknown> = [];
    // wrangler prints one pretty-printed JSON object per event, back to back.
    for (const chunk of text.split(/\n(?=\{)/)) {
      try {
        const event = JSON.parse(chunk);
        const logs = (event.logs ?? []).map((log: any) => String(log.message?.[0] ?? "")).filter((line: string) => /t3flare|exceed|memory|reset|Error/i.test(line));
        if (event.outcome !== "ok" || (event.exceptions ?? []).length > 0 || logs.length > 0)
          events.push({ script, outcome: event.outcome, at: event.eventTimestamp, exceptions: (event.exceptions ?? []).map((e: any) => `${e.name}: ${String(e.message).slice(0, 300)}`), logs: logs.map((l: string) => l.slice(0, 300)) });
      } catch {}
    }
    return events;
  });

const args = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const repo = arg("repo") ?? "octocat/Hello-World";
const mib = Number(arg("mib") ?? 100);
const report: Record<string, unknown> = { repo, mib, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};

const cookie = await pair();
const id = `s1050-${Date.now().toString(36)}`;
const call = async (body: unknown) => {
  const started = Date.now();
  const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, body).catch((error: unknown) => ({
    status: 0,
    json: { result: { ok: false, ran: false, detail: String(error).slice(0, 300) } },
  }));
  return { ms: Date.now() - started, http: answer.status, result: answer.json?.result, raw: answer.json as unknown, running: answer.json?.container?.running };
};
const exec = (script: string) => call({ exec: { script, cwd: "/workspace/repo", timeoutMs: 120_000 } });
const capture = (n: number) => call({ checkpoint: { op: "capture", ref: `refs/t3/checkpoints/spi1050/turn/${n}` } });
const status = (startContainer = false) => call({ git: { argv: ["status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind"], cwd: "/workspace/repo", startContainer } });
const stop = () => admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
const brief = (a: Awaited<ReturnType<typeof call>>) => ({
  ms: a.ms,
  http: a.http,
  ok: a.result?.ok,
  by: a.result?.by,
  ran: a.result?.ran,
  exitCode: a.result?.exitCode,
  stale: a.result?.stale ?? null,
  error: a.result?.error ?? a.result?.detail ?? a.result?.reason ?? (a.http >= 400 ? JSON.stringify(a.raw ?? null).slice(0, 400) : null),
  stdout: typeof a.result?.stdout === "string" ? a.result.stdout.replaceAll("\0", "\\0").slice(0, 300) : null,
  running: a.running,
});

const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${repo}.git`, destinationPath: `/w/${id}` }).catch(
  (error: unknown) => ({ error: String(error).slice(0, 500) }),
)) as { cwd?: string; error?: string };
report.clone = cloned;
if (!check("clone", cloned.cwd === `/w/${id}`, cloned)) {
  console.log(JSON.stringify({ ok: false, failures, ...report }, null, 2));
  process.exit(1);
}

const steps: Record<string, unknown> = {};
report.steps = steps;
steps.baseline = brief(await capture(0));
// t3's status poll, once with the Container running: a stopped Container's reads are patched from the last answer.
steps.statusRunning = brief(await status(false));
check("a capture of the small repo is the DO's", (steps.baseline as any).by === "do", steps.baseline);

// 1. A big untracked file, written in the Container.
steps.write = brief(await exec(`head -c ${mib}M /dev/urandom > big.bin && ls -l big.bin`));
steps.captureRunning = brief(await capture(1));
check("with the big file, the capture is the Container's", (steps.captureRunning as any).ok === true && (steps.captureRunning as any).by === "container", steps.captureRunning);
await stop();
steps.statusStopped = brief(await status());
check("status answers while stopped", (steps.statusStopped as any).exitCode === 0, steps.statusStopped);
steps.captureStopped = brief(await capture(2));
check("a capture while stopped succeeds", (steps.captureStopped as any).ok === true, steps.captureStopped);

// 2. The file committed: a big loose object in .git.
steps.commit = brief(await exec(`git -c user.name=t -c user.email=t@x add big.bin && git -c user.name=t -c user.email=t@x commit -qm big && git count-objects -vH`));
steps.captureCommitted = brief(await capture(3));
check("after the commit, the capture succeeds", (steps.captureCommitted as any).ok === true, steps.captureCommitted);
await stop();
steps.statusCommittedStopped = brief(await status());
check("status answers while stopped, after the commit", (steps.statusCommittedStopped as any).exitCode === 0, steps.statusCommittedStopped);

// 3. Gone again: the DO's own git takes over.
steps.cleanup = brief(
  await exec(`git reset -q --hard HEAD~1 && git reflog expire --expire=now --all && git for-each-ref --format='%(refname)' refs/t3 | xargs -r -n1 git update-ref -d && git gc -q --prune=now && ls -la && git count-objects -vH`),
);
steps.captureClean = brief(await capture(4));
check("once the file is gone, the capture is the DO's again", (steps.captureClean as any).by === "do", steps.captureClean);
await stop();
steps.statusClean = brief(await status());
check("status answers while stopped, once clean", (steps.statusClean as any).exitCode === 0, steps.statusClean);
steps.fsRead = brief(await call({ fs: { op: "stat", path: "/workspace/repo/README" } }));

steps.workspaceErrors = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((row) => row.id === id)?.lastError ?? null;
await admin("POST", `/_t3flare/agents/workspace-remove?id=${id}`).catch(() => undefined);
await sleep(5000);
report.logs = tailEvents();
for (const { child } of tails) child.kill();
const out = { ok: failures.length === 0, failures, ...report };
console.log(JSON.stringify(out, null, 2));
const file = arg("out");
if (file !== undefined) fs.writeFileSync(file, JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
