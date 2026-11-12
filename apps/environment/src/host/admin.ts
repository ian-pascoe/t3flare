// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off extendsNativeError:off anyUnknownInErrorContext:off
// The admin routes (`/_t3flare/*`, ADR-0010). The Worker has verified the caller (Access assertion plus the
// admin token, ../access.ts) before forwarding; these never boot t3 unless the route is about booting it.
//
//   GET  /_t3flare/health                       boot record, safe mode, runtime, activity, alarm, SQL adapter and row counters
//   POST /_t3flare/safe-mode?on=1|0             toggle safe mode by hand
//   POST /_t3flare/fault/boot-failures?count=N  make the next N boots fail (to prove automatic safe mode)
//   POST /_t3flare/sql                          read-only SQL: {"sql": "...", "params": [...]}
//   POST /_t3flare/arm-bootstrap?minutes=15     seed t3's bootstrap grant for a window (restarts t3 in place)
//   POST /_t3flare/disarm-bootstrap
//   POST /_t3flare/restart?mode=abort|in-place  reset the object (as an eviction does), or restart t3 only
//   POST /_t3flare/idle-check?force=1           run the idle check now (force: ignore the idle delay)
//   POST /_t3flare/check/reboot                 boot t3 twice in this isolate, report module state that survived
//   POST /_t3flare/check/sql                    withTransaction rollback and >100 parameters through t3's client
//   POST /_t3flare/fixtures/turn-items          {"threadIds": [...], "runs": 3, "marker": "..."}
//   POST /_t3flare/check/workspaces             step 2a M2: unlisted `/w` ids fail without touching a DO; `/w` lists the registry
//   POST /_t3flare/check/agents?budget=0|1      step 2a M0: the agents Worker both ways, Containers, paths, budget, token scope
//   GET  /_t3flare/agents/session?thread=<id>   a Session's state as it would push it (differ fixtures, diagnosis)
//   POST /_t3flare/agents/drop-turns?thread=<id> a test's fault: the Session forgets its turns (the inverse guard)
//   GET  /_t3flare/agents/session-diagnostics?thread=<id>  a Session's start and alarm counts
//   POST /_t3flare/agents/session-restart?thread=<id>  a test's fault: the Session DO restarts (as an eviction does)
//   POST /_t3flare/agents/proxy-fault?thread=<id> a test's fault (stages only; the Session refuses on prod): its model
//                                               requests get {"fixture","resetAt"}'s answer until that reset
//   GET  /_t3flare/agents/router-trace?clear=1   the process router's recent commands (git, gh, missing binaries)
//   GET  /_t3flare/agents/workspaces            the Workspace registry, each with its Container's and terminals' state
//   POST /_t3flare/agents/workspace-stop?id=<id>  stop a Workspace's Container now
//   POST /_t3flare/agents/workspace-remove?id=<id> purge a Workspace (step 2b: its DO's files with it; forced)
//   POST /_t3flare/agents/workspace-purge?id=<id>[&force=1]  step 2b: purge, refused while referenced unless forced
//   POST /_t3flare/agents/workspace-restore?id=<id> step 2b: a tombstone back to ready
//   GET  /_t3flare/agents/budget                step 2b: the Container budget's leases, by Workspace
//   GET  /_t3flare/agents/sweep[?dry=1]           step 2b: the Workspace sweep (dry: what it would do, with reasons)
//   POST /_t3flare/agents/workspace-probe?id=<id>  the repo revision moves on a write and a delete (read cache check)
//   POST /_t3flare/agents/workspace-workflows?id=<id>&on=1|0  the owner's opt-in to `workflows: write` on the Workspace's Container tokens
//   POST /_t3flare/agents/workspace-call?id=<id>   step 2a M3 checks: {"fs"|"git"|"checkpoint"|"exec"|"credentialHelper"|"killExecs": input} on the Workspace DO
//   GET  /_t3flare/agents/checkpoint-trace?clear=1 the checkpoint operations the Workspace DOs answered, and by which side
//   POST /_t3flare/check/connect-leak            step 3+: T3 Connect's secrets (names only) found in {"text"} (Workers Logs)
//   POST /_t3flare/check/peer-leak               step 3: secrets (names only) in a Workspace's Container and Sessions' state
//   GET  /_t3flare/agents/session-tools?thread=<id>  step 3: the T3 tools a Session offers and those left out
//   POST /_t3flare/check/terminal-leak           step 2b: a terminal's `env` output compared with this Worker's binding values (names only)
//   POST /_t3flare/check/terminal-close-idle?thread=<id>  step 2b: t3's own `closeIdle` for a thread's terminals (as settling runs it)
//   /_t3flare/connect/*, POST /_t3flare/check/connect-refusals  step 3+: the T3 Connect link (connect/admin.ts)
//   POST /_t3flare/agents/process-check           step 4a (stages only): the probe through t3's spawner and the process channel
//   GET  /_t3flare/agents/process-state?id=<id>   step 4a: a Workspace's CLI processes and this instance's channel
import * as BootState from "./bootState.ts";
import * as Idle from "./idle.ts";
import * as ModuleState from "./moduleState.ts";
import { redactions } from "./redactingConsole.ts";
import { DEFAULT_ARM_MINUTES, type EnvironmentDO, SafeModeError, isolate } from "../environmentDO.ts";
import { sqlStats } from "../platform/sqlAdapter.ts";
import { spawnAttempts } from "../platform/services.ts";
import * as StateStore from "../platform/stateStore.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json" } });

