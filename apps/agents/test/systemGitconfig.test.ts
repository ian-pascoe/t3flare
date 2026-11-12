// The image's system gitconfig (SPI-992, review M5): git, given it as its system config, sends every push to
// github.com through the push gateway, fetches from github.com directly, and names the current credential helper.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_HELPER } from "../src/workspace/credentialHelper.ts";
import { gitEnv, gitSync, tempDir } from "./gitHttp.fixture.ts";

const SYSTEM = path.join(import.meta.dirname, "../../sandbox-image/image/gitconfig");

const withSystem = (cwd: string, ...args: Array<string>) => {
  const env = { ...gitEnv(cwd), GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_SYSTEM: SYSTEM };
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return result.stdout.trim();
};

describe("the image's system gitconfig", () => {
  it("names the current credential helper", () => {
    expect(withSystem(tempDir("gc-"), "config", "--system", "--get-all", "credential.helper")).toBe(CREDENTIAL_HELPER);
  });

  it("rewrites pushes to github.com to the gateway, not fetches", () => {
    const repo = tempDir("gc-");
    gitSync(repo, gitEnv(repo), "init", "-q");
    gitSync(repo, gitEnv(repo), "remote", "add", "origin", "https://github.com/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "--push", "origin")).toBe("http://computer.internal/t3flare/git/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
  });

  it("leaves other hosts alone", () => {
    const repo = tempDir("gc-");
    gitSync(repo, gitEnv(repo), "init", "-q");
    gitSync(repo, gitEnv(repo), "remote", "add", "origin", "https://gitlab.com/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "--push", "origin")).toBe("https://gitlab.com/o/r.git");
  });
});
