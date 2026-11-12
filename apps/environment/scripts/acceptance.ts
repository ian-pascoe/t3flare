// @effect-diagnostics globalJsonInEffect:off globalDateInEffect:off globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off cryptoRandomUUID:off
// The acceptance test (ADR-0017): a headless t3 client against a deployed stage (or local workerd).
//
//   T3_URL=https://… T3_BOOTSTRAP_TOKEN=… T3FLARE_ADMIN_TOKEN=… \
//   T3FLARE_ACCESS_CLIENT_ID=… T3FLARE_ACCESS_CLIENT_SECRET=… node scripts/acceptance.ts [--threads 12] [--runs 4] [--out file.json]
//
// 1. The admin guard: refused without the admin token, admitted with Access (service token) plus the token.
// 2. Auth: the descriptor reports `remote-reachable`; the bootstrap token is refused until pairing is armed,
//    pairs while armed (what the web client's /pair#token=… does), and is refused again once disarmed.
// 3. A stock-protocol client over /ws (t3's own WsRpcGroup): create a project and threads, list them, open one.
// 4. Turn-item fixtures written through t3's EventSink (admin route), then t3's heavy queries on them: the
//    thread window (bounded snapshot over HTTP and subscribeThread), the shell snapshot, and search.
// 5. t3's SQL client on DO SQLite (transaction rollback, >100 parameters), the SQL adapter's record (no
//    statement refused except t3's PRAGMAs), and the twice-in-one-isolate boot check.
// 6. With `--real-turn [--push]` (step 2a): a Durable agent turn on a fresh clone of the fixture (`lib/realTurn.ts`).
// 7. With `--terminal` and/or `--worktree` (step 2b): a terminal's echo, a worktree thread's setup script, its removal,
//    and the sweep's dry run (`lib/terminalWorktree.ts`).
// 8. With `--peer` (step 3): a Peer link from the harness, the forwarded launch and the link fence (`lib/peerAcceptance.ts`).
// 8b. With `--codex` and/or `--pi` (step 4a): a CLI agent's turn with approvals, resumed after its Container stopped,
//     the leak check and the key route (`lib/cliAcceptance.ts`).
// 9. With `--claude` and/or `--opencode` (step 4b): a turn with an approved edit and command, a plan turn that edits
//    nothing, and the leak check, on Claude Code or OpenCode in a Workspace's Container (`lib/acpAcceptance.ts`).
import { WsRpcGroup, WS_METHODS, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as fs from "node:fs";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};

const base = new URL(process.env.T3_URL ?? "http://localhost:8791");
const bootstrapToken = process.env.T3_BOOTSTRAP_TOKEN ?? "local-bootstrap-token-0123456789";
const adminToken = process.env.T3FLARE_ADMIN_TOKEN ?? "local-admin-token";
const threadCount = Number(arg("threads", "12"));
const runsPerThread = Number(arg("runs", "4"));
const outFile = process.argv.includes("--out") ? arg("out", "") : undefined;

const accessHeaders: Record<string, string> =
  process.env.T3FLARE_ACCESS_CLIENT_ID && process.env.T3FLARE_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET }
    : {};

const report: Record<string, unknown> = { url: base.origin, startedAt: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
  return ok;
};
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

const admin = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(new URL(pathname, base), {
    method,
    redirect: "manual",
    headers: {
      ...accessHeaders,
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

const pair = async () => {
  const response = await fetch(new URL("/api/auth/browser-session", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base.origin },
    body: JSON.stringify({ credential: bootstrapToken }),
  });
  return { status: response.status, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), body: await response.text() };
};

// 1. The admin guard.
const noToken = await admin("GET", "/_t3flare/health", undefined, { authorization: "Bearer wrong" });
const health0 = await admin("GET", "/_t3flare/health");
report.adminGuard = { wrongToken: noToken.status, withAccessAndToken: health0.status, build: health0.json?.build };
check("admin refused with a wrong token", noToken.status === 404 || noToken.status === 403 || noToken.status === 302, noToken.status);
if (!check("admin health admitted", health0.status === 200, health0)) {
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

// 2. Auth.
const descriptor = (await (await fetch(new URL("/.well-known/t3/environment", base))).json()) as Record<string, any>;
const session = (await (await fetch(new URL("/api/auth/session", base))).json()) as Record<string, any>;
report.auth = { machine: descriptor.platform?.machine, label: descriptor.label, policy: session.auth?.policy };
check("auth descriptor remote-reachable", session.auth?.policy === "remote-reachable", session.auth);
await admin("POST", "/_t3flare/disarm-bootstrap");
const refusedBefore = await pair();
check("bootstrap refused while disarmed", refusedBefore.status === 401, refusedBefore.status);
const armed = await admin("POST", "/_t3flare/arm-bootstrap?minutes=10");
const paired = await pair();
report.pairing = { refusedBeforeArming: refusedBefore.status, armedUntil: armed.json?.armedUntil, paired: paired.status, ms: ms() };
if (!check("pairs while armed", paired.status === 200, paired.body.slice(0, 300))) {
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
const cookie = paired.cookie;

// 3–4. A client over /ws.
const socketUrl = new URL("/ws?orchestrationProtocol=2", base);
socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const layerProtocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false })).pipe(
  Layer.provide(
    Layer.mergeAll(
      Socket.layerWebSocket(socketUrl.toString()).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) =>
            // Bun's WebSocket takes handshake headers: the session cookie and the page origin.
            new WebSocket(url, { headers: { cookie, origin: base.origin } } as never),
          ),
        ),
      ),
      RpcSerialization.layerJson,
    ),
  ),
);

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.runHead(stream).pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
  );