/** Declared by the build (build.ts `define`): which t3 nightly and which commit of ours this bundle is. */
declare const __T3FLARE_BUILD__: { readonly t3: string; readonly commit: string; readonly builtAt: string } | undefined;
const build = typeof __T3FLARE_BUILD__ === "undefined" ? null : __T3FLARE_BUILD__;

class ReadOnlyRollback extends Error {}

/** Runs one statement and rolls back whatever it wrote: DO SQLite has no read-only connection. */
const readOnlySql = (environment: EnvironmentDO, query: string, params: ReadonlyArray<unknown>) => {
  const statement = query.trim().replace(/;\s*$/, "");
  if (statement.includes(";")) throw new Error("One statement only");
  if (!/^(SELECT|WITH|EXPLAIN|PRAGMA\s+(table_info|table_list|index_list|index_info))\b/i.test(statement)) {
    throw new Error("Read-only: SELECT, WITH, EXPLAIN or schema PRAGMAs");
  }
  let result: { columns: Array<string>; rows: Array<Array<unknown>> } | undefined;
  try {
    environment.ctxStorage.transactionSync(() => {
      const cursor = environment.ctxStorage.sql.exec(statement, ...params);
      result = { columns: cursor.columnNames, rows: Array.from(cursor.raw()).slice(0, 1000) as Array<Array<unknown>> };
      throw new ReadOnlyRollback();
    });
  } catch (error) {
    if (!(error instanceof ReadOnlyRollback)) throw error;
  }
  return result!;
};

/** The health route shows an unreadable idle query (fragility U2) as its error rather than failing. */
const unreadableAsError = <A>(read: () => A): A | { readonly unreadable: string } => {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Idle.UnreadableTables)) throw error;
    return { unreadable: error.message };
  }
};

const health = async (environment: EnvironmentDO) => {
  const storage = environment.ctxStorage;
  const runtime = environment.runtimeIfBooted === undefined ? undefined : await environment.runtimeIfBooted.catch(() => null);
  const alarm = await storage.getAlarm();
  return {
    build,
    safeMode: await BootState.readSafeMode(storage),
    bootRecord: await BootState.readBootRecord(storage),
    runtime: runtime === undefined ? "stopped" : runtime === null ? "failed" : "running",
    lastBoot: environment.lastBoot ?? null,
    bootstrap: { armedUntil: (await environment.armedUntil())?.toISOString() ?? null, armed: await environment.isArmed() },
    isolate: { ...isolate, startedAt: new Date(isolate.startedAt).toISOString() },
    object: { constructedAt: new Date(environment.constructedAt).toISOString() },
    activity: { ...Idle.activity, idleSince: new Date(Idle.activity.idleSince).toISOString() },
    holds: Object.fromEntries([...Idle.holds].map(([name, { until, capped }]) => [name, { until: new Date(until).toISOString(), capped }])),
    alarm: alarm === null ? null : new Date(alarm).toISOString(),
    openWork: unreadableAsError(() => Idle.openWork(storage.sql, new Date())),
    nextDue: unreadableAsError(() => Idle.nextDue(storage.sql)),
    // The rows are t3's statements through the adapter since `isolate.startedAt` (cost audit F2).
    sql: { ...sqlStats, databaseSize: storage.sql.databaseSize },
    stateDirectory: StateStore.usage(),
    redactions,
    spawnAttempts: Object.fromEntries(spawnAttempts),
  };
};

