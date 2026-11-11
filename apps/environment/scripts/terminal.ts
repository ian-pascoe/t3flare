// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b's terminal evidence against a stage, through t3's own terminal RPCs (a headless stock-protocol client).
//
//   bun scripts/stage.ts run <stage> terminal basic [--workspace <id>] [--out file.json]
//       open a terminal in a project of the fixture (cloned first unless --workspace names one), with the Container
//       stopped first: the status line, the prompt, pwd, git status, stty size before and after a resize, echo latency,
//       throughput, the sync both ways, the leak check against the Worker's binding values, close and the processes
//   bun scripts/stage.ts run <stage> terminal restart --workspace <id>   an Environment restart with a terminal open
//   bun scripts/stage.ts run <stage> terminal settle --workspace <id>    a running command survives t3's closeIdle
//   bun scripts/stage.ts run <stage> terminal noproject [--cwd /t3/scratch]  a terminal in no Workspace (t3's No project)
//       shows why and exits within seconds; creates no project or thread (safe on prod)
import * as fs from "node:fs";

import { admin, pair, readDoText, sleep, uuid, wsCall } from "./lib/client.ts";
import { attachTerminal, stripAnsi } from "./lib/terminal.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const [scenario = "basic", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const out = arg("out");
const report: Record<string, unknown> = { scenario, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return ok;
};
const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};

const workspaceCall = (id: string, body: unknown) => admin("POST", `/_t3flare/agents/workspace-call?id=${id}`, body);
const ps = async (id: string, pattern: string) => {
  const result = await workspaceCall(id, { exec: { script: `grep -l -a ${pattern} /proc/[0-9]*/environ 2>/dev/null | wc -l`, passive: true } });
  return Number(String(result.json?.result?.stdout ?? "").trim());
};


const cookie = await pair();

if (scenario === "noproject") {
  const cwd = arg("cwd") ?? "/t3/scratch";
  const opened = Date.now();
  const terminal = await attachTerminal(cookie, { threadId: `terminal-${uuid()}`, terminalId: "default", cwd });
  const shown = await terminal.until(/terminals run in a project's Workspace/, 15_000).catch(() => null);
  report.cwd = cwd;
  report.shownMs = shown === null ? null : Date.now() - opened;
  report.shown = stripAnsi(terminal.output()).trim().slice(-400);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !terminal.events.some((e) => e.event.type === "exited")) await sleep(50);
  report.events = terminal.events.map((e) => (e.event.type === "snapshot" ? `snapshot:${e.event.snapshot?.status}` : e.event.type));
  check("the reason shown within 5 s", shown !== null && (report.shownMs as number) < 5000, report);
  check("terminal exited", (report.events as Array<string>).includes("exited"), report.events);
  await terminal.close(true).catch(() => undefined);
  await terminal.detach();
  report.failures = failures;
  report.ok = failures.length === 0;
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

let id = arg("workspace");
if (id === undefined) {
  id = `term-${Date.now().toString(36)}`;
  const started = Date.now();
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: `/w/${id}` }).catch(
    (error: unknown) => ({ error: String(error).slice(0, 500) }),
  )) as { cwd?: string; error?: string };
  report.clone = { id, ms: Date.now() - started, error: cloned.error ?? null };
  if (!check("clone", cloned.cwd === `/w/${id}`, report.clone)) {
    console.log(JSON.stringify({ ...report, failures }, null, 2));
    process.exit(1);
  }
}
report.workspace = id;
const threadId = `terminal-${uuid()}`;