const uuid = () => crypto.randomUUID();
const stamp = Date.now().toString(36);
const marker = `fixture${stamp}`;

/** Distinct fixture turn items named in a response. */
const fixtureItems = (text: string) => new Set(text.match(/item:fixture:[^"]+/g) ?? []).size;

const threadWindow = async (threadId: string) => {
  const started = performance.now();
  const response = await fetch(new URL(`/api/orchestration/threads/${threadId}/bounded`, base), {
    headers: { cookie, "x-t3-orchestration-protocol": "2" },
  });
  const text = await response.text();
  return { status: response.status, ms: Math.round(performance.now() - started), bytes: text.length, items: fixtureItems(text) };
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const config = yield* first(client[WS_METHODS.subscribeServerConfig]({}));
  check("subscribeServerConfig emits", config !== undefined);

  const projectId = uuid();
  yield* client[WS_METHODS.projectsMutate]({
    type: "project.create",
    commandId: uuid(),
    projectId,
    title: `acceptance-${stamp}`,
    workspaceRoot: `/t3/home/acceptance-${stamp}`,
    createWorkspaceRootIfMissing: true,
  } as never);
  const threadIds: Array<string> = [];
  yield* Effect.forEach(
    Array.from({ length: threadCount }, (_, i) => i),
    (i) => {
      const threadId = uuid();
      threadIds.push(threadId);
      return client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: uuid(),
        threadId,
        projectId,
        title: `acceptance ${stamp} ${i}`,
        modelSelection: { instanceId: "codex", model: "gpt-5.5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      } as never);
    },
    { concurrency: 6, discard: true },
  );
  report.project = { projectId, threads: threadIds.length, ms: ms() };
  return { projectId, threadIds };
});

const created = await Effect.runPromise(program.pipe(Effect.provide(layerProtocol), Effect.scoped));

// Fixtures through t3's EventSink.
const fixtures = await admin("POST", "/_t3flare/fixtures/turn-items", { threadIds: created.threadIds, runs: runsPerThread, marker });
report.fixtures = fixtures.json;
check("fixtures written", fixtures.status === 200 && fixtures.json?.turnItems === threadCount * runsPerThread * 5, fixtures.json);
if (fixtures.json?.eventSink === "fresh") {
  // A second EventSink instance bypasses the runtime's caches: restart t3 in place so it reads from SQL.
  await admin("POST", "/_t3flare/restart?mode=in-place");
}

// The heavy queries, on a fresh socket (as a client reconnecting after the fixtures).
const heavy = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const startedShell = performance.now();
  const shell = (yield* first(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}))) as any;
  const shellText = JSON.stringify(shell ?? {});
  const listed = created.threadIds.filter((id) => shellText.includes(id)).length;
  report.shellSnapshot = { ms: Math.round(performance.now() - startedShell), bytes: shellText.length, listedFixtureThreads: listed };
  check("shell snapshot lists every fixture thread", listed === created.threadIds.length, report.shellSnapshot);

  const windows = [];
  for (const threadId of created.threadIds) windows.push(yield* Effect.promise(() => threadWindow(threadId)));
  report.threadWindow = {
    threads: windows.length,
    allOk: windows.every((w) => w.status === 200),
    minItems: Math.min(...windows.map((w) => w.items)),
    maxMs: Math.max(...windows.map((w) => w.ms)),
    maxBytes: Math.max(...windows.map((w) => w.bytes)),
  };
  check("thread window (bounded snapshot) 200 with turn items", windows.every((w) => w.status === 200 && w.items > 0), windows.slice(0, 3));

  const target = created.threadIds[0]!;
  const startedThread = performance.now();
  const detail = yield* first(client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: target } as never));
  const detailText = JSON.stringify(detail ?? {});
  report.subscribeThread = { ms: Math.round(performance.now() - startedThread), bytes: detailText.length, items: fixtureItems(detailText) };
  check("subscribeThread emits with turn items", detail !== undefined && detailText.includes("item:fixture:"), report.subscribeThread);

  const startedSearch = performance.now();
  const search = (yield* client[ORCHESTRATION_V2_WS_METHODS.searchThreads]({ query: marker, limit: 50 } as never)) as any;
  const matches: Array<any> = search?.matches ?? [];
  report.search = { ms: Math.round(performance.now() - startedSearch), matches: matches.length, threads: new Set(matches.map((m) => m.threadId)).size };
  check("search finds the fixture messages", matches.length > 0, search);
  const inThread = (yield* client[ORCHESTRATION_V2_WS_METHODS.searchThread]({ threadId: target, query: marker } as never)) as any;
  report.searchThread = { ok: inThread !== undefined, bytes: JSON.stringify(inThread ?? {}).length };
});
const heavyExit = await Effect.runPromiseExit(heavy.pipe(Effect.provide(layerProtocol), Effect.scoped));
check("heavy queries ran", heavyExit._tag === "Success", heavyExit._tag === "Failure" ? String(heavyExit.cause) : undefined);

