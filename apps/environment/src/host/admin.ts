// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off extendsNativeError:off anyUnknownInErrorContext:off
// The admin routes (`/_t3flare/*`, ADR-0010). The Worker has verified the caller (Access assertion plus the
// admin token, ../access.ts) before forwarding; these never boot t3 unless the route is about booting it.
//
//   GET  /_t3flare/health                       boot record, safe mode, runtime, activity, alarm, SQL adapter
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
//   GET  /_t3flare/agents/router-trace?clear=1   the process router's recent commands (git, gh, missing binaries)
//   GET  /_t3flare/agents/workspaces            the Workspace registry, each with its Container's state
//   POST /_t3flare/agents/workspace-stop?id=<id>  stop a Workspace's Container now
//   POST /_t3flare/agents/workspace-remove?id=<id> forget a Workspace (its DO's files stay; tests and cleanup)
//   POST /_t3flare/agents/workspace-probe?id=<id>  the repo revision moves on a write and a delete (read cache check)
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
    alarm: alarm === null ? null : new Date(alarm).toISOString(),
    openWork: Idle.openWork(storage.sql, new Date()),
    nextDue: Idle.nextDue(storage.sql),
    sql: sqlStats,
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
        return json({
          workspaces: await Promise.all(
            records.map(async (record) => ({
              ...record,
              container: await workspaceRpc(record.id).containerState().catch((error: unknown) => ({ error: String(error) })),
              info: await workspaceRpc(record.id).info().catch((error: unknown) => ({ error: String(error) })),
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
        const before = (await rpc.info()).revision;
        await rpc.writeText(path, `probe ${Date.now()}\n`);
        const written = (await rpc.info()).revision;
        await rpc.writeText(path, `probe again ${Date.now()}\n`);
        const rewritten = (await rpc.info()).revision;
        await rpc.fs({ op: "remove", path, options: { force: true } });
        const removed = (await rpc.info()).revision;
        const outside = "/workspace/.t3flare/probe";
        await rpc.writeText(outside, "x");
        const outsideWrite = (await rpc.info()).revision;
        return json({ debug: await rpc.debugRevision(), before, written, rewritten, removed, outsideWrite, ok: before! < written! && written! < rewritten! && rewritten! < removed! && outsideWrite === removed });
      }
      case "POST /_t3flare/agents/workspace-remove": {
        const { environmentServices } = await import("../agents/bindings.ts");
        environmentServices().workspaces.remove(url.searchParams.get("id") ?? "");
        return json({ removed: true });
      }
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