if (scenario === "basic") {
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${id}`);
  report.containerBefore = (await workspaceCall(id, { killExecs: [] })).json?.container ?? null;
  const opened = Date.now();
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}`, cols: 100, rows: 30 });
  const status = await terminal.until(/Starting the Workspace's Container/, 30_000).catch(() => null);
  report.statusLineMs = status === null ? null : Date.now() - opened;
  const prompt = await terminal.until(/[$#] $/, 90_000);
  report.promptMs = Date.now() - opened;
  check("prompt within 40 s", report.promptMs as number < 40_000, report.promptMs);
  const pwd = await terminal.run("pwd");
  report.pwd = pwd.text.split("\n").find((line) => line.startsWith("/w/")) ?? pwd.text;
  check("pwd is /w/<id>", report.pwd === `/w/${id}`, pwd.text);
  report.gitStatus = (await terminal.run("git status --short --branch | head -3")).text;
  const before = await terminal.run("stty size");
  await terminal.resize(120, 40);
  await sleep(500);
  const after = await terminal.run("stty size");
  report.stty = { before: /\d+ \d+/.exec(before.text)?.[0], after: /\d+ \d+/.exec(after.text)?.[0] };
  check("resize", (report.stty as { after?: string }).after === "40 120", report.stty);
  report.prompt = prompt.text.slice(-80);

  // Echo latency: a keystroke typed, its echo seen.
  const latencies: Array<number> = [];
  for (let i = 0; i < 20; i++) {
    const from = terminal.output().length;
    const started = Date.now();
    await terminal.write(String.fromCharCode(97 + (i % 26)));
    await terminal.until(new RegExp(String.fromCharCode(97 + (i % 26))), 10_000, from);
    latencies.push(Date.now() - started);
  }
  await terminal.write("\x15"); // Ctrl-U clears the line
  report.echo = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), samples: latencies };

  // Throughput: 5 MiB of base64.
  const flood = await terminal.run("head -c 3932160 /dev/zero | base64 -w 160", 180_000);
  report.throughput = { bytes: 5 * 1024 * 1024, ms: flood.ms, mibPerSecond: Number(((5 * 1000) / flood.ms).toFixed(2)) };

  // Ctrl-C reaches the foreground job.
  await terminal.write("sleep 30\r");
  await sleep(1000);
  const ctrlC = Date.now();
  await terminal.write("\x03");
  await terminal.run("echo after-ctrl-c");
  report.ctrlCMs = Date.now() - ctrlC;
  check("ctrl-c", (report.ctrlCMs as number) < 5000, report.ctrlCMs);

  // Sync: the shell's write reaches the DO (t3's file reads), the DO's write reaches the shell.
  const token = `t3flare-${Date.now()}`;
  const wrote = Date.now();
  await terminal.run(`echo ${token} > t.txt`);
  let seenMs: number | null = null;
  while (Date.now() - wrote < 15_000) {
    if ((await readDoText(id, "/workspace/repo/t.txt")).includes(token)) {
      seenMs = Date.now() - wrote;
      break;
    }
    await sleep(200);
  }
  report.shellWriteSeenByDoMs = seenMs;
  check("shell write in the DO within 3 s", seenMs !== null && seenMs < 3000, seenMs);
  const doToken = `do-${Date.now()}`;
  const doWrote = Date.now();
  await workspaceCall(id, { fs: { op: "write", path: "/workspace/repo/from-do.txt", data: doToken } });
  let catMs: number | null = null;
  while (Date.now() - doWrote < 15_000) {
    const cat = await terminal.run("cat from-do.txt 2>/dev/null; echo");
    if (cat.text.includes(doToken)) {
      catMs = Date.now() - doWrote;
      break;
    }
    await sleep(300);
  }
  report.doWriteSeenByShellMs = catMs;
  check("DO write in the shell within 3 s", catMs !== null && catMs < 3000, catMs);
  await terminal.run("rm -f t.txt from-do.txt");

  // The leak check: the terminal's whole env, compared inside the Environment DO with its binding values.
  const env = await terminal.run("env");
  const leak = await admin("POST", "/_t3flare/check/terminal-leak", { text: stripAnsi(env.text) });
  report.envNames = stripAnsi(env.text)
    .split("\n")
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .toSorted();
  report.leak = leak.json;
  check("no binding value in the terminal's env", Array.isArray(leak.json?.leaked) && leak.json.leaked.length === 0 && leak.json.checked.length > 0, leak.json);
  check("process.env empty in the Environment DO", Array.isArray(leak.json?.processEnvKeys) && leak.json.processEnvKeys.length === 0, leak.json?.processEnvKeys);

  // Close: no marked process left.
  await terminal.run("sleep 600 & :");
  report.markedBeforeClose = await ps(id, "T3FLARE_EXEC=term-");
  const closed = Date.now();
  await terminal.close();
  let left = report.markedBeforeClose as number;
  while (Date.now() - closed < 10_000 && left > 0) {
    await sleep(250);
    left = await ps(id, "T3FLARE_EXEC=term-");
  }
  report.close = { ms: Date.now() - closed, left };
  check("no marked process within 3 s of close", left === 0 && Date.now() - closed < 4000, report.close);
  report.events = terminal.events.length;
  await terminal.detach();
}