// 5. SQL, the adapter's record, the twice-boot check.
const sqlChecks = await admin("POST", "/_t3flare/check/sql");
report.sqlChecks = { transactionRollback: sqlChecks.json?.transactionRollback?.ok, overHundredParameters: sqlChecks.json?.overHundredParameters?.ok };
check("withTransaction rollback", sqlChecks.json?.transactionRollback?.ok === true, sqlChecks.json);
check("more than 100 parameters", sqlChecks.json?.overHundredParameters?.ok === true, sqlChecks.json);
const health = await admin("GET", "/_t3flare/health");
const sql = health.json?.sql ?? {};
const refused = (sql.errors ?? []).filter((e: { message: string }) => !e.message.includes("SQLITE_AUTH"));
report.sqlAdapter = { ...sql, errors: undefined, refusedStatements: refused.length, pragmaRefusals: (sql.errors ?? []).length - refused.length };
check("no statement refused by DO SQLite (t3's PRAGMAs aside)", refused.length === 0, refused);
const reboot = await admin("POST", "/_t3flare/check/reboot");
report.rebootCheck = reboot.json;
check("t3 boots twice in one isolate", reboot.json?.bothBootsServed === true && reboot.json?.sameEnvironmentId === true, reboot.json);

// 6. A real turn (step 2a): clone the fixture, edit and `bash test.sh` with approvals, the checkpoint; `--push` adds a PR.
if (process.argv.includes("--real-turn")) {
  const { realTurn } = await import("./lib/realTurn.ts");
  const real = await realTurn(cookie, { push: process.argv.includes("--push") });
  report.realTurn = real;
  for (const failure of real.failures) failures.push(`real turn: ${failure}`);
}

// 7. Terminals, worktree Workspaces and setup scripts (step 2b).
if (process.argv.includes("--terminal") || process.argv.includes("--worktree")) {
  const { terminalWorktree } = await import("./lib/terminalWorktree.ts");
  const result = await terminalWorktree(cookie, { terminal: process.argv.includes("--terminal"), worktree: process.argv.includes("--worktree") });
  report.step2b = result;
  for (const failure of result.failures) failures.push(`step 2b: ${failure}`);
}

// 8b. CLI agents (step 4a): a Codex and/or a Pi turn in a Workspace's Container, resumed after the Container stopped.
for (const cli of ["codex", "pi"] as const) {
  if (!process.argv.includes(`--${cli}`)) continue;
  const { cliAcceptance } = await import("./lib/cliAcceptance.ts");
  const result = await cliAcceptance(cookie, cli);
  report[cli] = result;
  for (const failure of result.failures) failures.push(`${cli}: ${failure}`);
}

// 8. Peer links and the link fence (step 3): the harness plays the laptop (`lib/peerAcceptance.ts`).
const peer = process.argv.includes("--peer");
if (peer) {
  const { bootstrapAtDecision, peerAcceptance } = await import("./lib/peerAcceptance.ts");
  const result = await peerAcceptance(cookie);
  report.peer = result;
  for (const failure of result.failures) failures.push(`peer: ${failure}`);
  const f11 = await bootstrapAtDecision(bootstrapToken, true);
  report.peerF11Armed = f11;
  check("F11: t3 alone refuses the bootstrap grant at /oauth/mcp/decision", f11.ok, f11);
}

// 9. Claude Code and OpenCode over ACP (step 4b).
for (const cli of ["claude", "opencode"] as const) {
  if (!process.argv.includes(`--${cli}`)) continue;
  const { acpAcceptance } = await import("./lib/acpAcceptance.ts");
  const result = await acpAcceptance(cookie, cli);
  report[cli] = result;
  for (const failure of result.failures) failures.push(`${cli}: ${failure}`);
}

// Disarm, and the bootstrap token is refused again.
await admin("POST", "/_t3flare/disarm-bootstrap");
const refusedAfter = await pair();
report.pairing = { ...(report.pairing as object), refusedAfterDisarming: refusedAfter.status };
check("bootstrap refused after disarming", refusedAfter.status === 401, refusedAfter.status);
if (peer) {
  const { bootstrapAtDecision } = await import("./lib/peerAcceptance.ts");
  const f11 = await bootstrapAtDecision(bootstrapToken, false);
  report.peerF11Disarmed = f11;
  check("F11: disarmed, the Environment DO refuses the bootstrap token at /oauth/mcp/decision", f11.ok, f11);
}

report.totalMs = ms();
report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
console.log(text);
if (outFile) fs.writeFileSync(outFile, `${text}\n`);
process.exit(report.ok ? 0 : 1);
