// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1149's stage evidence (stage `penv`): the Environment settings through the panel's API, and the Containers that
// start with them. Run through the stage's `run`, which sets the stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run penv penv seed-old        on a deploy of main: a Harness change, an audit entry without `entity`
//   node scripts/stage.ts run penv penv sizes           each size set, a Container started, its limits read (sizes.json)
//   node scripts/stage.ts run penv penv running         a change while a Container runs, then its next start (running.json)
//   node scripts/stage.ts run penv penv idle            the idle stop at two values (idle.json)
//   node scripts/stage.ts run penv penv budget          the budget at 1, raised to 2, lowered to 1 with two running (budget.json)
//   node scripts/stage.ts run penv penv revisions       each entity's revision moves alone (revisions.json)
//   node scripts/stage.ts run penv penv audit           entries with `entity`, before and after; old ones as harness (audit.json)
//   node scripts/stage.ts run penv penv safety          the new routes refused from outside (safety.json)
//   node scripts/stage.ts run penv penv shoot           the panel's Environment section (environment-<desktop|phone>-<light|dark>.png)
//
// Evidence goes to docs/steps/environment-settings/. Screenshots are resized to at most 1400 px wide (sips).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, pair, sleep } from "./lib/client.ts";

const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const T3 = process.env.T3_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/environment-settings");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const WORKSPACE = "penv-sizes";
const SIZES = ["cpu-1", "standard-1", "standard-2", "standard-3", "standard-4"] as const;

