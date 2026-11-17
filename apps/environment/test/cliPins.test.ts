// @effect-diagnostics nodeBuiltinImport:off
// The CLI pins a CLI bump edits (ADR-0037; in-app updates plan D22): each edit changes only its own fields, on the real
// Dockerfile and clis.ts, so the CLI manifest test (cliManifest.test.ts) still reads them.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { cliBumpBranch, codexTarballs, lockedVersion, versionOfRange, withClisFields, withDependency, withDockerfileArg } from "../scripts/lib/cliPins.ts";

const sandbox = path.resolve(import.meta.dirname, "../../sandbox-image");
const dockerfile = fs.readFileSync(path.join(sandbox, "image/Dockerfile"), "utf8");
const clis = fs.readFileSync(path.join(sandbox, "src/clis.ts"), "utf8");

describe("the CLI pins' edits", () => {
  it("sets one Dockerfile ARG", () => {
    const next = withDockerfileArg(dockerfile, "CODEX_VERSION", "0.169.0");
    expect(/^ARG CODEX_VERSION=(.+)$/m.exec(next)?.[1]).toBe("0.169.0");
    expect(next.split("\n").filter((line, index) => line !== dockerfile.split("\n")[index])).toEqual(["ARG CODEX_VERSION=0.169.0"]);
    expect(() => withDockerfileArg(dockerfile, "NO_SUCH", "1")).toThrow(/no ARG NO_SUCH/);
  });

  it("sets only the named CLI's fields in clis.ts", () => {
    const next = withClisFields(clis, "codex", { version: "0.169.0", sha256: "a".repeat(64), sha256Arm64: "b".repeat(64) });
    expect(next).toContain('version: "0.169.0"');
    expect(next).toContain(`sha256: "${"a".repeat(64)}"`);
    expect(next).toContain(`sha256Arm64: "${"b".repeat(64)}"`);
    // OpenCode's hashes, after Codex's entry, are untouched.
    expect(next.slice(next.indexOf("opencode: {"))).toBe(clis.slice(clis.indexOf("opencode: {")));
    const claude = withClisFields(clis, "claude", { version: "2.1.326", packageVersion: "0.108.0", sdkVersion: "0.3.326" });
    expect(claude.slice(0, claude.indexOf("claude: {"))).toBe(clis.slice(0, clis.indexOf("claude: {")));
    expect(() => withClisFields(clis, "pi", { sha256: "x" })).toThrow(/no sha256/);
  });

  it("pins a package.json dependency exactly, and reads a lock", () => {
    expect(JSON.parse(withDependency('{"dependencies":{"a":"1.0.0"}}', "a", "1.1.0"))).toEqual({ dependencies: { a: "1.1.0" } });
    expect(() => withDependency('{"dependencies":{}}', "a", "1")).toThrow();
    expect(lockedVersion(JSON.stringify({ packages: { "node_modules/a": { version: "1.1.0" } } }), "a")).toBe("1.1.0");
    expect(versionOfRange("^0.3.326")).toBe("0.3.326");
  });

  it("names the branch and the tarballs", () => {
    expect(cliBumpBranch("codex", "0.169.0")).toBe("bump/cli-codex-0.169.0");
    expect(codexTarballs("0.169.0").amd64).toBe("https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-x86_64-unknown-linux-musl.tar.gz");
  });
});
