// The Container kill script's choice of processes (step 2a part 2; apps/sandbox-image/src/kill.ts), on real processes:
// each case runs in an Ubuntu container (the image's base) with Docker, and is skipped without Docker. The script runs as
// `killArgv(...)` would, as one `/bin/sh -c` command line (`killCommand(...)`).
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { spawnSync } from "node:child_process";

import { inBash } from "@t3flare/computer-env/shell";
import { killCommand } from "@t3flare/sandbox-image/kill";
import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;

interface Proc {
  readonly pid: number;
  readonly pgid: number;
  readonly mark: string;
  readonly args: string;
}

/** Runs `setup` (bash, starting processes), then the kill for `ids`: its answer, the time it took, what is left. */
const run = (setup: string, ids: ReadonlyArray<string>) => {
  // The case goes in on stdin (a bind mount of a host directory is not there on every Docker host).
  const script = `mkdir -p /t && cat > /t/kill.sh <<'T3FLARE_KILL_EOF'
${killCommand(ids)}
T3FLARE_KILL_EOF
${setup}
sleep 0.5
start=\${EPOCHREALTIME/[.,]/}
answer=$(sh /t/kill.sh)
end=\${EPOCHREALTIME/[.,]/}
echo "ANSWER $answer"
echo "MS $(( (end - start) / 1000 ))"
for dir in /proc/[0-9]*; do
  pid=\${dir#/proc/}
  [ "$pid" = "$$" ] && continue
  read -r stat < "$dir/stat" 2>/dev/null || continue
  rest=\${stat##*) }; set -- $rest
  [ "$1" = Z ] && continue
  mark=$(tr '\\0' '\\n' < "$dir/environ" 2>/dev/null | sed -n 's/^T3FLARE_EXEC=//p')
  echo "PROC $pid $3 \${mark:--} $(tr '\\0' ' ' < "$dir/cmdline")"
done
`;
  const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], { input: script, encoding: "utf8", timeout: 60_000 });
  const lines = result.stdout.split("\n");
  const answer = JSON.parse(lines.find((line) => line.startsWith("ANSWER "))?.slice(7) ?? "null") as { signalled: number; survivors: number } | null;
  const ms = Number(lines.find((line) => line.startsWith("MS "))?.slice(3));
  const left: Array<Proc> = lines
    .filter((line) => line.startsWith("PROC "))
    .map((line) => {
      const [, pid, pgid, mark, ...args] = line.split(" ");
      return { pid: Number(pid), pgid: Number(pgid), mark: mark!, args: args.join(" ").trim() };
    });
  const info = lines.filter((line) => line.startsWith("INFO ")).map((line) => line.slice(5));
  return { answer, ms, left, info, stderr: result.stderr };
};

const sleeps = (left: ReadonlyArray<Proc>) => left.filter((proc) => proc.args.startsWith("sleep")).map((proc) => proc.args).toSorted();

describe.skipIf(!docker)("the kill script", () => {
  it("kills a command's group: its shell, its child and its background grandchild", () => {
    const result = run(`T3FLARE_EXEC=a setsid bash -c 'sleep 600 & sleep 601' &`, ["a"]);
    expect(result.answer).toMatchObject({ survivors: 0 });
    expect(result.left.filter((proc) => proc.mark === "a")).toEqual([]);
    expect(result.ms).toBeLessThan(3000);
  });

  it("kills a marked process that started its own group", () => {
    const result = run(`T3FLARE_EXEC=a setsid bash -c 'setsid sleep 600 & sleep 601' &`, ["a"]);
    expect(result.answer).toMatchObject({ survivors: 0 });
    expect(sleeps(result.left)).toEqual([]);
  });

  it("signals a marked process alone in a group whose leader is unmarked: the leader and the rest live", () => {
    const result = run(`setsid bash -c 'T3FLARE_EXEC=a sleep 600 & sleep 601; :' &`, ["a"]);
    expect(result.answer).toMatchObject({ survivors: 0 });
    expect(sleeps(result.left)).toEqual(["sleep 601"]);
    expect(result.left.some((proc) => proc.args.startsWith("bash -c T3FLARE_EXEC=a"))).toBe(true);
  });

  it("leaves another command's processes, and every unmarked one, alone", () => {
    const result = run(`T3FLARE_EXEC=a setsid sleep 600 &\nT3FLARE_EXEC=b setsid sleep 601 &\nsleep 602 &`, ["a"]);
    expect(sleeps(result.left)).toEqual(["sleep 601", "sleep 602"]);
  });

  it("kills a group that ignores TERM with KILL, within 3 s", () => {
    const result = run(`T3FLARE_EXEC=a setsid bash -c 'trap "" TERM; sleep 600 & wait' &`, ["a"]);
    expect(result.answer).toMatchObject({ survivors: 0 });
    expect(sleeps(result.left)).toEqual([]);
    expect(result.ms).toBeGreaterThanOrEqual(2000);
    expect(result.ms).toBeLessThan(3500);
  });

  it("a Container command (computer-env's wrapper under /bin/sh -c) leads its own group, and keeps its exit status", () => {
    const quoted = (script: string) => `'${inBash(script).replaceAll("'", "'\\''")}'`;
    const probe = quoted('read -r stat < /proc/$$/stat; rest=${stat##*) }; set -- $rest; echo "INFO group $(( $3 == $$ ))"; exit 3');
    const result = run(`T3FLARE_EXEC=b sh -c ${probe}; echo "INFO exit $?"\nT3FLARE_EXEC=a sh -c ${quoted("sleep 600 & sleep 601")} &`, ["a"]);
    expect(result.info).toEqual(["group 1", "exit 3"]);
    expect(result.answer).toMatchObject({ survivors: 0 });
    expect(sleeps(result.left)).toEqual([]);
  });

  it("with nothing to kill, answers at once", () => {
    const result = run(`sleep 600 &`, ["a"]);
    expect(result.answer).toEqual({ signalled: 0, survivors: 0 });
    expect(result.ms).toBeLessThan(1000);
    expect(sleeps(result.left)).toEqual(["sleep 600"]);
  });
});