const rebootCheck = async (environment: EnvironmentDO, request: Request) => {
  const before = new Set(ModuleState.globalKeys());
  const first = await environment.boot("check-reboot", request);
  const probe = async (runtime: typeof first) => {
    const response = await runtime.fetch(new Request(new URL("/.well-known/t3/environment", request.url)));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const firstProbe = await probe(first);
  const afterFirst = ModuleState.changedSinceEvaluation();
  await environment.stopRuntime();
  const second = await environment.boot("check-reboot-second");
  const secondProbe = await probe(second);
  const afterSecond = ModuleState.changedSinceEvaluation();
  const globalsAdded = ModuleState.globalKeys().filter((key) => !before.has(key));
  return {
    registered: ModuleState.registeredCount(),
    bothBootsServed: firstProbe.status === 200 && secondProbe.status === 200,
    sameEnvironmentId: firstProbe.body.environmentId === secondProbe.body.environmentId,
    isolateBoots: isolate.boots,
    // What survived: module bindings that differ from their state at module evaluation after the second boot.
    survivedIntoSecondBoot: afterSecond,
    changedAfterFirstBoot: afterFirst.length,
    globalsAddedDuringCheck: globalsAdded,
    // Step 4a (review F6): the process channel's handles and pids belong to this object, not to module state.
    processChannelOnInstance: (await import("../agents/bindings.ts")).environmentServices().processes === environment.processChannel,
  };
};

const sqlCheck = async (environment: EnvironmentDO, request: Request) => {
  const runtime = await environment.boot("check-sql", request);
  const { sqlChecks } = await import("./checks.ts");
  return runtime.run(sqlChecks);
};

/** The chain of `cause`s under an error, as text: t3's tagged errors wrap the SQL or schema error that matters. */
const causesOf = (error: unknown): Array<string> => {
  const out: Array<string> = [];
  let current = (error as { cause?: unknown })?.cause;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
    const message = (current as { message?: unknown }).message;
    let text: string;
    try {
      text = typeof message === "string" ? message : (JSON.stringify(current) ?? "");
    } catch {
      text = "unprintable cause";
    }
    out.push(text.slice(0, 2000));
    current = (current as { cause?: unknown }).cause;
  }
  return out;
};

