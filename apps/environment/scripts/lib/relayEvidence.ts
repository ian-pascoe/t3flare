// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// The model relay's stage evidence (SPI-1169's `p1169.ts`, from SPI-1167's and SPI-1168's scripts): a report of named
// checks that is scanned for every key and handle before anything is kept or printed, with the head it covers; the
// admin routes a script uses on a Workspace; and the relay's log lines in a Workers tail.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import { admin } from "./client.ts";

/** The evidence of one run: `check` records a named check, `clean` throws if a secret is in a value kept. */
export const relayEvidence = (secrets: ReadonlyArray<string>) => {
  const index = process.argv.indexOf("--out");
  const out = index === -1 ? undefined : process.argv[index + 1];
  const stage = new URL(process.env.T3_URL ?? "http://localhost").hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
  const git = (...args: Array<string>) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
  // The code the evidence covers: the commit deployed (the working tree must be clean for it to be that commit).
  const report: Record<string, unknown> = { at: new Date().toISOString(), stage, head: git("rev-parse", "HEAD"), clean: git("status", "--porcelain") === "" };
  const kept = secrets.filter((value) => value.length >= 8);
  const handles: Array<string> = [];
  const failures: Array<string> = [];
  const checks: Array<{ name: string; ok: boolean }> = [];
  function clean<T>(value: T): T {
    const text = JSON.stringify(value) ?? "";
    for (const secret of [...kept, ...handles]) if (text.includes(secret)) throw new Error("a key or a handle reached an answer kept as evidence");
    return value;
  }
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok });
    if (!ok) failures.push(`${name}: ${JSON.stringify(clean(detail ?? null)).slice(0, 600)}`);
    return ok;
  };
  /** Whether a secret or a handle is in `text` (the Workers' log). */
  const leaks = (text: string) => [...kept, ...handles].some((value) => text.includes(value));
  const finish = (): never => {
    report.checks = checks;
    report.failures = failures;
    report.ok = failures.length === 0;
    const text = JSON.stringify(clean(report), null, 2);
    console.log(text.slice(0, 20_000));
    if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
    process.exit(report.ok ? 0 : 1);
  };
  return { stage, report, handles, clean, check, leaks, finish, fail: (message: string) => failures.push(message) };
};

/** The Settings page's API, a command in a Workspace's Container, and the leak check, through the admin routes. */
export const panelApi = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/settings/api/${pathname}`, body);
export const workspaceExec = async (workspace: string, script: string, timeoutMs = 60_000) =>
  ((await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script, timeoutMs } })).json as any)?.result ?? {};
export const leakCheck = async (workspace: string) => (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(workspace)}`)).json;
/** A command's `name=value` lines. */
export const linesOf = (stdout: string | undefined): Record<string, string> => Object.fromEntries((stdout ?? "").trim().split("\n").map((line: string) => line.split("=", 2) as [string, string]));

/** The log lines of a Workers tail (`wrangler tail --format json`) whose JSON message starts with `{"t3flare":"<kind>`. */
export const workerLogs = (raw: string, kind: string): Array<any> => {
  const found: Array<any> = [];
  for (const chunk of raw.split(/\n(?=\{\n)/).filter((part) => part.trim().startsWith("{"))) {
    try {
      const event = JSON.parse(chunk) as { logs?: Array<{ message: Array<unknown> }> };
      for (const log of event.logs ?? []) {
        for (const message of log.message) if (typeof message === "string" && message.startsWith(`{"t3flare":"${kind}`)) found.push(JSON.parse(message));
      }
    } catch {
      // An event cut off when the tail stopped.
    }
  }
  return found;
};
