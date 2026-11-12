// The Container's git credential helper (ADR-0013) as git runs it: `/bin/sh -c '<helper> "$@"' <helper> get`, git's
// attributes on stdin. It answers only `protocol=https host=github.com` (SPI-992): a pushurl on another host gets nothing.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_HELPER } from "../src/workspace/credentialHelper.ts";

const run = (stdin: string, op = "get") =>
  spawnSync("/bin/sh", ["-c", `${CREDENTIAL_HELPER.slice(1)} "$@"`, "helper", op], {
    input: stdin,
    encoding: "utf8",
    // The router's token stands in for the DO, so the test never reaches computer.internal.
    env: { PATH: process.env.PATH, T3FLARE_GIT_TOKEN: "test-token" },
  }).stdout;

describe("credential helper", () => {
  it("answers github.com over https", () => {
    expect(run("protocol=https\nhost=github.com\npath=o/r.git\n\n")).toBe("username=x-access-token\npassword=test-token\n");
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
  ])("gives nothing for %s", (_, stdin) => {
    expect(run(stdin)).toBe("");
  });

  it("ignores store and erase", () => {
    expect(run("protocol=https\nhost=github.com\n\n", "store")).toBe("");
  });
});
