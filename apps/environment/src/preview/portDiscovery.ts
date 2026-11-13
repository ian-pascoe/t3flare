// @effect-diagnostics globalDate:off globalConsole:off effectFnOpportunity:off
// t3's `PortDiscovery` for the Cloud Environment (G11's M2, ADR-0031): a Layer replacing stock `PortScanner.layer`, whose
// single-host model (one `/proc`, one pid space) does not fit up to three Containers.
//
// - **Where**: each Workspace whose Container runs now (the Container budget's leases) scans its own `/proc`
//   (`WorkspaceDO.listeners`, `@t3flare/sandbox-image/ports`). A stopped Container contributes nothing and is never
//   started; a scan is not use, so it never holds an idle Container (review L9). Polling follows stock: every 3 s while a
//   client `retain`s, and never otherwise.
// - **Attribution, as stock lists only owned servers** (C1: stock's `servers.filter(isOwned)`): a listener whose process
//   carries a terminal's key (`term-<key>`, named by t3's `registerTerminalProcesses`) is that terminal's; one carrying a
//   CLI process's key (`proc-<uuid>`) or `T3CODE_THREAD_ID` (a Durable agent's commands) is that thread's agent's. Review
//   M7: a key or thread outside the scanned Workspace is ignored, so a process cannot claim another thread's server.
//   computerd and the image's daemons carry no marker and are never listed.
// - **Configured preview URLs** (stock takes only loopback ones) open at a listed server's port, or are probed once per
//   15 s on each running Container's port (`WorkspaceDO.probePort`: never a start, never use; review M4). Nothing is
//   fetched from this Worker.
// - **`stopServer`**: the (pid, port) must be listed in exactly one Workspace now; stock's `stoppableProcessGroup`, with
//   computerd as the server, refuses a group that holds a shell, a CLI agent or computerd (`shared-group`).
// - `registerTerminalProcesses`, `unregisterTerminal` and `trackAgent` are no-ops: the terminal layer names its shells'
//   owners itself, and attribution comes from markers, not pids.
import { CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS, type DiscoveredLocalServer, PREVIEW_URL_MAX_LENGTH, PreviewStopLocalServerError, ThreadId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { toWorkspace } from "@t3flare/workspace-client";
import type { PortScan, ScannedListener } from "@t3flare/sandbox-image/ports";
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as PortScanner from "t3/src/preview/PortScanner.ts";

import { environmentServices } from "../agents/bindings.ts";
import { byName } from "../agents/rpc.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import { currentTerminals } from "../terminal/current.ts";

/** computerd's own port: never a dev server's. */
const COMPUTERD_PORT = 8080;
const POLL_MS = 3_000;
const PROBE_CACHE_MS = 15_000;
const NAVIGATION_REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface Lookups {
  /** A live shell by key: its Workspace and t3's owner, if t3 named one. */
  readonly terminal: (key: string) => { readonly workspace: string; readonly owner: { readonly threadId: string; readonly terminalId: string } | undefined } | undefined;
  /** A live CLI process by key: its Workspace and thread. */
  readonly process: (key: string) => { readonly workspace: string; readonly thread: string | undefined } | undefined;
  /** The Workspace a thread works in (its worktree's, else its project's). */
  readonly threadWorkspace: (threadId: string) => string | undefined;
}

type Owner = Pick<DiscoveredLocalServer, "terminal" | "agent">;

const ownerOf = (workspace: string, listener: ScannedListener, lookups: Lookups): Owner | undefined => {
  const exec = listener.exec ?? "";
  if (exec.startsWith("term-")) {
    const shell = lookups.terminal(exec);
    if (shell?.workspace === workspace && shell.owner !== undefined) {
      return { terminal: { threadId: ThreadId.make(shell.owner.threadId), terminalId: shell.owner.terminalId }, agent: null };
    }
    return undefined;
  }
  if (exec.startsWith("proc-")) {
    const process = lookups.process(exec);
    const thread = process?.thread;
    if (process?.workspace === workspace && thread !== undefined && lookups.threadWorkspace(thread) === workspace) {
      return { terminal: null, agent: { threadId: ThreadId.make(thread) } };
    }
    return undefined;
  }
  const thread = listener.thread;
  if (thread !== null && thread.trim() !== "" && lookups.threadWorkspace(thread) === workspace) {
    return { terminal: null, agent: { threadId: ThreadId.make(thread) } };
  }
  return undefined;
};

/** The owned servers of one Workspace's scan, as stock lists them: one per port, unowned ones left out. */
export const serversOf = (workspace: string, scan: PortScan, lookups: Lookups): ReadonlyArray<DiscoveredLocalServer> => {
  const byPort = new Map<number, DiscoveredLocalServer>();
  for (const listener of scan.listeners) {
    if (listener.port === COMPUTERD_PORT || listener.pid === scan.computerd || byPort.has(listener.port)) continue;
    if (!Number.isInteger(listener.port) || listener.port <= 0 || listener.port > 65_535 || !Number.isInteger(listener.pid) || listener.pid <= 0) continue;
    const owner = ownerOf(workspace, listener, lookups);
    if (owner === undefined) continue;
    const name = listener.comm.trim().slice(0, 64);
    byPort.set(listener.port, {
      host: "localhost",
      port: listener.port,
      url: `http://localhost:${listener.port}`,
      processName: name === "" ? null : name,
      pid: listener.pid,
      ...owner,
    });
  }
  return [...byPort.values()].toSorted((left, right) => left.port - right.port);
};

/** Stock's configured-URL rules: loopback http(s) only, `0.0.0.0` read as `localhost`, bounded. */
export const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .flatMap((raw) => {
        try {
          const url = new URL(raw);
          if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) return [];
          if (url.hostname === "0.0.0.0") url.hostname = "localhost";
          return url.href.length <= PREVIEW_URL_MAX_LENGTH ? [url.href] : [];
        } catch {
          return [];
        }
      }),
  ),
];

