// The kill script (apps/sandbox-image/src/kill.ts) run on the Workspace's Container only while it runs, never starting it.
//
// It runs straight on the platform's `ctx.container`, not through computer's Container backend: the backend starts a
// stopped Container to run a command, and the platform's `exec` never does (only `start()` starts one; `exec` needs a
// running Container, https://developers.cloudflare.com/containers/api/durable-object-container/). So a Container that
// stops between the `running` check and the exec makes the exec fail, and that failure is read as "not running": a
// stopped Container has no processes left to kill. No window remains in which a kill could start a Container.
import { killArgv } from "@t3flare/sandbox-image/kill";

/** What of the platform's Container a kill uses. */
export type RunningContainer = Pick<Container, "running" | "exec">;

export interface KillOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the kill script on `markers` in `container` and gives its output; undefined when it is not running (or none). */
export const killInRunningContainer = async (container: RunningContainer | undefined, markers: ReadonlyArray<string>): Promise<KillOutput | undefined> => {
  const argv = killArgv(markers);
  if (container === undefined || !container.running || argv.length === 0) return undefined;
  let output: ExecOutput;
  try {
    const child = await container.exec([...argv], {});
    output = await child.output();
  } catch (error) {
    // Stopped under the kill: its processes went with it.
    if (!container.running) return undefined;
    throw error;
  }
  const decoder = new TextDecoder();
  return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
};
