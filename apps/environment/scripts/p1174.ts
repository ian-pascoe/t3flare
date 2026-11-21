// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off anyUnknownInErrorContext:off
// SPI-1174's evidence on its stage: t3's limit meters for subscription endpoints, from the limit headers of their answers.
//
//   T3FLARE_PROBE=1 node scripts/stage.ts deploy p1174
//   node scripts/stage.ts run p1174 p1174 [--out ../../.evidence/spi-1174/p1174.json] [--stale-wait-min 31]
//
// No subscription is signed in (the owner's decision): the stage's probe Worker stands in for both vendors. Its Anthropic
// Messages stand-in answers with Claude's unified limit headers (five-hour share growing with each request, seven-day
// 30 %), its OpenAI Responses stand-in with ChatGPT's Codex ones (primary growing, secondary 30 %), each in the vendor's
// own shape (`@t3flare/models/limits`). Two endpoints on the probe key: `standin-anth` and `standin-resp`.
//
// 1. Before any answer: no meter of ours.
// 2. A Durable turn on `standin-anth` (the Session reads the headers): a Claude meter under the endpoint's label.
// 3. A Claude Code turn on `standin-anth`, model-routed through the model relay: the same meter, read later, its
//    five-hour share moved on.
// 4. A Codex turn on `standin-resp` through the relay: a ChatGPT (Codex) meter, primary and secondary.
// 5. Nothing more for `--stale-wait-min` minutes: each meter says when it was last read, from the Environment's kept
//    readings (the Environment may have been evicted meanwhile: they are in its SQLite).
//
// t3's limit sources are read as its web client reads them (`subscribeServerConfig` with `usageLimitSources`). Every
// answer kept is scanned for the probe key, and the sources for anything shaped like a token, an email or an org id.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";

import { cliTurn as acpTurn, enable as enableAcp } from "./lib/acpTurn.ts";
import { admin, base, createProjectAndThread, pair, projectionOf, protocol, runsOf, sendMessage, SETTLED, sleep, threadWindow, wsCall } from "./lib/client.ts";
import { cliTurn } from "./lib/cliTurn.ts";
import { workersDevUrl } from "./lib/scriptSettings.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const staleWaitMin = Number(option("stale-wait-min") ?? "31");
const probeKey = process.env.T3FLARE_PROBE_KEY ?? "";
const stage = base.hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
const PROBE = workersDevUrl(`t3flare-probe-${stage}`);
const secrets = [probeKey].filter((value) => value.length >= 8);
const failures: Array<string> = [];
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const report: Record<string, unknown> = { at: new Date().toISOString(), head };
const check = (name: string, ok: boolean, detail?: unknown) => {
  report.checks = [...((report.checks as Array<unknown>) ?? []), { name, ok }];
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 800)}`);
  return ok;
};
const clean = <T>(value: T): T => {
  const text = JSON.stringify(value) ?? "";
  for (const secret of secrets) if (text.includes(secret)) throw new Error("a key reached an answer kept as evidence");
  return value;
};
const finish = (): never => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(clean(report), null, 2);
  console.log(text.slice(0, 30_000));
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};
const api = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/settings/api/${pathname}`, body);

// `--scan <dir>`: the leak scan of the evidence (every file in `dir`) for the stage's own secrets, which only this run's
// environment holds; it prints only which secret names matched where, never a value.
const scanDir = option("scan");
if (scanDir !== undefined) {
  const named = Object.entries({
    probeKey,
    adminToken: process.env.T3FLARE_ADMIN_TOKEN ?? "",
    bootstrapToken: process.env.T3_BOOTSTRAP_TOKEN ?? "",
    accessSecret: process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
  }).filter(([, value]) => value.length >= 8);
  const shapes: ReadonlyArray<readonly [string, RegExp]> = [
    ["a token shape", /sk-ant-[a-z0-9]|sk-proj-|eyJhbGci|Bearer [A-Za-z0-9._-]{20,}/],
    // A Cloudflare account id (32 hex digits, as alchemy logs it in `registry.cloudflare.com/<id>/…`), either case.
    ["an account id shape", /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i],
    ["a home directory path", /\/Users\/|\/home\/[a-z]/],
    ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ];
  /** Every file under `dir`, its subdirectories included, by its path below `dir`. */
  const walk = (dir: string, below = ""): ReadonlyArray<string> =>
    fs.readdirSync(`${dir}/${below}`, { withFileTypes: true }).flatMap((entry) => {
      const path = below === "" ? entry.name : `${below}/${entry.name}`;
      return entry.isDirectory() ? walk(dir, path) : entry.isFile() ? [path] : [];
    });
  // Images (the page's screenshots) are not text: they are skipped, and were looked at by eye.
  const BINARY = /\.(?:png|jpe?g|gif|webp)$/i;
  const all = [...walk(scanDir)].sort();
  const files = all.filter((name) => !BINARY.test(name));
  const hits = files.flatMap((name) => {
    const text = fs.readFileSync(`${scanDir}/${name}`, "utf8");
    return [...named.filter(([, value]) => text.includes(value)).map(([key]) => `${name}: ${key}`), ...shapes.filter(([, shape]) => shape.test(text)).map(([what]) => `${name}: ${what}`)];
  });
  console.log(JSON.stringify({ scanned: files, skipped: { binary: all.filter((name) => BINARY.test(name)), note: "images, checked by eye" }, secrets: named.map(([key]) => key), hits }, null, 2));
  process.exit(hits.length === 0 ? 0 : 1);
}

