// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
// t3's port discovery in the Workspace's Container (G11's M2, ADR-0031): the scan (`@t3flare/sandbox-image/ports`), a
// stop of one process group, and a probe of a configured `localhost` preview URL. Each runs only while the Container
// runs and never starts it (as `containerKill.ts`: the platform's `exec` and `getTcpPort` need a running Container), and
// none is use of the Container: a client watching the list does not keep an idle Container up (review L9).
import { type PortScan, portsArgv, stopGroupArgv } from "@t3flare/sandbox-image/ports";

/** What of the platform's Container these use. */
export type RunningContainer = Pick<Container, "running" | "exec" | "getTcpPort">;

const decoder = new TextDecoder();

const run = async (container: RunningContainer, argv: ReadonlyArray<string>): Promise<string | undefined> => {
  try {
    const child = await container.exec([...argv], {});
    const output = await child.output();
    return output.exitCode === 0 ? decoder.decode(output.stdout) : undefined;
  } catch (error) {
    if (!container.running) return undefined;
    throw error;
  }
};

/** The Container's listeners, or undefined when it is not running (or stopped under the scan). */
export const scanRunningContainer = async (container: RunningContainer | undefined): Promise<PortScan | undefined> => {
  if (container === undefined || !container.running) return undefined;
  const out = await run(container, portsArgv());
  if (out === undefined) return undefined;
  return JSON.parse(out.trim()) as PortScan;
};

/** Stops process group `pgid` (TERM, KILL after 3 s); false when it was gone or the Container is not running. */
export const stopGroupInRunningContainer = async (
  container: RunningContainer | undefined,
  pgid: number,
  members: ReadonlyArray<number>,
): Promise<boolean> => {
  const argv = stopGroupArgv(pgid, members);
  if (container === undefined || !container.running || argv.length === 0) return false;
  const out = await run(container, argv);
  return out?.includes('"signalled":true') === true;
};

export interface PortProbe {
  readonly status: number;
  readonly contentType: string | null;
  readonly location: string | null;
}

/** One GET of `path` on the Container's `port`, as stock's web probe does (1 s, no redirect followed, body unread). */
export const probeRunningPort = async (container: RunningContainer | undefined, port: number, path: string): Promise<PortProbe | undefined> => {
  if (container === undefined || !container.running) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !path.startsWith("/")) return undefined;
  const signal = AbortSignal.timeout(1_000);
  try {
    const response = await container.getTcpPort(port).fetch(`http://localhost:${port}${path}`, { redirect: "manual", signal, headers: { host: `localhost:${port}` } });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, contentType: response.headers.get("content-type"), location: response.headers.get("location") };
  } catch {
    return undefined;
  }
};