interface Case {
  readonly name: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

/** The deployed build's commit (the Worker's `/_t3flare/health`), so each evidence file names the code it ran against. */
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }, null, 1)}\n`);
  console.log(`wrote docs/steps/environment-settings/${name} (ok: ${String(value.ok)})`);
};

/** The panel's JSON API as a script calls it: the service token and the admin token. */
const harness = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...scriptHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 300);
  }
  return { status: response.status, json };
};

const setEnvironment = async (settings: Record<string, unknown>) => {
  const answer = await harness("POST", "/_t3flare/harness/api/environment", { settings });
  if (answer.status !== 200) throw new Error(`environment change ${JSON.stringify(settings)} refused: ${answer.status} ${JSON.stringify(answer.json)}`);
  return answer.json as { revision: number; resolved: Record<string, unknown> };
};

const revisions = async () => ({
  harness: (await harness("GET", "/_t3flare/harness/api/settings")).json?.revision as number,
  environment: (await harness("GET", "/_t3flare/harness/api/environment")).json?.revision as number,
});

// ── The Workspace and its Container ─────────────────────────────────────────────────────────────────────────────

/** What the Container's own view says its limits are: cgroup v2 at the root and its own group, CPUs, memory, root disk. */
const LIMITS = [
  "cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)",
  'echo "cgroup=$cg"',
  'echo "cpu.max(root)=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo none)"',
  'echo "cpu.max=$(cat "$cg/cpu.max" 2>/dev/null || echo none)"',
  'echo "memory.max(root)=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo none)"',
  'echo "memory.max=$(cat "$cg/memory.max" 2>/dev/null || echo none)"',
  'echo "nproc=$(nproc)"',
  "echo \"memtotal_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)\"",
  "echo \"rootdisk_bytes=$(df -B1 --output=size / | tail -1 | tr -d ' ')\"",
].join("\n");

const parseLimits = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split("="))
      .filter((parts) => parts.length >= 2)
      .map(([key, ...rest]) => [key!, rest.join("=")]),
  );

let cookie = "";
const ready = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
};

/** One Workspace call, its whole answer kept (a refused start answers 500 with the budget's reason in its text). */
const callOn = async (id: string, body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${id}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) } as { status: number; result: any; container: any; text?: string };
  } catch {
    return { status: response.status, result: undefined, container: undefined, text } as { status: number; result: any; container: any; text?: string };
  }
};
const call = (body: unknown) => callOn(WORKSPACE, body);
const stopOn = (id: string) => admin("POST", `/_t3flare/agents/workspace-stop?id=${id}`);
const stop = () => stopOn(WORKSPACE);
/** A Workspace's Container state without using it (the registry's listing never counts as use). */
const stateOf = async (id: string) => ((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces as Array<any> | undefined)?.find((row) => row.id === id)?.container;
const state = () => stateOf(WORKSPACE);

/** Starts the Container if stopped (a command is use), and reads its limits. */
const measure = async () => {
  const answer = await call({ exec: { script: LIMITS, timeoutMs: 180_000 } });
  return { exitCode: answer.result?.exitCode, limits: parseLimits(String(answer.result?.stdout ?? "")), container: answer.container, stderr: String(answer.result?.stderr ?? "").slice(0, 300) || undefined };
};

/** Polls until the Container stops; the time it stopped, as first seen stopped. */
const untilStopped = async (limitMs: number) => {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const now = await state();
    if (now?.running === false) return { stoppedSeenAt: Date.now(), state: now };
    await sleep(5_000);
  }
  return { stoppedSeenAt: null, state: await state() };
};

/** Cloudflare's limits page: a named type's resources; cpu-1 is t3flare's custom size. */
const EXPECTED = {
  "cpu-1": { vcpu: 1, memoryMib: 3072, diskMb: 12_000 },
  "standard-1": { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 },
  "standard-2": { vcpu: 1, memoryMib: 6144, diskMb: 12_000 },
  "standard-3": { vcpu: 2, memoryMib: 8192, diskMb: 16_000 },
  "standard-4": { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
} as const;

/**
 * Whether the measured limits are the size's: memory within 10 % (the VM's kernel keeps some of MemTotal, a cgroup
 * limit is exact), the root disk within 20 % (filesystem overhead), and CPU from the quota when there is one, else nproc
 * (a fractional size has one CPU).
 */
const fits = (size: keyof typeof EXPECTED, limits: Record<string, string>) => {
  const expected = EXPECTED[size];
  const memoryMax = Number(limits["memory.max"]);
  const memoryBytes = Number.isFinite(memoryMax) ? memoryMax : Number(limits.memtotal_kb) * 1024;
  const memoryOk = Math.abs(memoryBytes / (expected.memoryMib * 2 ** 20) - 1) < 0.1;
  const disk = Number(limits.rootdisk_bytes);
  const diskOk = Math.abs(disk / (expected.diskMb * 1e6) - 1) < 0.2;
  const [quota, period] = String(limits["cpu.max"] ?? "").split(" ");
  const cpus = quota !== undefined && quota !== "max" && Number(period) > 0 ? Number(quota) / Number(period) : Number(limits.nproc);
  const cpuOk = Math.abs(cpus - Math.max(expected.vcpu, quota !== undefined && quota !== "max" ? 0 : 1)) < 0.05;
  return { memoryBytes, memoryOk, disk, diskOk, cpus, cpuOk, ok: memoryOk && diskOk && cpuOk };
};

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** On a deploy of main (before SPI-1149): one Harness change, so the audit log holds an entry written without `entity`. */
const seedOld = async () => {
  const answer = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 2345 } });
  console.log(`seed-old: ${answer.status} ${JSON.stringify(answer.json).slice(0, 200)}`);
};

const sizes = async () => {
  await ready();
  const rows: Array<Case> = [];
  for (const size of SIZES) {
    const set = await setEnvironment({ containerSize: size, containerIdleMinutes: 5 });
    await stop();
    const measured = await measure();
    const fit = fits(size, measured.limits);
    rows.push({
      name: size,
      revision: set.revision,
      launch: measured.container?.launch ?? null,
      limits: measured.limits,
      expected: EXPECTED[size],
      fit,
      ok: measured.exitCode === 0 && measured.container?.launch?.size === size && fit.ok,
    });
    console.log(`${size}: ${JSON.stringify(measured.limits)}`);
  }
  await stop();
  await setEnvironment({ containerSize: "cpu-1", containerIdleMinutes: 2 });
  await writeEvidence("sizes.json", { workspace: WORKSPACE, sizes: rows, ok: rows.every((row) => row.ok) });
};

const running = async () => {
  await ready();
  const cases: Array<Case> = [];
  await setEnvironment({ containerSize: "standard-1", containerIdleMinutes: 2 });
  await stop();
  const first = await measure();
  cases.push({ name: "started on standard-1 with a 2-minute idle time", startedAt: first.container?.startedAt, launch: first.container?.launch, limits: first.limits, ok: first.container?.launch?.size === "standard-1" && first.container?.launch?.idleMs === 120_000 });
  const changed = await setEnvironment({ containerSize: "standard-3", containerIdleMinutes: 1 });
  const during = await measure();
  cases.push({
    name: "a change to standard-3 and 1 minute while it runs leaves its start time, size, idle time and limits as they were",
    revision: changed.revision,
    startedAt: during.container?.startedAt,
    launch: during.container?.launch,
    limits: during.limits,
    ok:
      during.container?.running === true &&
      during.container?.startedAt === first.container?.startedAt &&
      during.container?.launch?.size === "standard-1" &&
      during.container?.launch?.idleMs === 120_000 &&
      JSON.stringify(during.limits) === JSON.stringify(first.limits),
  });
  const lastUse = (await state())?.lastUse as number;
  const stopped = await untilStopped(6 * 60_000);
  const idleSeen = stopped.stoppedSeenAt === null ? null : stopped.stoppedSeenAt - lastUse;
  cases.push({ name: "it stops after the idle time it started with (2 minutes), not the new one", lastUse, stoppedSeenAt: stopped.stoppedSeenAt, idleSeenMs: idleSeen, ok: idleSeen !== null && idleSeen >= 120_000 && idleSeen < 120_000 + 75_000 });
  const next = await measure();
  cases.push({
    name: "the next start has the new size and idle time",
    startedAt: next.container?.startedAt,
    launch: next.container?.launch,
    limits: next.limits,
    fit: fits("standard-3", next.limits),
    ok: next.container?.startedAt !== first.container?.startedAt && next.container?.launch?.size === "standard-3" && next.container?.launch?.idleMs === 60_000 && fits("standard-3", next.limits).ok,
  });
  await stop();
  await setEnvironment({ containerSize: "cpu-1", containerIdleMinutes: 2 });
  await writeEvidence("running.json", { workspace: WORKSPACE, cases, ok: cases.every((entry) => entry.ok) });
};

const idle = async () => {
  await ready();
  const cases: Array<Case> = [];
  for (const minutes of [1, 3]) {
    await setEnvironment({ containerIdleMinutes: minutes });
    await stop();
    const started = await call({ exec: { script: "true", timeoutMs: 180_000 } });
    const lastUse = started.container?.lastUse as number;
    const stopped = await untilStopped((minutes + 3) * 60_000);
    const seen = stopped.stoppedSeenAt === null ? null : stopped.stoppedSeenAt - lastUse;
    // Stopped no earlier than the idle time, and within the alarm's slack plus the 5 s poll.
    cases.push({ name: `idle ${minutes} minute(s)`, launch: started.container?.launch, lastUse, stoppedSeenAt: stopped.stoppedSeenAt, idleSeenMs: seen, ok: started.container?.launch?.idleMs === minutes * 60_000 && seen !== null && seen >= minutes * 60_000 && seen < minutes * 60_000 + 75_000 });
  }
  await setEnvironment({ containerIdleMinutes: 2 });
  await writeEvidence("idle.json", { workspace: WORKSPACE, note: "idleSeenMs: from the last command to the first poll (every 5 s) that saw the Container stopped", cases, ok: cases.every((entry) => entry.ok) });
};

/** The longest refusal reason in a refused start's answer: computer cuts its own messages, the causes keep it whole. */
const refusalIn = (text: string): string | undefined =>
  [...text.matchAll(/the Container cannot start: ([^"\\]+)/g)].map((match) => match[1]!).sort((a, b) => b.length - a.length)[0];

const budget = async () => {
  cookie ||= await pair();
  const ids = ["penv-b1", "penv-b2", "penv-b3"];
  for (const id of ids) await ensureProject(cookie, id);
  for (const id of [...ids, WORKSPACE]) await stopOn(id);
  const cases: Array<Case> = [];
  const start = async (id: string) => {
    const answer = await callOn(id, { exec: { script: "true", timeoutMs: 180_000 } });
    const text = JSON.stringify(answer);
    return { ok: answer.status === 200 && answer.result?.exitCode === 0, status: answer.status, running: answer.container?.running ?? null, budget: answer.container?.launch?.budget ?? null, refusal: refusalIn(text) ?? (answer.status === 200 ? null : text.slice(0, 400)), raw: answer.status === 200 ? undefined : text.slice(0, 2000) };
  };
  // A holder busy with a command is never asked to give its slot up (review F7 asks idle holders only).
  const busy = (id: string, seconds: number) => void callOn(id, { exec: { script: `sleep ${seconds}`, timeoutMs: (seconds + 30) * 1000 } }).catch(() => undefined);
  const leases = async () => ((await admin("GET", "/_t3flare/agents/budget")).json?.leases ?? []).map((lease: any) => lease.workspace ?? lease.holder);

  await setEnvironment({ containerBudget: 1 });
  const first = await start("penv-b1");
  busy("penv-b1", 60);
  await sleep(2_000);
  const second = await start("penv-b2");
  cases.push({ name: "at a budget of 1, a second Workspace's start is refused, and the message names the budget", first, second, ok: first.ok && !second.ok && /Container budget \(1\)/.test(String(second.refusal)) && /harness#environment/.test(String(second.refusal)) });

  await setEnvironment({ containerBudget: 2 });
  const raised = await start("penv-b2");
  cases.push({ name: "raised to 2, it starts", raised, leases: await leases(), ok: raised.ok && raised.budget === 2 });

  await setEnvironment({ containerBudget: 1 });
  busy("penv-b1", 90);
  busy("penv-b2", 90);
  await sleep(2_000);
  const third = await start("penv-b3");
  const running = [await stateOf("penv-b1"), await stateOf("penv-b2")].map((row) => row?.running);
  cases.push({ name: "lowered to 1 with two running: neither stops, and a third start is refused", third, running, leases: await leases(), ok: !third.ok && /Container budget \(1\)/.test(String(third.refusal)) && /harness#environment/.test(String(third.refusal)) && running.every((value) => value === true) });

  await stopOn("penv-b1");
  const afterOne = await start("penv-b3");
  cases.push({ name: "one stopped: one still runs at a budget of 1, so the third is still refused", afterOne, leases: await leases(), ok: !afterOne.ok });
  await stopOn("penv-b2");
  const afterBoth = await start("penv-b3");
  cases.push({ name: "under the budget again: the third starts", afterBoth, leases: await leases(), ok: afterBoth.ok });

  for (const id of ids) await stopOn(id);
  await setEnvironment({ containerBudget: 3 });
  await writeEvidence("budget.json", { workspaces: ids, cases, ok: cases.every((entry) => entry.ok) });
};

const revisionsCase = async () => {
  const cases: Array<Case> = [];
  const before = await revisions();
  await setEnvironment({ containerIdleMinutes: 4 });
  const afterEnvironment = await revisions();
  cases.push({ name: "an Environment change moves only the Environment revision", before, after: afterEnvironment, ok: afterEnvironment.environment === before.environment + 1 && afterEnvironment.harness === before.harness });
  const harnessChange = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 2100 } });
  const afterHarness = await revisions();
  cases.push({ name: "a Harness change moves only the Harness revision", status: harnessChange.status, before: afterEnvironment, after: afterHarness, ok: afterHarness.harness === afterEnvironment.harness + 1 && afterHarness.environment === afterEnvironment.environment });
  const status = (await harness("GET", "/_t3flare/harness/api/status")).json;
  cases.push({ name: "Status shows both revisions and when a Workspace last took the Environment settings", status, ok: typeof status?.["Environment settings revision"] === "number" && typeof status?.["settings revision"] === "number" });
  await harness("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 2000 } });
  await setEnvironment({ containerIdleMinutes: 2 });
  await writeEvidence("revisions.json", { cases, ok: cases.every((entry) => entry.ok) });
};

const audit = async () => {
  const entries = ((await harness("GET", "/_t3flare/harness/api/audit")).json?.entries ?? []) as Array<any>;
  const environment = entries.filter((entry) => entry.entity === "environment");
  const old = entries.filter((entry) => entry.action === "extension.change" && entry.after?.settings?.inlineBudget === 2345);
  const cases: Array<Case> = [
    {
      name: "Environment changes carry entity environment, with the changed settings before and after",
      sample: environment.slice(0, 3),
      ok: environment.length > 0 && environment.every((entry) => entry.action === "environment.change" && entry.before !== undefined && entry.after !== undefined && Object.keys(entry.after).length > 0),
    },
    { name: "the entry written on main's deploy, without entity, reads as harness", entries: old, ok: old.length === 1 && old[0].entity === "harness" },
    { name: "every entry has an entity", entities: [...new Set(entries.map((entry) => entry.entity))], ok: entries.every((entry) => entry.entity === "harness" || entry.entity === "environment") },
  ];
  await writeEvidence("audit.json", { entries: entries.length, cases, ok: cases.every((entry) => entry.ok) });
};

const safety = async () => {
  const cases: Array<Case> = [];
  const url = (pathname: string) => new URL(pathname, T3);
  const get = await harness("GET", "/_t3flare/harness/api/environment");
  cases.push({ name: "service token + admin token reads the Environment settings", status: get.status, ok: get.status === 200 && typeof get.json?.revision === "number" });
  const before = get.json?.revision;
  const statuses = async (headers: Record<string, string>, post: boolean) =>
    (await fetch(url("/_t3flare/harness/api/environment"), { method: post ? "POST" : "GET", headers: { ...headers, ...(post ? { "content-type": "application/json" } : {}) }, ...(post ? { body: JSON.stringify({ settings: { containerSize: "standard-4" } }) } : {}), redirect: "manual" })).status;
  const bare = [await statuses({}, false), await statuses({}, true)];
  cases.push({ name: "no Access credentials (GET and a change): refused at the edge", statuses: bare, ok: bare.every((status) => [302, 401, 403].includes(status)) });
  const forged = [await statuses({ "cf-access-jwt-assertion": "e30.e30.e30" }, false), await statuses({ "cf-access-jwt-assertion": "e30.e30.e30" }, true)];
  cases.push({ name: "a forged Access assertion alone: refused at the edge", statuses: forged, ok: forged.every((status) => [302, 401, 403].includes(status)) });
  const noToken = [await statuses(accessHeaders, false), await statuses(accessHeaders, true)];
  cases.push({ name: "the service token without the admin token: refused", statuses: noToken, ok: noToken.every((status) => status === 404) });
  const crossOrigin = await harness("POST", "/_t3flare/harness/api/environment", { settings: { containerSize: "standard-4" } }, { origin: "https://evil.example" });
  const crossSite = await harness("POST", "/_t3flare/harness/api/environment", { settings: { containerSize: "standard-4" } }, { origin: url("/").origin, "sec-fetch-site": "cross-site" });
  const form = await harness("POST", "/_t3flare/harness/api/environment", "settings=standard-4", { "content-type": "application/x-www-form-urlencoded" });
  cases.push({ name: "a wrong Origin, a cross-site fetch and a form-encoded body: refused", statuses: [crossOrigin.status, crossSite.status, form.status], answers: [crossOrigin.json, crossSite.json, form.json], ok: [crossOrigin, crossSite, form].every((answer) => answer.status === 403) });
  const invalid = await harness("POST", "/_t3flare/harness/api/environment", { settings: { containerSize: "lite" } });
  cases.push({ name: "a size not offered: refused with the setting named", status: invalid.status, answer: invalid.json, ok: invalid.status === 400 });
  const after = (await harness("GET", "/_t3flare/harness/api/environment")).json?.revision;
  cases.push({ name: "nothing refused was stored", before, after, ok: before === after });
  await writeEvidence("safety.json", {
    note: "The CSRF token binds the owner's Access subject; a script's service token needs none (ADR-0026 §2) and the owner's assertion cannot be made from a script. The CSRF refusals are the unit tests' (apps/environment/test/environmentSettings.test.ts), as for m3-panel-safety.json.",
    cases,
    ok: cases.every((entry) => entry.ok),
  });
};

const browser = (...args: Array<string>) => {
  const result = spawnSync("agent-browser", ["--session", "penv", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
};

const shoot = async () => {
  // One Container running, so the section shows a holder beside the budget.
  await ready();
  await call({ exec: { script: "true", timeoutMs: 180_000 } });
  fs.mkdirSync(OUT, { recursive: true });
  const page = new URL("/_t3flare/harness", HARNESS).toString();
  for (const scheme of ["light", "dark"]) {
    for (const [name, width, height, scale] of [["desktop", 1280, 1100, 1], ["phone", 390, 844, 2]] as const) {
      browser("--headers", JSON.stringify(scriptHeaders), "--color-scheme", scheme, "open", page);
      browser("set", "viewport", String(width), String(height), String(scale));
      browser("set", "media", scheme);
      browser("open", page);
      browser("wait", "--load", "networkidle");
      browser("eval", `document.getElementById('environment').scrollIntoView()`);
      spawnSync("sleep", ["0.5"]);
      const file = path.join(OUT, `environment-${name}-${scheme}.png`);
      browser("screenshot", file);
      const widthOf = () => Number(/pixelWidth: (\d+)/.exec(spawnSync("sips", ["-g", "pixelWidth", file], { encoding: "utf8" }).stdout)?.[1]);
      if (widthOf() > 1400) spawnSync("sips", ["--resampleWidth", "1400", file], { stdio: "ignore" });
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
      browser("close");
    }
  }
};

const commands: Record<string, () => Promise<void> | void> = { "seed-old": seedOld, sizes, running, idle, budget, revisions: revisionsCase, audit, safety, shoot };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: penv.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