if (probeKey === "") {
  failures.push("the stage needs its probe (deploy with T3FLARE_PROBE=1)");
  finish();
}

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

const OURS = "t3flare-endpoint-";

/** t3's limit sources as its web client gets them: the first `usageLimitSourcesUpdated` of a config subscription. */
const sourcesNow = async (): Promise<Array<any>> => {
  const event = await Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Stream.Stream<any, unknown>>;
      return yield* Stream.runHead(client[WS_METHODS.subscribeServerConfig]!({ usageLimitSources: true }).pipe(Stream.filter((item: any) => item?.type === "usageLimitSourcesUpdated")));
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped, Effect.timeout("30 seconds")),
  );
  return event._tag === "Some" ? ((event.value as any).payload?.sources ?? []) : [];
};
const ours = (sources: Array<any>) => sources.filter((source) => String(source.id).startsWith(OURS));
/** Waits until `ready` holds of our sources (the reading's send lands after the answer), at most `ms`. */
const sourcesWhen = async (ready: (sources: Array<any>) => boolean, ms = 60_000) => {
  const started = Date.now();
  let sources: Array<any> = [];
  while (Date.now() - started < ms) {
    sources = ours(await sourcesNow());
    if (ready(sources)) break;
    await sleep(2000);
  }
  return sources;
};
const sourceOf = (sources: Array<any>, endpoint: string) => sources.find((source) => source.id === `${OURS}${endpoint}`);
const windowOf = (source: any, id: string) => source?.accounts?.[0]?.usageLimits?.windows?.find((window: any) => window.id === id);
const hoursAhead = (iso: string | undefined) => (iso === undefined ? null : Math.round(((Date.parse(iso) - Date.now()) / 3_600_000) * 10) / 10);
const LEAK = /sk-[a-z0-9]|Bearer|eyJ[a-zA-Z0-9]|@[a-z0-9-]+\.[a-z]|org-|anthropic-organization/i;

// The endpoints: the stand-in's two APIs on the probe key, each serving one model.
const STANDIN_MODEL = "claude-fable-5-2";
const STANDIN_RESP_MODEL = "gpt-5.1-codex";
const saved = {
  anth: (await api("POST", "endpoints", { op: "save", endpoint: { id: "standin-anth", label: "Stand-in Claude plan", api: "anthropic-messages", baseUrl: `${PROBE}/relay`, auth: "api-key", headers: {}, models: [STANDIN_MODEL] }, apiKey: probeKey })).status,
  resp: (await api("POST", "endpoints", { op: "save", endpoint: { id: "standin-resp", label: "Stand-in ChatGPT plan", api: "openai-responses", baseUrl: `${PROBE}/relay/v1`, auth: "api-key", headers: {}, models: [STANDIN_RESP_MODEL] }, apiKey: probeKey })).status,
};
check("the two stand-in endpoints saved", saved.anth === 200 && saved.resp === 200, saved);
const SLUG = { anth: `standin-anth/${STANDIN_MODEL}`, resp: `standin-resp/${STANDIN_RESP_MODEL}` };
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });

const steps: Record<string, unknown> = {};
const snapshot = (sources: Array<any>) =>
  clean(
    sources.map((source) => ({
      id: source.id,
      label: source.label,
      checkedAt: source.checkedAt,
      error: source.error ?? null,
      accounts: source.accounts.map((account: any) => ({
        id: account.id,
        driver: account.driver,
        email: account.email ?? null,
        windows: account.usageLimits.windows.map((window: any) => ({ ...window, resetsInHours: hoursAhead(window.resetsAt) })),
      })),
    })),
  );

// 1. No meter of ours before any answer.
{
  const before = ours(await sourcesNow());
  steps.before = snapshot(before);
  check("before any answer: no meter of ours", before.length === 0, before);
}

