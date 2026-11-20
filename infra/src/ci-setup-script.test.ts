// @effect-diagnostics nodeBuiltinImport:off -- the script runs in a real shell, as pnpm runs it.
// SPI-1300: `pnpm --filter @t3flare/infra run ci:setup --yes` reaches `alchemy deploy`, so an agent (no TTY, no approval
// prompt) can run it. pnpm runs a script as `sh -c '<script> <args…>'`; stand-ins for alchemy and node record what they get.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

/** Runs `ci:setup` as pnpm does, with `args` appended, and returns the arguments alchemy and node were called with. */
const runCiSetup = (args: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-setup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".config/t3flare"), { recursive: true });
  writeFileSync(join(dir, ".config/t3flare/dev.env"), "T3FLARE_T3_TRACK=stable\n");
  for (const tool of ["alchemy", "node"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, tool)}.log"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  execFileSync("sh", ["-c", `${packageJson.scripts["ci:setup"]} ${quoted}`], { env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  const log = (tool: string) => readFileSync(join(dir, `${tool}.log`), "utf8").trim();
  return { alchemy: log("alchemy"), node: log("node") };
};

describe("ci:setup", () => {
  it("passes its arguments to alchemy deploy, so --yes skips the approval prompt", () => {
    const invocations = runCiSetup(["--yes"]);
    expect(invocations.alchemy).toBe("deploy --config github.ts --stage ci --profile admin --yes");
    expect(invocations.node).toBe("allow-actions-prs.ts");
  });

  it("runs as before with no arguments", () => {
    expect(runCiSetup([]).alchemy).toBe("deploy --config github.ts --stage ci --profile admin");
  });
});