if (scenario === "settle") {
  // Review F1: t3's closeIdle (what settle runs) must keep a terminal whose foreground runs a command.
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 90_000);
  await terminal.write("sleep 45; echo SLE$((1))PT\r");
  await sleep(2000);
  // closeIdle is not a client RPC; t3 runs it on settle. The admin route asks t3's TerminalManager directly.
  report.closeIdleBusy = (await admin("POST", `/_t3flare/check/terminal-close-idle?thread=${threadId}`)).json;
  await sleep(1000);
  report.aliveAfterBusyCloseIdle = !/exited|closed/.test(terminal.events.slice(-5).map((e) => e.event.type).join(","));
  check("busy terminal kept", report.aliveAfterBusyCloseIdle === true, terminal.events.slice(-5));
  await terminal.until(/SLE1PT/, 60_000);
  await terminal.until(/[$#] $/, 10_000, terminal.output().lastIndexOf("SLE1PT"));
  await sleep(500);
  report.closeIdleIdle = (await admin("POST", `/_t3flare/check/terminal-close-idle?thread=${threadId}`)).json;
  await sleep(2000);
  report.lastEvents = terminal.events.slice(-3).map((e) => e.event.type);
  check("idle terminal closed", (report.lastEvents as Array<string>).some((type) => type === "closed" || type === "exited"), report.lastEvents);
  await terminal.detach();
}

if (scenario === "restart") {
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 90_000);
  const token = `before-restart-${Date.now()}`;
  await terminal.run(`echo ${token}; sleep 900 & :`);
  report.markedBefore = await ps(id, "T3FLARE_EXEC=term-");
  await terminal.detach();
  const restarted = Date.now();
  await admin("POST", "/_t3flare/restart");
  // The client re-attaches with `resume`, as the web client does after a reconnect.
  const again = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}`, resume: true });
  await again.until(new RegExp(token), 60_000);
  await again.until(/[$#] $/, 90_000, again.output().lastIndexOf(token));
  report.resumedMs = Date.now() - restarted;
  report.oldScrollbackShown = again.output().includes(token);
  check("old scrollback", report.oldScrollbackShown === true);
  let left = await ps(id, "T3FLARE_EXEC=term-");
  const waitStarted = Date.now();
  // The new shell is marked too: the old ones are gone when only the new shell's processes are left (1 bash).
  while (Date.now() - waitStarted < 150_000 && left > 1) {
    await sleep(2000);
    left = await ps(id, "T3FLARE_EXEC=term-");
  }
  report.markedAfter = left;
  report.oldGoneMs = Date.now() - restarted;
  check("old shell gone", left <= 1, left);
  await again.close();
  await again.detach();
}

const containerOf = async (id: string) => (await workspaceCall(id, { killExecs: [] })).json?.container as { running: boolean } | undefined;

if (scenario === "clients-gone") {
  // D1: terminals end with their Environment; then the Container stops.
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 90_000);
  await terminal.run("sleep 3600 & :");
  report.markedBefore = await ps(id, "T3FLARE_EXEC=term-");
  await terminal.detach();
  const gone = Date.now();
  report.clientsGoneAt = new Date(gone).toISOString();
  let marked = report.markedBefore as number;
  let shellsGoneMs: number | null = null;
  let containerStoppedMs: number | null = null;
  while (Date.now() - gone < 12 * 60_000) {
    await sleep(10_000);
    const running = (await containerOf(id))?.running === true;
    if (shellsGoneMs === null) {
      marked = running ? await ps(id, "T3FLARE_EXEC=term-") : 0;
      if (marked === 0) shellsGoneMs = Date.now() - gone;
    }
    if (!running) {
      containerStoppedMs = Date.now() - gone;
      break;
    }
  }
  report.shellsGoneMs = shellsGoneMs;
  report.containerStoppedMs = containerStoppedMs;
  report.environment = (await admin("GET", "/_t3flare/health")).json?.runtime ?? null;
  check("shells gone within 4 min", shellsGoneMs !== null && shellsGoneMs < 4 * 60_000, shellsGoneMs);
  check("Container stopped within 7 min", containerStoppedMs !== null && containerStoppedMs < 7 * 60_000, containerStoppedMs);
}

if (scenario === "idle-hold") {
  // Review F10 and the hold (shortened on the stage): the last input ages, the Container stops, the pull runs first.
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 90_000);
  const token = `idle-${Date.now()}`;
  // Output keeps flowing (output is not use), and a file is written just before the stop, too late for a prompt pull.
  await terminal.write(`(while sleep 5; do echo tick; done) & sleep 100; echo ${token} > idle.txt; sleep 600\r`);
  const typed = Date.now();
  let stoppedMs: number | null = null;
  while (Date.now() - typed < 8 * 60_000) {
    await sleep(5000);
    if ((await containerOf(id))?.running === false) {
      stoppedMs = Date.now() - typed;
      break;
    }
  }
  report.containerStoppedAfterLastInputMs = stoppedMs;
  await sleep(2000);
  report.lastEvents = terminal.events.slice(-4).map((e) => e.event.type);
  report.exitedShown = terminal.events.some((e) => e.event.type === "exited");
  report.fileSurvived = (await readDoText(id, "/workspace/repo/idle.txt")).includes(token);
  check("Container stopped by the hold", stoppedMs !== null, stoppedMs);
  check("t3 shows exited", report.exitedShown === true, report.lastEvents);
  check("the file written before the stop was pulled", report.fileSurvived === true);
  await terminal.detach();
  await workspaceCall(id, { fs: { op: "remove", path: "/workspace/repo/idle.txt", options: { force: true } } });
}

if (scenario === "budget") {
  // With 3 Containers held (scratch Workspace DOs outside the registry), a terminal shows the budget's refusal.
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${id}`);
  const holders = ["budget-a", "budget-b", "budget-c"];
  for (const holder of holders) report[holder] = (await workspaceCall(holder, { exec: { script: "echo started" } })).json?.container ?? null;
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  const refused = await terminal.until(/cannot start|budget|Containers/i, 60_000).catch((error: unknown) => ({ ms: -1, text: String(error) }));
  report.refusal = refused.text.split("\n").filter((line) => /t3flare/.test(line)).slice(-2);
  await sleep(1000);
  report.exitedShown = terminal.events.some((e) => e.event.type === "exited");
  check("refusal shown", refused.ms >= 0, refused.text.slice(-300));
  check("terminal exited", report.exitedShown === true);
  await terminal.detach();
  for (const holder of holders) await admin("POST", `/_t3flare/agents/workspace-stop?id=${holder}`);
}

if (scenario === "push") {
  // git push from the PTY through the repo's credential helper (ADR-0013), then the branch is deleted.
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 90_000);
  const branch = `t3flare-terminal-${Date.now()}`;
  const pushed = await terminal.run(`git push origin HEAD:refs/heads/${branch} 2>&1 | tail -3; echo "exit=\${PIPESTATUS[0]}"`, 120_000);
  report.push = pushed.text.split("\n").slice(-6);
  check("push", /exit=0/.test(pushed.text), pushed.text.slice(-400));
  const deleted = await terminal.run(`git push origin --delete ${branch} 2>&1 | tail -2; echo "exit=\${PIPESTATUS[0]}"`, 120_000);
  report.delete = deleted.text.split("\n").slice(-4);
  check("branch deleted", /exit=0/.test(deleted.text), deleted.text.slice(-300));
  await terminal.close();
  await terminal.detach();
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(report.ok ? 0 : 1);