// 2. A Durable turn on the Claude stand-in.
const run = Date.now().toString(36);
{
  const { threadId } = await createProjectAndThread(cookie, { title: "Limits", workspaceRoot: `/w/p1174-durable-${run}` });
  await sendMessage(cookie, threadId, "Reply with the single word: ready.", { instanceId: "piDurable", model: SLUG.anth, options: [] });
  const started = Date.now();
  let runs: Array<any> = [];
  while (Date.now() - started < 5 * 60_000) {
    runs = runsOf(projectionOf(await threadWindow(cookie, threadId)));
    if (runs.length >= 1 && runs.every((entry) => SETTLED.has(entry.status))) break;
    await sleep(1500);
  }
  check("a Durable turn on the Claude stand-in", runs.at(-1)?.status === "completed", runs);
  const sources = await sourcesWhen((list) => sourceOf(list, "standin-anth") !== undefined);
  const claude = sourceOf(sources, "standin-anth");
  steps.durable = { run: runs.at(-1)?.status, sources: snapshot(sources) };
  check("the Durable turn's answer shows a Claude meter under the endpoint's label", claude?.label === "Stand-in Claude plan" && claude?.accounts?.[0]?.driver === "claudeAgent", claude);
  const five = windowOf(claude, "five_hour");
  const seven = windowOf(claude, "seven_day");
  check(
    "its five-hour window: a plausible share and a reset about 2 h away; its weekly window 30 % and about 3 days away",
    five !== undefined && five.usedPercent > 0 && five.usedPercent < 100 && Math.abs(hoursAhead(five.resetsAt)! - 2) < 0.2 && five.label === "5-hour" && seven?.usedPercent === 30 && Math.abs(hoursAhead(seven.resetsAt)! - 72) < 0.2 && seven.label === "Weekly",
    claude,
  );
  check("fresh: no stale notice", claude?.error === undefined, claude);
}

// 3. A Claude Code turn on the same endpoint, through the relay: the meter is read again.
const durableClaude = sourceOf(ours(await sourcesNow()), "standin-anth");
{
  await enableAcp(cookie, "claude");
  await sleep(2000);
  const answer = await acpTurn(cookie, { cli: "claude", workspace: `limits-acp-${run}`, model: SLUG.anth, mode: "full-access", plan: false, prompt: "Reply with the single word: ready." });
  check("a Claude Code turn on the Claude stand-in, model-routed through the relay", answer.runs.at(-1)?.status === "completed", clean({ runs: answer.runs.slice(-1), text: answer.text }));
  const sources = await sourcesWhen((list) => Date.parse(sourceOf(list, "standin-anth")?.checkedAt ?? "0") > Date.parse(durableClaude?.checkedAt ?? "0"));
  const claude = sourceOf(sources, "standin-anth");
  steps.claudeCode = { run: answer.runs.at(-1)?.status, sources: snapshot(sources) };
  check(
    "the relayed CLI's answers update the same meter: read later, its five-hour share moved on",
    Date.parse(claude?.checkedAt ?? "0") > Date.parse(durableClaude?.checkedAt ?? "0") && windowOf(claude, "five_hour")?.usedPercent !== windowOf(durableClaude, "five_hour")?.usedPercent,
    { before: durableClaude, after: claude },
  );
}

// 4. A Codex turn on the ChatGPT stand-in, through the relay.
{
  const answer = await cliTurn(cookie, { cli: "codex", workspace: `limits-cli-${run}`, model: SLUG.resp, mode: "full-access", plan: false, prompt: "Reply with the single word: ready." });
  check("a Codex turn on the ChatGPT stand-in, through the relay", answer.runs.at(-1)?.status === "completed", clean({ runs: answer.runs.slice(-1), text: answer.text }));
  const sources = await sourcesWhen((list) => sourceOf(list, "standin-resp") !== undefined);
  const chatgpt = sourceOf(sources, "standin-resp");
  steps.codex = { run: answer.runs.at(-1)?.status, sources: snapshot(sources) };
  const primary = windowOf(chatgpt, "primary");
  const secondary = windowOf(chatgpt, "secondary");
  check(
    "a ChatGPT (Codex) meter: its 5-hour primary window with a plausible share and reset, its weekly secondary at 30 %",
    chatgpt?.accounts?.[0]?.driver === "codex" && primary?.label === "5-hour" && primary.kind === "session" && primary.usedPercent > 0 && primary.usedPercent < 100 && Math.abs(hoursAhead(primary.resetsAt)! - 2) < 0.2 && secondary?.label === "Weekly" && secondary.usedPercent === 30,
    chatgpt,
  );
}

const fresh = ours(await sourcesNow());
check("no token, email or organization in the meters", !LEAK.test(JSON.stringify(fresh)) && fresh.every((source) => source.accounts.every((account: any) => account.email === undefined)), fresh);

// 5. Stale: nothing more is asked of either endpoint for a while.
if (staleWaitMin > 0) {
  const lastRead = Math.max(...fresh.map((source) => Date.parse(source.checkedAt)));
  const waitMs = lastRead + staleWaitMin * 60_000 - Date.now();
  console.error(`waiting ${Math.round(waitMs / 60_000)} min for the meters to go stale…`);
  if (waitMs > 0) await sleep(waitMs);
  const stale = await sourcesWhen((list) => list.length === 2 && list.every((source) => typeof source.error === "string"), 3 * 60_000);
  steps.stale = { waitedMin: staleWaitMin, sources: snapshot(stale) };
  check(
    "a meter not read for a while says when it was last read, beside its windows",
    stale.length === 2 && stale.every((source) => /^Last read \d+ minutes ago \(limits are read from this endpoint's answers\)\.$/.test(source.error) && source.accounts[0].usageLimits.windows.length === 2),
    stale,
  );
}
report.steps = steps;
finish();
