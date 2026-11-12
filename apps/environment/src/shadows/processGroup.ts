// Shadow of t3code/packages/provider-core/src/server/processGroup.ts (ADR-0001; step 4a). t3's CLI adapters (pi's
// `rpc.ts`) stop a process by signalling its group with `process.kill(-pid, …)` and ask whether it exited with signal
// 0. In workerd `process.kill` cannot reach a process in a Workspace's Container, so here the pid is the process
// channel's synthetic one: any signal but 0 kills by marker in the Container (TERM, then KILL), and 0 answers from
// the channel's state. Exports the same name as the module it replaces.
import { environmentServices } from "../agents/bindings.ts";

const esrch = (pid: number) => Object.assign(new Error(`kill ESRCH: no such process group (${pid})`), { code: "ESRCH" });

export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw Object.assign(new Error(`kill ESRCH: not a spawned process group (${pid})`), { code: "ESRCH" });
  }
  const process = environmentServices().processes.byPid(pid);
  if (process === undefined || !process.running) throw esrch(pid);
  if (signal !== 0) process.kill();
}