const portOf = (url: URL) => (url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port));

/** The Workspace of a thread, from t3's projection: its worktree's, else its project's (as `deletion.ts` reads it). */
export const threadWorkspaceFrom = (sql: SqlStorage) => (threadId: string): string | undefined => {
  try {
    const row = sql
      .exec<{ worktree: string | null; root: string | null }>(
        "SELECT json_extract(t.payload_json, '$.worktreePath') AS worktree, p.workspace_root AS root FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id = t.project_id WHERE t.thread_id = ? AND t.deleted_at IS NULL",
        threadId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return (row.worktree ? toWorkspace(row.worktree)?.id : undefined) ?? (row.root ? toWorkspace(row.root)?.id : undefined);
  } catch {
    // A table t3 renamed: no attribution rather than a wrong one (fragility U60).
    return undefined;
  }
};

const lookups = (): Lookups => {
  const services = environmentServices();
  return {
    terminal: (key) => {
      const shell = currentTerminals()?.byKey(key);
      return shell === undefined ? undefined : { workspace: shell.place.workspace, owner: shell.owner };
    },
    process: (key) => services.processes.ownerOf(key),
    threadWorkspace: threadWorkspaceFrom(services.sql),
  };
};

/** The Workspaces whose Container runs now, from the budget's leases (no Container is started to learn it). */
const runningWorkspaces = async (): Promise<ReadonlyArray<string>> => {
  const services = environmentServices();
  if (services.agents.CONTAINER_BUDGET === undefined || services.agents.WORKSPACES === undefined) return [];
  const state = await byName(services.agents.CONTAINER_BUDGET, "budget", "CONTAINER_BUDGET").state();
  const names = new Map(services.workspaces.list().map((ws) => [String(services.agents.WORKSPACES?.idFromName(ws.id)), ws.id]));
  return state.leases.flatMap((lease) => {
    const id = names.get(lease.holder);
    return id === undefined ? [] : [id];
  });
};

interface Scanned {
  readonly workspace: string;
  readonly scan: PortScan;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
}

const scanWorkspace = async (workspace: string): Promise<Scanned | undefined> => {
  const answer = await workspaceRpc(workspace).listeners();
  if (!answer.running || answer.scan === null) return undefined;
  return { workspace, scan: answer.scan, servers: serversOf(workspace, answer.scan, lookups()) };
};

const scanAll = async (): Promise<ReadonlyArray<Scanned>> => {
  const workspaces = await runningWorkspaces();
  const scanned = await Promise.all(workspaces.map((workspace) => scanWorkspace(workspace).catch(() => undefined)));
  return scanned.filter((entry): entry is Scanned => entry !== undefined);
};

const isWebAnswer = (probe: { readonly status: number; readonly contentType: string | null; readonly location: string | null }) => {
  if (NAVIGATION_REDIRECTS.has(probe.status) && probe.location) return true;
  if (probe.status < 200 || probe.status >= 300 || probe.status === 204 || probe.status === 205) return false;
  const type = probe.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
};

const serversEqual = (left: ReadonlyArray<DiscoveredLocalServer>, right: ReadonlyArray<DiscoveredLocalServer>) =>
  JSON.stringify(left) === JSON.stringify(right);

export const make = Effect.gen(function* () {
  const probeCache = new Map<string, { readonly web: boolean; readonly at: number }>();

  /** A configured URL not at a listed server: a web probe of each running Container's port, cached 15 s. */
  const probeConfigured = async (raw: string, running: ReadonlyArray<string>): Promise<boolean> => {
    const cached = probeCache.get(raw);
    if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_MS) return cached.web;
    const url = new URL(raw);
    let web = false;
    for (const workspace of running) {
      const probe = await workspaceRpc(workspace)
        .probePort(portOf(url), `${url.pathname}${url.search}`)
        .catch(() => null);
      if (probe !== null && isWebAnswer(probe)) {
        web = true;
        break;
      }
    }
    probeCache.set(raw, { web, at: Date.now() });
    return web;
  };

  const project = async (scanned: ReadonlyArray<Scanned>, configuredUrls: ReadonlyArray<string>): Promise<ReadonlyArray<DiscoveredLocalServer>> => {
    const servers = scanned.flatMap((entry) => entry.servers);
    const configured: Array<DiscoveredLocalServer> = [];
    const opened = new Set<DiscoveredLocalServer>();
    for (const raw of normalizeConfiguredUrls(configuredUrls)) {
      const url = new URL(raw);
      const port = portOf(url);
      const listed = servers.filter((server) => server.port === port);
      if (listed.length > 0) {
        // An owned listener opens at the caller's configured URL (stock's `projectWebProbeSnapshot`).
        for (const server of listed) opened.add(server);
        configured.push(...listed.map((server) => ({ ...server, url: raw })));
        continue;
      }
      if (await probeConfigured(raw, scanned.map((entry) => entry.workspace))) {
        configured.push({ host: url.hostname, port, url: raw, processName: null, pid: null, terminal: null });
      }
    }
    return [...configured, ...servers.filter((server) => !opened.has(server))].toSorted((left, right) => left.port - right.port);
  };

  const scanOnce = (configuredUrls: ReadonlyArray<string> = []) =>
    Effect.promise(async () => {
      return project(await scanAll(), configuredUrls);
    }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<DiscoveredLocalServer>>([])));

  type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;
  const state = yield* Ref.make<{
    readonly listeners: ReadonlyMap<Listener, { readonly configuredUrls: ReadonlyArray<string>; readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer> }>;
    readonly retainCount: number;
  }>({ listeners: new Map(), retainCount: 0 });

  const pollTick = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.listeners.size === 0) return;
    const scanned = yield* Effect.promise(() => scanAll());
    for (const [listener, subscription] of current.listeners) {
      const next = yield* Effect.promise(() => project(scanned, subscription.configuredUrls));
      if (serversEqual(subscription.lastSnapshot, next)) continue;
      yield* Ref.update(state, (now) => {
        const listeners = new Map(now.listeners);
        const entry = listeners.get(listener);
        if (entry !== undefined) listeners.set(listener, { ...entry, lastSnapshot: next });
        return { ...now, listeners };
      });
      yield* listener(next);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("preview port scan failed", cause)));

  const pollIfRetained = Ref.get(state).pipe(Effect.flatMap((current) => (current.retainCount > 0 ? pollTick : Effect.void)));
  yield* Effect.forkScoped(pollIfRetained.pipe(Effect.repeat(Schedule.spaced(POLL_MS))));

  const retain = Effect.acquireRelease(
    Ref.update(state, (current) => ({ ...current, retainCount: current.retainCount + 1 })).pipe(Effect.andThen(pollTick)),
    () => Ref.update(state, (current) => ({ ...current, retainCount: Math.max(0, current.retainCount - 1) })),
  ).pipe(Effect.asVoid);

  const subscribe: PortScanner.PortDiscovery["Service"]["subscribe"] = (input, listener) =>
    Effect.acquireRelease(
      Ref.update(state, (current) => {
        const listeners = new Map(current.listeners);
        listeners.set(listener, { configuredUrls: normalizeConfiguredUrls(input.configuredUrls), lastSnapshot: input.initialSnapshot });
        return { ...current, listeners };
      }),
      () =>
        Ref.update(state, (current) => {
          const listeners = new Map(current.listeners);
          listeners.delete(listener);
          return { ...current, listeners };
        }),
    );

  const stopServer: PortScanner.PortDiscovery["Service"]["stopServer"] = (input) =>
    Effect.gen(function* () {
      const scanned = yield* Effect.tryPromise({ try: () => scanAll(), catch: (cause) => new PreviewStopLocalServerError({ reason: "signal-failed", cause }) });
      const holders = scanned.filter((entry) => entry.servers.some((server) => server.pid === input.pid && server.port === input.port));
      // Unknown, or the same (pid, port) in two Workspaces: the client scans again (plan §2.1).
      if (holders.length !== 1) return yield* new PreviewStopLocalServerError({ reason: "not-found" });
      const { workspace, scan } = holders[0]!;
      const table = new Map(scan.table.map(([pid, ppid, pgid]) => [pid, { pid, ppid, pgid }] as const));
      if (!table.has(input.pid)) return;
      const group = PortScanner.stoppableProcessGroup(table, input.pid, scan.computerd ?? 1);
      if (group === null) return yield* new PreviewStopLocalServerError({ reason: "shared-group" });
      const members = [...table.values()].filter((row) => row.pgid === group).map((row) => row.pid);
      yield* Effect.tryPromise({
        try: () => workspaceRpc(workspace).stopProcessGroup(group, members),
        catch: (cause) => new PreviewStopLocalServerError({ reason: "signal-failed", cause }),
      });
      yield* pollIfRetained;
    });

  return PortScanner.PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
    trackAgent: () => () => undefined,
    stopServer,
  });
});

export const layer = Layer.effect(PortScanner.PortDiscovery, make);