export const handleAdmin = async (request: Request, environment: EnvironmentDO): Promise<Response> => {
  const url = new URL(request.url);
  const storage = environment.ctxStorage;
  const route = `${request.method} ${url.pathname}`;
  try {
    // Step 3+: the T3 Connect routes (connect/admin.ts), loaded only when called.
    if (url.pathname.startsWith("/_t3flare/connect/") || route === "POST /_t3flare/check/connect-refusals") {
      const { handleConnectAdmin } = await import("../connect/admin.ts");
      return await handleConnectAdmin(request, environment);
    }
    switch (route) {
      case "GET /_t3flare/health":
        return json(await health(environment));
      case "POST /_t3flare/safe-mode": {
        const on = url.searchParams.get("on") === "1";
        const safeMode = await BootState.setSafeMode(storage, on, on ? "manual" : null, new Date());
        // Entering safe mode stops t3; leaving it lets the next request boot it.
        if (on) await environment.stopRuntime();
        return json({ safeMode });
      }
      case "POST /_t3flare/fault/boot-failures": {
        const count = Number(url.searchParams.get("count") ?? "0");
        await BootState.injectBootFailures(storage, count);
        await environment.stopRuntime();
        return json({ injected: count });
      }
      case "POST /_t3flare/sql": {
        const body = (await request.json()) as { sql?: string; params?: Array<unknown> };
        if (typeof body.sql !== "string") return json({ error: "sql is required" }, 400);
        return json(readOnlySql(environment, body.sql, body.params ?? []));
      }
      case "POST /_t3flare/arm-bootstrap": {
        const minutes = Number(url.searchParams.get("minutes") ?? DEFAULT_ARM_MINUTES);
        const until = await environment.arm(Number.isFinite(minutes) ? minutes : DEFAULT_ARM_MINUTES);
        console.log(JSON.stringify({ t3flare: "bootstrap-armed", until: until.toISOString() }));
        return json({ armedUntil: until.toISOString() });
      }
      case "POST /_t3flare/disarm-bootstrap":
        await environment.disarm();
        return json({ armed: false });
      case "POST /_t3flare/restart": {
        if (url.searchParams.get("mode") === "in-place") {
          await environment.restartRuntime("admin-restart");
          return json({ restarted: "in-place", lastBoot: environment.lastBoot });
        }
        // As an eviction or deploy does: memory and sockets go, storage stays. After the response.
        setTimeout(() => environment.abort("t3flare: restart requested"), 0);
        return json({ restarted: "abort" });
      }
      case "POST /_t3flare/idle-check":
        return json(await environment.checkIdle({ force: url.searchParams.get("force") === "1" }));
      case "POST /_t3flare/check/reboot":
        return json(await rebootCheck(environment, request));
      case "POST /_t3flare/check/sql":
        return json(await sqlCheck(environment, request));
      case "GET /_t3flare/agents/session": {
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").snapshot({}));
      }
      case "POST /_t3flare/agents/drop-turns": {
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").dropTurns());
      }
      case "GET /_t3flare/agents/session-diagnostics": {
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").diagnostics());
      }
      case "POST /_t3flare/agents/session-restart": {
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").restart());
      }
      case "POST /_t3flare/agents/proxy-fault": {
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        const body = (await request.json()) as { fixture: string; resetAt: number };
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").proxyFault(body));
      }
      case "GET /_t3flare/agents/router-trace": {
        const { routerTrace, clearRouterTrace } = await import("../agents/processRouter.ts");
        const entries = routerTrace();
        const { workspacePathAccesses } = await import("../platform/stateStore.ts");
        if (url.searchParams.get("clear") === "1") clearRouterTrace();
        return json({ entries, nodeFsWorkspacePaths: workspacePathAccesses() });
      }
      case "GET /_t3flare/agents/workspaces": {
        const { environmentServices } = await import("../agents/bindings.ts");
        const { workspaceRpc } = await import("../agents/workspaceClient.ts");
        const records = environmentServices().workspaces.list();
        const { referencesFrom } = await import("../agents/deletion.ts");
        let references: ReadonlyMap<string, ReadonlyArray<string>> = new Map();
        try {
          references = referencesFrom(environmentServices().sql).byWorkspace;
        } catch {
          // t3's tables not there yet
        }
        return json({
          workspaces: await Promise.all(
            records.map(async (record) => ({
              ...record,
              references: references.get(record.id) ?? [],
              container: await workspaceRpc(record.id).containerState().catch((error: unknown) => ({ error: String(error) })),
              info: await workspaceRpc(record.id).info().catch((error: unknown) => ({ error: String(error) })),
              terminals: await workspaceRpc(record.id).terminalState().catch((error: unknown) => ({ error: String(error) })),
            })),
          ),
        });
      }
      case "POST /_t3flare/agents/workspace-stop": {
        const { workspaceRpc } = await import("../agents/workspaceClient.ts");
        await workspaceRpc(url.searchParams.get("id") ?? "").stopContainer();
        return json({ stopped: true });
      }
      case "POST /_t3flare/agents/workspace-probe": {
        const { workspaceRpc } = await import("../agents/workspaceClient.ts");
        const rpc = workspaceRpc(url.searchParams.get("id") ?? "");
        const path = "/workspace/repo/.t3flare-probe";
        const first = await rpc.info();
        const before = first.revision;
        await rpc.writeText(path, `probe ${Date.now()}\n`);
        const afterWrite = await rpc.info();
        const written = afterWrite.revision;
        const gitDirUnmoved = first.gitRevision === afterWrite.gitRevision;
        await rpc.writeText(path, `probe again ${Date.now()}\n`);
        const rewritten = (await rpc.info()).revision;
        await rpc.fs({ op: "remove", path, options: { force: true } });
        const removed = (await rpc.info()).revision;
        const outside = "/workspace/.t3flare/probe";
        await rpc.writeText(outside, "x");
        const outsideWrite = (await rpc.info()).revision;
        return json({
          before,
          written,
          rewritten,
          removed,
          outsideWrite,
          gitRevision: { before: first.gitRevision, afterWrite: afterWrite.gitRevision },
          ok: before! < written! && written! < rewritten! && rewritten! < removed! && outsideWrite === removed && gitDirUnmoved,
        });
      }
      case "POST /_t3flare/agents/workspace-workflows": {
        const { environmentServices } = await import("../agents/bindings.ts");
        const id = url.searchParams.get("id") ?? "";
        environmentServices().workspaces.setWorkflows(id, url.searchParams.get("on") === "1");
        return json(environmentServices().workspaces.get(id) ?? { error: "no such Workspace" });
      }
      case "POST /_t3flare/agents/workspace-call": {
        const { workspaceRpc } = await import("../agents/workspaceClient.ts");
        const rpc = workspaceRpc(url.searchParams.get("id") ?? "");
        const body = (await request.json()) as Record<string, unknown>;
        const started = Date.now();
        const result =
          "fs" in body
            ? await rpc.fs(body.fs as never)
            : "git" in body
              ? await rpc.git(body.git as never)
              : "checkpoint" in body
                ? await rpc.checkpoint(body.checkpoint as never)
                : "exec" in body
                  ? await rpc.exec(body.exec as never)
                  : "credentialHelper" in body
                    ? await rpc.ensureCredentialHelper(url.searchParams.get("id") ?? "")
                    : "killExecs" in body
                      ? await rpc.killExecs(body.killExecs as never)
                      : "probeProcess" in body
                        ? await rpc.probeProcess(body.probeProcess as never)
                        : { error: "one of fs, git, checkpoint, exec, credentialHelper, killExecs, probeProcess" };
        return json({ ms: Date.now() - started, result, container: await rpc.containerState() });
      }
      case "POST /_t3flare/check/connect-leak": {
        // Step 3+: which T3 Connect secrets (names only) appear in text the caller collected, such as Workers Logs.
        const { connectSecrets, leakedIn } = await import("./peerLeak.ts");
        const body = (await request.json()) as { text?: string };
        const runtime = await environment.boot("check-connect-leak", request);
        const secrets = await runtime.run(connectSecrets);
        return json({ checked: secrets.map(({ name }) => name), bytes: (body.text ?? "").length, leaked: leakedIn(body.text ?? "", secrets) });
      }
      case "POST /_t3flare/agents/process-check": {
        const { environmentServices } = await import("../agents/bindings.ts");
        if (!environmentServices().faults) return json({ error: "stages only" }, 403);
        const { processCheck, releaseHeld } = await import("./processCheck.ts");
        const body = (await request.json()) as { op: string; workspace: string; marker?: string; roundTrips?: number };
        if (body.op === "release") return json({ released: await releaseHeld() });
        return json(await processCheck(body));
      }
      case "GET /_t3flare/agents/process-state": {
        const { workspaceRpc } = await import("../agents/workspaceClient.ts");
        const id = url.searchParams.get("id") ?? "";
        return json({ channel: { live: environment.processChannel.size, environmentEpoch: environment.processChannel.environmentEpoch }, workspace: id === "" ? null : await workspaceRpc(id).processState() });
      }
      case "POST /_t3flare/check/peer-leak": {
        // Step 3 (plan section 4.6, review C8): after turns that called t3's tools and answered linked work, look for
        // every secret this Environment knows (its string bindings, its live GitHub tokens, t3's MCP credential of each
        // named thread, and values the harness adds, such as the link's token) in the Workspace's Container (`env`,
        // every `/proc/*/environ`, the files of /workspace, /tmp and home) and in each Session's snapshot (the state
        // its pushes carry, and `/_t3flare/agents/session`). Answers names and sizes only, never a value.
        const body = (await request.json()) as {
          readonly workspace: string;
          readonly threads: ReadonlyArray<string>;
          readonly extra?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
        };
        const { peerLeakCheck } = await import("./peerLeak.ts");
        return json(await peerLeakCheck(environment, body));
      }
      case "GET /_t3flare/agents/session-tools": {
        // Step 3: the T3 tools a Session offers (names only), and those its catalog left out.
        const { byName } = await import("../agents/rpc.ts");
        const thread = url.searchParams.get("thread") ?? "";
        return json(await byName(environment.agents.SESSIONS, `thread:${thread}`, "SESSIONS").t3Tools());
      }
      case "POST /_t3flare/check/terminal-leak": {
        // Step 2b M1 (review F0): a terminal's `env` output, posted by the evidence script, compared here with the values
        // of this Worker's string bindings (secrets included). Answers names only, never a value.
        const { text } = (await request.json()) as { readonly text: string };
        const env = (environment as unknown as { readonly env: Record<string, unknown> }).env;
        const checked: Array<string> = [];
        const leaked: Array<string> = [];
        for (const [name, value] of Object.entries(env)) {
          if (typeof value !== "string" || value.length < 8) continue;
          checked.push(name);
          if (text.includes(value) || value.split("\n").some((line) => line.length >= 16 && text.includes(line))) leaked.push(name);
        }
        const processEnv = Object.keys((globalThis as { process?: { env?: object } }).process?.env ?? {});
        return json({ checked: checked.toSorted(), leaked, processEnvKeys: processEnv.toSorted() });
      }
      case "POST /_t3flare/check/terminal-close-idle": {
        // Step 2b M1 (review F1): t3's own `closeIdle` for a thread's terminals, as settling a thread runs it.
        const runtime = await environment.boot("admin-terminal-close-idle");
        const { closeIdleFor } = await import("../terminal/checks.ts");
        return json(await runtime.run(closeIdleFor(url.searchParams.get("thread") ?? "")));
      }
      case "GET /_t3flare/agents/checkpoint-trace": {
        const { checkpointTrace } = await import("../workspace/checkpoints.ts");
        const entries = [...checkpointTrace];
        if (url.searchParams.get("clear") === "1") checkpointTrace.length = 0;
        return json({ entries });
      }
      case "POST /_t3flare/agents/workspace-remove":
      case "POST /_t3flare/agents/workspace-purge": {
        // Step 2b: a purge (the DO's files with it), refused while referenced unless `force=1`; `workspace-remove`
        // (step 2a's, which left the files) is a forced purge now.
        const { environmentServices } = await import("../agents/bindings.ts");
        const { purgeWorkspace, referencesFrom } = await import("../agents/deletion.ts");
        const id = url.searchParams.get("id") ?? "";
        if (environmentServices().workspaces.get(id) === undefined) return json({ error: "no such Workspace" }, 404);
        const references = referencesFrom(environmentServices().sql);
        const why = references.byWorkspace.get(id);
        const force = url.searchParams.get("force") === "1" || url.pathname.endsWith("workspace-remove");
        if (why !== undefined && !force) return json({ refused: true, references: why }, 409);
        return json(await purgeWorkspace(id, references.deletedThreads.get(id) ?? []));
      }
      case "POST /_t3flare/agents/workspace-restore": {
        const { restoreWorkspace } = await import("../agents/deletion.ts");
        const restored = restoreWorkspace(url.searchParams.get("id") ?? "");
        return restored === undefined ? json({ error: "not a tombstone" }, 409) : json({ restored });
      }
      case "GET /_t3flare/agents/budget": {
        // Step 2b: the Container budget's leases, and which Workspace each holder is (DO ids in hex).
        const { environmentServices } = await import("../agents/bindings.ts");
        const { byName } = await import("../agents/rpc.ts");
        const services = environmentServices();
        const state = await byName(services.agents.CONTAINER_BUDGET, "budget", "CONTAINER_BUDGET").state();
        const names = new Map(services.workspaces.list().map((ws) => [String(services.agents.WORKSPACES?.idFromName(ws.id)), ws.id]));
        return json({ ...state, leases: state.leases.map((lease) => ({ ...lease, workspace: names.get(lease.holder) ?? null })) });
      }
      case "GET /_t3flare/agents/sweep":
      case "POST /_t3flare/agents/sweep":
        // `dry=1` reports what it would do; a run on a stage without T3FLARE_SWEEP_PURGE=1 (prod) is a dry run anyway.
        return json({ report: await environment.runSweep({ dry: url.searchParams.get("dry") === "1" }), last: environment.lastSweep });
      case "POST /_t3flare/check/workspaces": {
        const { workspacesCheck } = await import("./workspacesCheck.ts");
        return json(await workspacesCheck());
      }
      case "POST /_t3flare/check/agents": {
        const { agentsCheck } = await import("./agentsCheck.ts");
        return json(await agentsCheck(environment, request));
      }
      case "POST /_t3flare/fixtures/turn-items": {
        const body = (await request.json()) as { threadIds?: Array<string>; runs?: number; marker?: string };
        const runtime = await environment.boot("fixtures", request);
        const { writeFixtures } = await import("./fixtures.ts");
        const report = await writeFixtures(runtime, {
          threadIds: body.threadIds ?? [],
          runs: Math.min(Math.max(body.runs ?? 3, 1), 50),
          marker: body.marker ?? "t3flare-fixture",
        });
        return json(report);
      }
      default:
        return new Response("Not found\n", { status: 404 });
    }
  } catch (error) {
    if (error instanceof SafeModeError) return json({ error: error.message, safeMode: error.safeMode }, 503);
    return json({ error: String(error), causes: causesOf(error), stack: (error as Error)?.stack?.split("\n").slice(0, 8) }, 500);
  }
};
