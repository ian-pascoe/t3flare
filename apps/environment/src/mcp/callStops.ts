// The stop of a call that crosses into the Environment (ADR-0034, plan D9): Workers RPC carries no cancellation, so a
// caller that stops (a Session's Stop or turn end; a CLI whose relayed HTTP request went away) says so by id through
// `EnvironmentDO.cancelAsk`, and the call running under that id sees its signal abort. The Settings server then
// withdraws the Open change its call holds, whether its card is still open or the owner chose "Opened it".
//
// In memory, per isolate: a call is a live RPC, so a restart ends it anyway (its Open change then expires).
import { SETTINGS_SERVER } from "@t3flare/harness-registry";

import type { McpCallAnswer, McpHost } from "./host.ts";

const stops = new Map<string, AbortController>();

/** Runs `run` with a signal that `stopCall(id)` aborts while it runs. No id: no signal. */
export const withCallStop = async <T>(id: string | undefined, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
  if (id === undefined || id === "") return run(undefined);
  const controller = new AbortController();
  stops.get(id)?.abort();
  stops.set(id, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (stops.get(id) === controller) stops.delete(id);
  }
};

/** The caller stopped call `id`: its signal aborts. Unknown ids are ignored (the call already ended). */
export const stopCall = (id: string): void => stops.get(id)?.abort();

type HostCall = McpHost["call"];
type HostInput = Parameters<HostCall>[0];

/**
 * The MCP host's call for a CLI's relayed message (`RelayDeps.call`): a call that names a `stopId` (the Settings
 * server's) runs under it, so `stopCall` (the CLI going away) stops it.
 */
export const stoppableCall =
  (host: Pick<McpHost, "call">) =>
  ({ stopId, ...call }: Omit<HostInput, "signal"> & { readonly stopId?: string }): Promise<McpCallAnswer> =>
    withCallStop(stopId, (signal) => host.call({ ...call, ...(signal === undefined ? {} : { signal }) }));

/**
 * A Session's MCP call (`EnvironmentDO.mcpCall`): its caller is a Durable agent on its thread (plan D3), and a Settings
 * server call runs under the Session's `stopId`, so its Stop (`cancelAsk`) withdraws the Open change (plan D9). Other
 * servers' calls run as before, with no signal.
 */
export const sessionMcpCall = (
  host: Pick<McpHost, "call">,
  input: Omit<HostInput, "signal" | "caller"> & { readonly thread?: string; readonly stopId?: string },
  agent: string,
): Promise<McpCallAnswer> => {
  const { thread, stopId, ...call } = input;
  const caller = { door: "own" as const, thread: typeof thread === "string" && thread !== "" ? thread : undefined, agent };
  return stoppableCall(host)({ ...call, caller, ...(call.server === SETTINGS_SERVER && stopId !== undefined ? { stopId } : {}) });
};
