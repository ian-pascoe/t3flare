// The Global mise config's lay-down script (SPI-1150; apps/sandbox-image/src/globalMise.ts), run for real in bash with
// stub `mise`, `git` and `gh` in an Ubuntu container (the image's base, with its `flock` and `timeout`), pulled when
// missing; skipped only without a Docker daemon. The text goes in on stdin, as the Workspace DO sends it. The image's
// real mise is `mise.docker.test.ts`'s.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { GLOBAL_MISE_CONFIG, GLOBAL_MISE_DIR } from "@t3flare/sandbox-image/env";
import { GLOBAL_MISE_SCRIPT, parseGlobalMiseAnswer, SYSTEM_GITCONFIG } from "@t3flare/sandbox-image/globalMise";
import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
/**
 * Docker is there (CI's `ubuntu-latest` runners have it, so `pnpm run check` runs these in deploy-prod's check): the
 * image is pulled when missing. Skipped only on a machine without a Docker daemon.
 */
const docker =
  spawnSync("docker", ["info"], { encoding: "utf8", timeout: 20_000 }).status === 0 &&
  (spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0 || spawnSync("docker", ["pull", "-q", IMAGE], { encoding: "utf8", timeout: 300_000 }).status === 0);

/**
 * The stubs: `mise install` records the config it was given and exits `STUB_INSTALL` (0 by default); `git` and `gh`
 * fail when that config holds `BREAK_GIT` / `BREAK_GH`, and record whether mise's auto-install was off for them.
 */
const STUBS = `mkdir -p /stub /t
cat > /stub/mise <<'EOF'
#!/bin/bash
echo "mise $* global=$(cat "$MISE_GLOBAL_CONFIG_FILE" | tr '\\n' ' ')" >> /t/calls
exit "\${STUB_INSTALL:-0}"
EOF
for tool in git gh; do cat > /stub/$tool <<EOF
#!/bin/bash
echo "$tool auto=\\$MISE_AUTO_INSTALL/\\$MISE_EXEC_AUTO_INSTALL/\\$MISE_NOT_FOUND_AUTO_INSTALL" >> /t/calls
code=\\$(grep -o "BREAK_\${tool^^}=[0-9]*" "\\$MISE_GLOBAL_CONFIG_FILE" | cut -d= -f2)
[ -n "\\$code" ] && exit "\\$code"
grep -q "BREAK_\${tool^^}\\b" "\\$MISE_GLOBAL_CONFIG_FILE" && exit 1
exit 0
EOF
done
chmod +x /stub/*
export PATH=/stub:$PATH
mkdir -p $(dirname ${SYSTEM_GITCONFIG}) && printf '[credential]\\n\\thelper = "!t3flare/git-credential"\\n' > ${SYSTEM_GITCONFIG}
`;

/** Each run: `text` on stdin to the script for `revision`; prints the answer and what the stubs and disk show. */
const run = (cases: ReadonlyArray<{ readonly text: string; readonly revision?: number; readonly env?: string; readonly before?: string }>) => {
  const steps = cases
    .map(
      ({ text, revision = 1, env = "", before = "" }, index) => `${before}
printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > /t/in
echo "ANSWER ${index} $(${env} bash -c "$SCRIPT" t3flare-global-mise ${revision} $(sha256sum /t/in | cut -c1-64) environment < /t/in 2>/dev/null | tail -n 1)"
echo "GLOBAL ${index} $([ -f ${GLOBAL_MISE_CONFIG} ] && base64 -w0 ${GLOBAL_MISE_CONFIG} || echo -)"
echo "STAGED ${index} $(ls ${GLOBAL_MISE_DIR} | grep -c '^config\\..*\\.toml$')"`,
    )
    .join("\n");
  const script = `${STUBS}
cat > /t/script.sh <<'T3FLARE_EOF'
${GLOBAL_MISE_SCRIPT}
T3FLARE_EOF
SCRIPT=$(cat /t/script.sh)
${steps}
echo "CALLS $(base64 -w0 < /t/calls 2>/dev/null)"
`;
  const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], { input: script, encoding: "utf8", timeout: 120_000 });
  const lines = result.stdout.split("\n");
  const field = (name: string, index: number) => lines.find((line) => line.startsWith(`${name} ${index} `))?.slice(`${name} ${index} `.length) ?? "";
  return {
    answers: cases.map((_, index) => parseGlobalMiseAnswer(field("ANSWER", index))),
    globals: cases.map((_, index) => {
      const value = field("GLOBAL", index);
      return value === "-" ? null : Buffer.from(value, "base64").toString("utf8");
    }),
    staged: cases.map((_, index) => Number(field("STAGED", index))),
    calls: Buffer.from(lines.find((line) => line.startsWith("CALLS "))?.slice(6) ?? "", "base64").toString("utf8").trim().split("\n"),
    stderr: result.stderr,
  };
};

const NODE = '[tools]\nnode = "24.11.1"\n';

