// @effect-diagnostics nodeBuiltinImport:off
// The CLI manifest (step 4a, plan §6; fragility U31): the image installs exactly the versions `clis.ts` names, and each
// satisfies t3's own compatibility rules at the pin. A nightly that raises a minimum fails here: bump the CLI in
// apps/sandbox-image/src/clis.ts (and the Dockerfile, and image/cli's lock).
import * as fs from "node:fs";
import * as path from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { IMAGE_NODE } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

import { resolveProviderCompatibility } from "t3/src/provider/providerCompatibility.ts";
import manifest from "t3/src/provider/model-manifest.json" with { type: "json" };
import { MINIMUM_PI_VERSION } from "../../../t3code/packages/provider-pi/src/server/status.ts";

const image = path.resolve(import.meta.dirname, "../../sandbox-image/image");

describe("the CLI manifest", () => {
  it("matches the Dockerfile's ARGs and pi's lock", () => {
    const dockerfile = fs.readFileSync(path.join(image, "Dockerfile"), "utf8");
    expect(/^ARG CODEX_VERSION=(.+)$/m.exec(dockerfile)?.[1]).toBe(CLIS.codex.version);
    expect(/^ARG CODEX_SHA256=(.+)$/m.exec(dockerfile)?.[1]).toBe(CLIS.codex.sha256);
    const lock = JSON.parse(fs.readFileSync(path.join(image, "cli/package-lock.json"), "utf8"));
    expect(lock.packages[`node_modules/${CLIS.pi.package}`].version).toBe(CLIS.pi.version);
    expect(fs.readFileSync(path.join(image, "t3flare-pi"), "utf8")).toContain(`node_modules/${CLIS.pi.package}/dist/cli.js`);
  });

  it("names the image's one Node everywhere it is named absolutely (mise.toml's): else pi and the leak scan break", () => {
    const node = /^node = "(.+)"$/m.exec(fs.readFileSync(path.join(image, "mise.toml"), "utf8"))?.[1];
    expect(node).toBeDefined();
    const bin = `/usr/local/share/mise/installs/node/${node}/bin`;
    expect(IMAGE_NODE).toBe(`${bin}/node`);
    expect(fs.readFileSync(path.join(image, "t3flare-pi"), "utf8")).toContain(`${bin}/node `);
    expect(fs.readFileSync(path.join(image, "Dockerfile"), "utf8")).toContain(`PATH=${bin}:$PATH npm ci`);
    // test:docker's image stands in for the Workspace image's CLI layer on the same Node.
    const testImage = fs.readFileSync(path.resolve(import.meta.dirname, "docker/Dockerfile"), "utf8");
    expect(testImage).toContain(`FROM node:${node}-`);
    expect(testImage).toContain(`NODE_VERSION_DIR=/usr/local/share/mise/installs/node/${node}`);
    // Step 4b: Claude Code's launcher runs claude-agent-acp on the same Node.
    expect(fs.readFileSync(path.join(image, "t3flare-claude-agent-acp"), "utf8")).toContain(`${bin}/node `);
  });

  it("matches the Dockerfile's ARGs and Claude's lock (step 4b)", () => {
    const dockerfile = fs.readFileSync(path.join(image, "Dockerfile"), "utf8");
    expect(/^ARG OPENCODE_VERSION=(.+)$/m.exec(dockerfile)?.[1]).toBe(CLIS.opencode.version);
    expect(/^ARG OPENCODE_SHA256=(.+)$/m.exec(dockerfile)?.[1]).toBe(CLIS.opencode.sha256);
    const lock = JSON.parse(fs.readFileSync(path.join(image, "claude/package-lock.json"), "utf8"));
    expect(lock.packages[`node_modules/${CLIS.claude.package}`].version).toBe(CLIS.claude.packageVersion);
    expect(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version).toBe(CLIS.claude.sdkVersion);
    // The SDK's version is Claude Code's: 0.3.N ships 2.1.N.
    expect(CLIS.claude.version).toBe(`2.1.${CLIS.claude.sdkVersion.split(".")[2]}`);
    expect(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"].version).toBe(CLIS.claude.sdkVersion);
    expect(fs.readFileSync(path.join(image, "t3flare-claude-agent-acp"), "utf8")).toContain(`node_modules/${CLIS.claude.package}/dist/index.js`);
  });

  it("pins a Codex t3 marks supported, and a pi at or above t3's minimum: else bump the CLI in clis.ts", () => {
    // SAFETY: the JSON is t3's ProviderCompatibilityPolicy array (model-manifest.json).
    const codex = resolveProviderCompatibility(manifest.compatibility as never, "codex" as never, CLIS.codex.version);
    expect(codex?.status, "bump the CLI in clis.ts").toBe("supported");
    expect(compareSemverVersions(CLIS.pi.version, MINIMUM_PI_VERSION), "bump the CLI in clis.ts").toBeGreaterThanOrEqual(0);
    for (const [driver, version] of [["claudeAgent", CLIS.claude.version], ["opencode", CLIS.opencode.version]] as const) {
      expect(resolveProviderCompatibility(manifest.compatibility as never, driver as never, version)?.status, `${driver}: bump the CLI in clis.ts`).toBe("supported");
    }
  });
});
