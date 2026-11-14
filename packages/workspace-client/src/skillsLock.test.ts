// @effect-diagnostics nodeBuiltinImport:off
// The Container lock's snippet (SPI-1148): whatever happens to the lock, the command after it prints and exits as it
// would alone, and a lock that cannot be made leaves its marker once. Run here with the host's sh, where the bind cannot
// be made (no `/proc/self/mountinfo` or no permission): the failure path. The stage shows the bind made
// (docs/steps/spi-1001/env-readonly.json).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { SKILLS_LOCK_FAILED, SKILLS_LOCK_SCRIPT } from "./skillsLock.ts";

const run = (command: string) => spawnSync("sh", ["-c", `${SKILLS_LOCK_SCRIPT}${command}`], { encoding: "utf8" });

describe("SKILLS_LOCK_SCRIPT", () => {
  afterEach(() => fs.rmSync(SKILLS_LOCK_FAILED, { force: true }));

  it("leaves the command's output and status as they are, and records why the lock failed once", () => {
    fs.rmSync(SKILLS_LOCK_FAILED, { force: true });
    const first = run("echo out; echo err >&2; exit 7");
    expect({ stdout: first.stdout, stderr: first.stderr, status: first.status }).toEqual({ stdout: "out\n", stderr: "err\n", status: 7 });
    expect(fs.existsSync(SKILLS_LOCK_FAILED)).toBe(true);
    const at = fs.statSync(SKILLS_LOCK_FAILED).mtimeMs;
    const second = run("echo again");
    expect({ stdout: second.stdout, stderr: second.stderr, status: second.status }).toEqual({ stdout: "again\n", stderr: "", status: 0 });
    // Not tried again in the same launch.
    expect(fs.statSync(SKILLS_LOCK_FAILED).mtimeMs).toBe(at);
  });

  it("ends with a newline, so it never joins the command's first line", () => {
    expect(SKILLS_LOCK_SCRIPT.endsWith("\n")).toBe(true);
  });
});
