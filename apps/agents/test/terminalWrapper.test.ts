// A terminal's wrapper and rc file (step 2b; apps/sandbox-image/src/terminal.ts) on a real bash under a real PTY: in an
// Ubuntu container (the image's base) with Docker, skipped without Docker. The PTY is util-linux `script`'s, standing in
// for the platform's PTY exec.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { KILL_SCRIPT } from "@t3flare/sandbox-image/kill";
import { MARK_BUSY, MARK_PROMPT, scanMarkers, terminalCommand } from "@t3flare/sandbox-image/terminal";
import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;

/** Runs the wrapper under a PTY with `input` typed, as root; answers the raw output and the exit code. */
const run = (input: string, options: { readonly privileged: boolean; readonly after?: string; readonly projectRoot?: boolean }) => {
  const wrapper = terminalCommand({
    marker: "term-test1",
    t3Path: options.projectRoot ? "/w/.wt/demo/feat" : "/w/demo",
    cwd: options.projectRoot ? "/w/.wt/demo/feat" : "/w/demo/sub",
    ...(options.projectRoot ? { projectRoot: { t3Path: "/w/demo", view: "/workspace/.t3flare/project-root" } } : {}),
  });
  const script = `set -u
mkdir -p /workspace/repo/sub /tmp/case
echo repo-file > /workspace/repo/file.txt
mkdir -p /workspace/.t3flare/project-root && echo SECRET_FROM_PROJECT=1 > /workspace/.t3flare/project-root/.env
cat > /tmp/case/wrapper.sh <<'T3FLARE_WRAPPER_EOF'
${wrapper}
T3FLARE_WRAPPER_EOF
cat > /tmp/case/kill.sh <<'T3FLARE_KILL_EOF'
${KILL_SCRIPT}
T3FLARE_KILL_EOF
cat > /tmp/case/input <<'T3FLARE_INPUT_EOF'
${input}
T3FLARE_INPUT_EOF
(sleep 1; cat /tmp/case/input; sleep 3) | T3FLARE_EXEC=term-test1 script -qfec "bash /tmp/case/wrapper.sh" /tmp/case/typescript > /dev/null
echo "EXIT $?"
${options.after ?? ""}
cat /tmp/case/typescript
`;
  const args = ["run", "--rm", "-i", ...(options.privileged ? ["--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"] : []), IMAGE, "bash", "-s"];
  const result = spawnSync("docker", args, { input: script, encoding: "utf8", timeout: 90_000 });
  const exit = Number(/^EXIT (\d+)$/m.exec(result.stdout)?.[1]);
  return { output: result.stdout, exit, stderr: result.stderr };
};

describe.skipIf(!docker)("the terminal wrapper", () => {
  it("binds the repo at t3's path, starts in t3's cwd with the marker, prints the markers, and exits with the shell's code", () => {
    const result = run('pwd; cat ../file.txt; echo "mark=$T3FLARE_EXEC bashenv=${BASH_ENV:-unset}"; findmnt -n -o TARGET /w/demo; exit 3', { privileged: true });
    expect(result.exit).toBe(3);
    const { text } = scanMarkers("", result.output);
    expect(text).toMatch(/^\/w\/demo\/sub\r?$/m);
    expect(text).toContain("repo-file");
    expect(text).toContain("mark=term-test1 bashenv=unset");
    expect(text).toMatch(/^\/w\/demo\r?$/m); // findmnt: a bind mount
    expect(result.output).toContain(MARK_PROMPT);
    expect(result.output).toContain(MARK_BUSY);
  }, 120_000);

  it("links a worktree's project-root view at the project's path, and says what it holds first", () => {
    const result = run('cp "/w/demo/.env" . && cat .env && pwd; exit 0', { privileged: true, projectRoot: true });
    expect(result.exit).toBe(0);
    const { text } = scanMarkers("", result.output);
    expect(text).toContain("t3flare: /w/demo holds the project's untracked files only (.env)");
    expect(text).toContain("SECRET_FROM_PROJECT=1");
    expect(text).toMatch(/^\/w\/\.wt\/demo\/feat\r?$/m);
  }, 120_000);

  it("falls back to a symlink when the bind mount is not allowed", () => {
    const result = run('readlink /w/demo; pwd -P; exit 0', { privileged: false });
    expect(result.exit).toBe(0);
    const { text } = scanMarkers("", result.output);
    expect(text).toMatch(/^\/workspace\/repo\r?$/m);
    expect(text).toMatch(/^\/workspace\/repo\/sub\r?$/m);
  }, 120_000);

  it("leaves a background job the kill script finds by the terminal's marker after the shell exits", () => {
    const result = run("sleep 600 & exit 0", {
      privileged: false,
      after: `echo "BEFORE $(grep -l -a T3FLARE_EXEC=term-test1 /proc/[0-9]*/environ 2>/dev/null | wc -l)"
echo "KILL $(bash /tmp/case/kill.sh term-test1)"
sleep 0.3
echo "AFTER $(grep -l -a T3FLARE_EXEC=term-test1 /proc/[0-9]*/environ 2>/dev/null | wc -l)"`,
    });
    expect(Number(/^BEFORE (\d+)$/m.exec(result.output)?.[1])).toBeGreaterThan(0);
    expect(/^KILL (.*)$/m.exec(result.output)?.[1]).toMatch(/"survivors":0/);
    expect(/^AFTER (\d+)$/m.exec(result.output)?.[1]).toBe("0");
  }, 120_000);
});
