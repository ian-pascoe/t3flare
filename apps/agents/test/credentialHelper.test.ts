// The Container's git credential helper (ADR-0013) as git runs it: `/bin/sh -c '<helper> "$@"' <helper> get`, git's
// attributes on stdin. It answers only `protocol=https host=github.com` (SPI-992): a pushurl on another host gets nothing.
// It never reads a token from its environment (review item 10: the router passes none): it asks the Workspace DO, here a
// `curl` stand-in on PATH that records its arguments.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_HELPER, CREDENTIAL_PATH } from "../src/workspace/credentialHelper.ts";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "helper-"));
const asked = path.join(bin, "asked");
fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${asked}\nprintf test-token\n`, { mode: 0o755 });

const run = (stdin: string, op = "get") => {
  fs.rmSync(asked, { force: true });
  return spawnSync("/bin/sh", ["-c", `${CREDENTIAL_HELPER.slice(1)} "$@"`, "helper", op], {
    input: stdin,
    encoding: "utf8",
    // A token in the environment (the router's, before SPI-992) is never used.
    env: { PATH: `${bin}:${process.env.PATH}`, T3FLARE_GIT_TOKEN: "env-token" },
  }).stdout;
};

describe("credential helper", () => {
  it("answers github.com over https", () => {
    expect(run("protocol=https\nhost=github.com\npath=o/r.git\n\n")).toBe("username=x-access-token\npassword=test-token\n");
  });

  it("asks the Workspace DO's credential path as the new helper (v=2), naming the host", () => {
    run("protocol=https\nhost=github.com\n\n");
    const args = fs.readFileSync(asked, "utf8");
    expect(args).toContain(`http://computer.internal${CREDENTIAL_PATH}`);
    expect(args).toContain("v=2");
    expect(args).toContain("host=github.com");
    expect(args).not.toContain("cmd=");
  });

  it("answers when stdin ends without a blank line", () => {
    expect(run("protocol=https\nhost=github.com\n")).toContain("password=test-token");
  });

  it.each([
    ["another host", "protocol=https\nhost=attacker.example\n\n"],
    ["a github.com look-alike", "protocol=https\nhost=github.com.attacker.example\n\n"],
    ["a port on github.com", "protocol=https\nhost=github.com:8443\n\n"],
    ["plain http", "protocol=http\nhost=github.com\n\n"],
    ["no attributes", "\n"],
  ])("gives nothing for %s, and asks nothing", (_, stdin) => {
    expect(run(stdin)).toBe("");
    expect(fs.existsSync(asked)).toBe(false);
  });

  it("ignores store and erase", () => {
    expect(run("protocol=https\nhost=github.com\n\n", "store")).toBe("");
  });
});
