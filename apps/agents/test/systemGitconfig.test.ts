// The image's system gitconfig (SPI-992's M5, back to stock by the owner, 2026-11-12): git, given it as its system
// config, names the current credential helper and pushes and fetches github.com directly (no push gateway).
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_HELPER } from "../src/workspace/credentialHelper.ts";

const gitEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
const gitSync = (cwd: string, env: NodeJS.ProcessEnv, ...args: Array<string>): string => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

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

  it("pushes and fetches github.com directly", () => {
    const repo = tempDir("gc-");
    gitSync(repo, gitEnv(repo), "init", "-q");
    gitSync(repo, gitEnv(repo), "remote", "add", "origin", "https://github.com/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "--push", "origin")).toBe("https://github.com/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
  });

  it("leaves other hosts alone", () => {
    const repo = tempDir("gc-");
    gitSync(repo, gitEnv(repo), "init", "-q");
    gitSync(repo, gitEnv(repo), "remote", "add", "origin", "https://gitlab.com/o/r.git");
    expect(withSystem(repo, "remote", "get-url", "--push", "origin")).toBe("https://gitlab.com/o/r.git");
  });
});
