// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off globalConsoleInEffect:off globalDateInEffect:off effectFnOpportunity:off globalJsonInEffect:off
// Step 4a M1's demo (stages only): the probe program through t3's own `ChildProcessSpawner` (the process router) in a
// Workspace's Container, driven the way t3's CLI clients drive theirs. Admin `POST /_t3flare/agents/process-check`.
//
//   {"op":"check","workspace":"<id>"}   round trips (p50/p95), 4 MiB each way, stderr apart, the kill with a child that
//                                       ignores TERM, and the Container's processes after
//   {"op":"hold","workspace":"<id>"}    starts a probe and leaves it running (the restart cases); answers its key
//   {"op":"count","workspace":"<id>","marker":"<key>"}  processes in the Container carrying a marker
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawn } from "../agents/processRouter.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";

const encoder = new TextEncoder();

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};

/** Processes in the Workspace's Container whose environment carries `marker`. */
export const countMarker = async (workspace: string, marker: string): Promise<number> => {
  const answer = await workspaceRpc(workspace).exec({ script: `grep -l -a 'T3FLARE_EXEC=${marker.replace(/[^A-Za-z0-9-]/g, "")}' /proc/[0-9]*/environ 2>/dev/null | wc -l`, timeoutMs: 20_000 });
  return Number(answer.stdout.trim());
};

/** Started probes held across requests (the restart cases). Stage-only diagnosis; a reset leaves dead scopes here, closed harmlessly. */
const held = new Map<string, { readonly scope: Scope.Closeable }>();

/** A line reader over a byte stream, with a queue of waiters. */
const lineReader = <E>(stream: Stream.Stream<Uint8Array, E>) => {
  const lines: Array<string> = [];
  const waiters: Array<() => void> = [];
  let bytes = 0;
  let carry = "";
  const decoder = new TextDecoder();
  const run = Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      bytes += chunk.byteLength;
      carry += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        lines.push(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
      }
      for (const waiter of waiters.splice(0)) waiter();
    }),
  );
  const next = async (timeoutMs: number): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    while (lines.length === 0) {
      if (Date.now() > deadline) return null;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
    return lines.shift()!;
  };
  return { run, next, bytes: () => bytes };
};

export const processCheck = async (body: { readonly op: string; readonly workspace: string; readonly marker?: string; readonly roundTrips?: number }): Promise<unknown> => {
  if (body.op === "count") return { count: await countMarker(body.workspace, body.marker ?? "") };
  const scope = Scope.makeUnsafe();
  const started = Date.now();
  const handle = await Effect.runPromise(
    spawn(ChildProcess.make("t3flare-probe", [], { cwd: `/w/${body.workspace}`, stdin: { stream: "pipe", endOnDone: false } })).pipe(Scope.provide(scope)),
  );
  const startMs = Date.now() - started;
  const key = (await import("../agents/bindings.ts")).environmentServices().processes.byPid(handle.pid)?.key ?? null;
  if (body.op === "hold") {
    held.set(key ?? String(handle.pid), { scope });
    return { key, pid: handle.pid, startMs };
  }
  const report: Record<string, unknown> = { startMs, key, pid: handle.pid };
  const stdin = await Effect.runPromise(
    Effect.gen(function* () {
      const queue: Array<Uint8Array> = [];
      const waiters: Array<() => void> = [];
      const source = Stream.fromAsyncIterable(
        {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
              yield queue.shift()!;
            }
          },
        },
        () => new Error("stdin"),
      );
      yield* Stream.run(source, handle.stdin).pipe(Effect.forkIn(scope));
      return (text: string) => {
        queue.push(encoder.encode(text));
        for (const waiter of waiters.splice(0)) waiter();
      };
    }),
  );
  const out = lineReader(handle.stdout);
  const err = lineReader(handle.stderr);
  void Effect.runPromise(out.run.pipe(Effect.ignore));
  void Effect.runPromise(err.run.pipe(Effect.ignore));
  try {
    const rtts: Array<number> = [];
    for (let i = 0; i < (body.roundTrips ?? 200); i++) {
      const at = Date.now();
      stdin(`ping-${i}\n`);
      const line = await out.next(10_000);
      if (line !== `out:ping-${i}`) {
        report.roundTripError = { i, line };
        break;
      }
      rtts.push(Date.now() - at);
    }
    report.roundTrips = { n: rtts.length, p50: percentile(rtts, 50), p95: percentile(rtts, 95), max: Math.max(...rtts) };
    let errLines = 0;
    while ((await err.next(2000)) !== null) if (++errLines >= rtts.length) break;
    report.stderrLines = errLines;
    // 4 MiB in (one line) and 4 MiB out.
    const big = 4 * 1024 * 1024;
    let at = Date.now();
    stdin(`${"y".repeat(big)}\n`);
    const echoed = await out.next(60_000);
    report.in4MiB = { ok: echoed?.length === big + 4, ms: Date.now() - at };
    at = Date.now();
    stdin(`big ${big}\n`);
    const produced = await out.next(60_000);
    report.out4MiB = { ok: produced?.length === big, ms: Date.now() - at };
    // The kill: t3's handle.kill (TERM, then KILL by marker); the child that ignores TERM goes too.
    at = Date.now();
    await Effect.runPromise(handle.kill({ killSignal: "SIGTERM" }));
    const code = await Promise.race([Effect.runPromise(handle.exitCode), new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
    report.kill = { exitCode: code, ms: Date.now() - at };
    await new Promise((resolve) => setTimeout(resolve, 3000));
    report.markerProcessesAfterKill = key === null ? null : await countMarker(body.workspace, key);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  return report;
};

/** Closes every held probe's scope (kills them), for the end of a restart case. */
export const releaseHeld = async (): Promise<number> => {
  const scopes = [...held.values()];
  held.clear();
  for (const entry of scopes) await Effect.runPromise(Scope.close(entry.scope, Exit.void));
  return scopes.length;
};

