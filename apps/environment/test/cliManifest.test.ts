// @effect-diagnostics nodeBuiltinImport:off
// The CLI manifest (step 4a, plan §6; fragility U31): the image installs exactly the versions `clis.ts` names, and each
// satisfies t3's own compatibility rules at the pin. A nightly that raises a minimum fails here: bump the CLI in
// apps/sandbox-image/src/clis.ts (and the Dockerfile, and image/cli's lock).
import * as fs from "node:fs";
import * as path from "node:path";

import { CLIS } from "@t3flare/sandbox-image/clis";
import { IMAGE_NODE } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

import { resolveProviderCompatibility } from "t3/src/provider/providerCompatibility.ts";
import manifest from "t3/src/provider/model-manifest.json" with { type: "json" };

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

  it("pins a version of each CLI that t3's compatibility policy marks supported: else bump the CLI in clis.ts", () => {
    // Pi's minimum is a policy entry since v0.1.11-nightly.20261120.4979 (it was `MINIMUM_PI_VERSION` in provider-pi's status.ts).
    const pins = [
      ["codex", CLIS.codex.version],
      ["pi", CLIS.pi.version],
      ["claudeAgent", CLIS.claude.version],
      ["opencode", CLIS.opencode.version],
    ] as const;
    for (const [driver, version] of pins) {
      // SAFETY: the JSON is t3's ProviderCompatibilityPolicy array (model-manifest.json).
      expect(resolveProviderCompatibility(manifest.compatibility as never, driver as never, version)?.status, `${driver}: bump the CLI in clis.ts`).toBe("supported");
    }
  });

  it("runs the computerd of the @cloudflare/computer the Workspace DO runs: their sync protocol is not stable across releases", () => {
    const computerd = /^ARG COMPUTERD_VERSION=(.+)$/m.exec(fs.readFileSync(path.join(image, "Dockerfile"), "utf8"))?.[1];
    expect(computerd).toBeDefined();
    for (const pkg of ["apps/agents", "packages/computer-env"]) {
      const json = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../..", pkg, "package.json"), "utf8"));
      expect(json.dependencies["@cloudflare/computer"], pkg).toBe(computerd);
    }
  });
});