describe.skipIf(!docker)("the Global mise config's lay-down script", { timeout: 120_000 }, () => {
  it("installs with the text as the global config and lays it down when git and gh run, mise's auto-install off for them", () => {
    const result = run([{ text: NODE }]);
    expect(result.answers[0]).toMatchObject({ revision: 1, source: "environment", laid: true, install: 0, timedOut: false, bytes: NODE.length });
    expect(result.globals[0]).toBe(NODE);
    expect(result.staged[0]).toBe(0);
    expect(result.calls).toEqual([`mise install global=[tools] node = "24.11.1" `, "git auto=false/false/false", "gh auto=false/false/false"]);
  });

  it("does not lay down a text under which git or gh fails, and leaves no staging file", () => {
    for (const marker of ["BREAK_GIT", "BREAK_GH"]) {
      const result = run([{ text: `# ${marker}\n${NODE}` }]);
      expect(result.answers[0]).toMatchObject({ laid: false, install: 0, timedOut: false });
      expect(result.globals[0]).toBeNull();
      expect(result.staged[0]).toBe(0);
    }
  });

  it("reads each check's exit alone: 1 and 24 are failures, 124 or 137 from either a timeout", () => {
    const result = run([{ text: `# BREAK_GIT=1\n# BREAK_GH=24\n${NODE}` }, { text: `# BREAK_GIT=124\n${NODE}`, revision: 2 }, { text: `# BREAK_GH=137\n${NODE}`, revision: 3 }]);
    expect(result.answers.map((answer) => [answer?.laid, answer?.timedOut])).toEqual([
      [false, false],
      [false, true],
      [false, true],
    ]);
  });

  it("still lays down a text whose install fails for another tool, when git and gh run", () => {
    const result = run([{ text: NODE, env: "STUB_INSTALL=1" }]);
    expect(result.answers[0]).toMatchObject({ laid: true, install: 1, timedOut: false });
  });

  it("reports an install cut off by its timeout, after TERM (124) or KILL (137)", () => {
    for (const code of [124, 137]) expect(run([{ text: NODE, env: `STUB_INSTALL=${code}` }]).answers[0]).toMatchObject({ install: code, timedOut: true });
  });

  it("answers again without installing for the same revision and text; another revision or text runs", () => {
    const result = run([{ text: NODE }, { text: NODE }, { text: NODE, revision: 2 }, { text: `${NODE}# more\n`, revision: 2 }]);
    expect(result.answers.map((answer) => answer?.laid)).toEqual([true, true, true, true]);
    expect(result.answers[1]).toEqual(result.answers[0]);
    expect(result.calls.filter((call: string) => call.startsWith("mise install"))).toHaveLength(3);
    expect(result.globals[3]).toBe(`${NODE}# more\n`);
  });

  it("with no text, lays nothing down and installs nothing", () => {
    const result = run([{ text: "" }]);
    expect(result.answers[0]).toMatchObject({ laid: false, install: null, bytes: 0 });
    expect(result.globals[0]).toBeNull();
    expect(result.calls).toEqual([""]);
  });

  it("answers locked when another lay-down holds the lock past its bound", () => {
    // The lock held by a background flock for longer than the script waits (its bound is 60 s; the stub `flock` here
    // waits no time, which is what a held lock past the bound answers).
    const before = `cat > /stub/flock <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x /stub/flock`;
    expect(run([{ text: NODE, before }]).answers[0]).toMatchObject({ laid: false, locked: true });
  });

  it("gives a git the owner pinned the image's system gitconfig, and leaves one that has it", () => {
    const before = `mkdir -p /root/.local/share/mise/installs/conda-git/2.40.0/bin /root/.local/share/mise/installs/conda-git/2.56.0/etc
printf '#!/bin/sh\\n' > /root/.local/share/mise/installs/conda-git/2.40.0/bin/git; chmod +x /root/.local/share/mise/installs/conda-git/2.40.0/bin/git
cp -r /root/.local/share/mise/installs/conda-git/2.40.0/bin /root/.local/share/mise/installs/conda-git/2.56.0/
printf '[credential]\\n\\thelper = "!x t3flare/git-credential"\\n' > /root/.local/share/mise/installs/conda-git/2.56.0/etc/gitconfig
trap 'echo "PINNED $(base64 -w0 < /root/.local/share/mise/installs/conda-git/2.40.0/etc/gitconfig)"; echo "KEPT $(base64 -w0 < /root/.local/share/mise/installs/conda-git/2.56.0/etc/gitconfig)"' EXIT`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: `${STUBS}\n${before}\nprintf %s '${Buffer.from(NODE).toString("base64")}' | base64 -d | bash -c '${GLOBAL_MISE_SCRIPT.replaceAll("'", "'\\''")}' t3flare-global-mise 1 ${"a".repeat(64)} kept\n`,
      encoding: "utf8",
      timeout: 120_000,
    });
    const field = (name: string) => Buffer.from(result.stdout.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? "", "base64").toString("utf8");
    expect(field("PINNED")).toBe('[credential]\n\thelper = "!t3flare/git-credential"\n');
    expect(field("KEPT")).toBe('[credential]\n\thelper = "!x t3flare/git-credential"\n');
    // The trap prints after the answer here: the answer is the line that starts with "{".
    expect(parseGlobalMiseAnswer(result.stdout.split("\n").find((line) => line.startsWith("{")) ?? "")).toMatchObject({ source: "kept", laid: true });
  });
});

describe("parseGlobalMiseAnswer", () => {
  it("reads the last line of stdout, and nothing from text that is not an answer", () => {
    const good = { revision: 1, sha256: "a".repeat(64), source: "default", laid: false, install: null, timedOut: false, ms: 3, bytes: 0 };
    expect(parseGlobalMiseAnswer(`noise\n${JSON.stringify(good)}\n`)).toEqual(good);
    // Every field is checked, not only \`laid\`.
    for (const bad of [{ sha256: "x" }, { revision: -1 }, { install: "0" }, { timedOut: "no" }, { ms: 1.5 }, { bytes: undefined }, { locked: 1 }]) {
      expect(parseGlobalMiseAnswer(JSON.stringify({ ...good, ...bad }))).toBeUndefined();
    }
    expect(parseGlobalMiseAnswer("[true]")).toBeUndefined();
    expect(parseGlobalMiseAnswer("mise ERROR something\n")).toBeUndefined();
    expect(parseGlobalMiseAnswer("")).toBeUndefined();
  });
});
