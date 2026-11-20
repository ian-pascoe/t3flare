// @effect-diagnostics nodeBuiltinImport:off
// SPI-1209: a CLI agent's launch path names every program it runs by its absolute path. The image puts mise's shims
// first on PATH and trusts /workspace's mise configuration, so a project could supply a program under any bare name;
// on this path the model handle is in the environment (the process wrapper, the launchers) or being read from the
// holder's (the handle helpers). What the scripts do is `test:docker`'s (`piRelay.docker.test.ts`) and the process
// wrapper's own docker test (apps/agents `processWrapper.test.ts`).
import * as fs from "node:fs";
import * as path from "node:path";

import { processCommand } from "@t3flare/sandbox-image/process";
import { describe, expect, it } from "vitest";

import { bareCommands, commandWords } from "./shellCommands.ts";

const image = path.resolve(import.meta.dirname, "../../sandbox-image/image");
const read = (name: string) => fs.readFileSync(path.join(image, name), "utf8");

/** The image's scripts on the launch path: the launchers and the handle helpers. */
const SCRIPTS = ["t3flare-pi", "t3flare-pi-handle", "t3flare-claude-agent-acp", "t3flare-claude-handle", "t3flare-opencode"];

describe("the CLI launch path", () => {
  it("finds the programs a script runs by name, wherever the shell would run them", () => {
    const script = [
      "set -eu",
      "fail() { echo x >&2; exit 1; }",
      'x=$(sed "s/a/b/" f 2> /dev/null | /usr/bin/head -n 3) || fail "no"',
      'case "$(tr a b < /proc/1/cmdline)" in',
      "  '' | *[!0-9]*) y=$(cut -f2) ;;",
      "  proc-*) ;;",
      "esac",
      'if ! mountpoint -q /w 2>/dev/null && [ ! -L /w ]; then { rmdir /w; mkdir -p "$(dirname /w/x)"; }; fi',
      "for d in /a/*; do [ -d \"$d\" ] || continue; k=$(basename \"$d\"); done",
      "n=$((n+1)); while kill -0 1; do sleep 1; done",
      "env -u X /usr/bin/true </dev/null >/dev/null &",
      "exec 3>&1 1>&2",
      "exec -a setsid /usr/bin/setsid --wait '/opt/x' 'y'",
      "exec setsid --wait /opt/x",
    ].join("\n");
    expect(commandWords(script)).toEqual(["set", "echo", "exit", "sed", "/usr/bin/head", "tr", "cut", "mountpoint", "[", "rmdir", "mkdir", "dirname", "[", "continue", "basename", "kill", "sleep", "env", "/usr/bin/true", "/usr/bin/setsid", "/opt/x", "setsid", "/opt/x"]);
    expect(bareCommands(script)).toEqual(["sed", "tr", "cut", "mountpoint", "rmdir", "mkdir", "dirname", "basename", "sleep", "env", "setsid"]);
  });

  it.each([
    ["a backtick substitution", "x=`sed a`"],
    ["a substitution inside ${…}", "y=${A:-$(sed a)}"],
    ["a heredoc", "cat <<EOF\nsed\nEOF"],
    ["an unterminated quote", "echo 'oops"],
    ["an unterminated substitution", "x=$(sed a"],
    ["a word that runs a string", "eval sed"],
    ["a builtin that bypasses functions", "command sed"],
    ["a trap", "trap 'rm -f x' EXIT"],
    ["a shell's -c string", "/bin/sh -c 'sed a'"],
    ["a program that runs another", "/usr/bin/xargs rm"],
    ["a timeout", "/usr/bin/timeout 5 sed a"],
    ["find -exec", "/usr/bin/find . -exec rm {} +"],
    ["env -S", "/usr/bin/env -S 'sed x'"],
  ])("fails closed on what it does not follow: %s", (_what, script) => {
    expect(() => commandWords(script)).toThrow(/is not followed/);
  });

  it("starts a process through a wrapper that names every program by its absolute path", () => {
    const wrapper = processCommand({
      marker: "proc-a",
      t3Path: "/w/demo",
      cwd: "/w/demo",
      argv: ["/opt/t3flare/bin/pi", "--mode", "rpc"],
      files: [{ path: "/var/lib/t3flare/cli/proc-a/cfg.toml", text: "a = 1\n" }],
      links: [{ path: "/var/lib/t3flare/cli/proc-a/sessions", target: "/workspace/.t3flare/codex/sessions" }],
      prune: [{ dir: "/workspace/.t3flare/pi/sessions", days: 60 }],
    });
    expect(bareCommands(wrapper)).toEqual([]);
    // The holder's command line keeps setsid's name: the handle helpers and the holder lists match `setsid --wait …`.
    expect(wrapper).toContain("exec -a setsid /usr/bin/setsid --wait '/opt/t3flare/bin/pi' '--mode' 'rpc'");
  });

  it.each(SCRIPTS)("%s names every program by its absolute path", (name) => {
    expect(bareCommands(read(name))).toEqual([]);
  });
});
