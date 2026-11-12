// @effect-diagnostics nodeBuiltinImport:off
// The CLI manifest (step 4a, plan §6; fragility U30): the image installs exactly the versions `clis.ts` names, and each
// satisfies t3's own compatibility rules at the pin. A nightly that raises a minimum fails here: bump the CLI in
// apps/sandbox-image/src/clis.ts (and the Dockerfile, and image/cli's lock).
import * as fs from "node:fs";
import * as path from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";
import { CLIS } from "@t3flare/sandbox-image/clis";
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

  it("pins a Codex t3 marks supported, and a pi at or above t3's minimum: else bump the CLI in clis.ts", () => {
    // SAFETY: the JSON is t3's ProviderCompatibilityPolicy array (model-manifest.json).
    const codex = resolveProviderCompatibility(manifest.compatibility as never, "codex" as never, CLIS.codex.version);
    expect(codex?.status, "bump the CLI in clis.ts").toBe("supported");
    expect(compareSemverVersions(CLIS.pi.version, MINIMUM_PI_VERSION), "bump the CLI in clis.ts").toBeGreaterThanOrEqual(0);
  });
});
