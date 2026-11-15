// @effect-diagnostics globalDate:off
// The stop of a call that crosses into the Environment (ADR-0035, plan D9): Workers RPC carries no cancellation, so a
// caller that stops (a Session's Stop or turn end; a CLI whose relayed HTTP request went away) says so by id through
// `EnvironmentDO.cancelAsk`, and the call running under that id sees its signal abort. The Settings server then
// withdraws the Open change its call holds, whether its card is still open or the owner chose "Opened it".
//
// In memory, per isolate: a call is a live RPC, so a restart ends it anyway (its Open change then expires).
//
// SPI-1200 review:
// - Only writes register: a read never holds for the owner, so there is nothing to stop.
// - An id registers once. A second call under an id already running is the same call to its caller (a replay); it
//   shares the running call's signal and never aborts it, and the id stays registered until the last of them ends.
// - A stop that arrives before its call registers (the Stop raced the RPC) is remembered for `EARLY_STOP_MS`, at most
//   `EARLY_STOPS_MAX` ids, oldest dropped first; a call that then registers under it starts already stopped.
import { ownEntry } from "@t3flare/harness-registry";

import type { McpCallAnswer, McpHost } from "./host.ts";

/** How long a stop for an id not yet running is remembered. */
export const EARLY_STOP_MS = 60_000;
/** The most such stops remembered at once. */
export const EARLY_STOPS_MAX = 256;

const stops = new Map<string, { readonly controller: AbortController; users: number }>();
const early = new Map<string, number>();

const forgetOldStops = (now: number) => {
  for (const [id, at] of early) if (now - at > EARLY_STOP_MS) early.delete(id);
};

/** Runs `run` with a signal that `stopCall(id)` aborts while it runs. No id: no signal. */
export const withCallStop = async <T>(id: string | undefined, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
  if (id === undefined || id === "") return run(undefined);
  let entry = stops.get(id);
  if (entry === undefined) {
    entry = { controller: new AbortController(), users: 0 };
    stops.set(id, entry);
    forgetOldStops(Date.now());
    if (early.delete(id)) entry.controller.abort();
  }
  entry.users += 1;
  try {
    return await run(entry.controller.signal);
  } finally {
    entry.users -= 1;
    if (entry.users === 0 && stops.get(id) === entry) stops.delete(id);
  }
};

/**
 * The caller stopped call `id`: its signal aborts. An id not running now is remembered briefly, for a call that has not
 * registered yet.
 */
export const stopCall = (id: string): void => {
  const entry = stops.get(id);
  if (entry !== undefined) {
    entry.controller.abort();
    return;
  }
  const now = Date.now();
  forgetOldStops(now);
  early.delete(id);
  early.set(id, now);
  while (early.size > EARLY_STOPS_MAX) early.delete(early.keys().next().value!);
};

/** Tests only: forgets every remembered early stop, so one test's stops never reach another's. */
export const forgetEarlyStopsForTests = (): void => early.clear();

type HostCall = McpHost["call"];
type HostInput = Parameters<HostCall>[0];

/**
 * The MCP host's call for a CLI's relayed message (`RelayDeps.call`): a write that names a `stopId` (the Settings
 * server's) runs under it, so `stopCall` (the CLI going away) stops it.
 */
export const stoppableCall =
  (host: Pick<McpHost, "call">) =>
  ({ stopId, ...call }: Omit<HostInput, "signal"> & { readonly stopId?: string }): Promise<McpCallAnswer> =>
    withCallStop(call.judged === "write" ? stopId : undefined, (signal) => host.call({ ...call, ...(signal === undefined ? {} : { signal }) }));

/**
 * A Session's MCP call (`EnvironmentDO.mcpCall`): its caller is a Durable agent on its thread (plan D3), and a Settings
 * server write runs under the Session's `stopId`, so its Stop (`cancelAsk`) withdraws the Open change (plan D9).
 * Reads and other servers' calls run as before, with no signal.
 */
export const sessionMcpCall = (
  host: Pick<McpHost, "call" | "servers">,
  input: Omit<HostInput, "signal" | "caller"> & { readonly thread?: string; readonly stopId?: string },
  agent: string,
): Promise<McpCallAnswer> => {
  const { thread, stopId, ...call } = input;
  const caller = { door: "own" as const, thread: typeof thread === "string" && thread !== "" ? thread : undefined, agent };
  // The Settings server by its kind, as the relay judges it: a stored server under its name is not it.
  const settings = ownEntry(host.servers(), call.server)?.kind === "settings";
  return stoppableCall(host)({ ...call, caller, ...(settings && stopId !== undefined ? { stopId } : {}) });
};
