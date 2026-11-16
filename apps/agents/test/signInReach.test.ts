// @effect-diagnostics nodeBuiltinImport:off
// No sign-in's token can reach a Workspace or its Container (SPI-1164; ADR-0016): the only way to a Model endpoint's
// credential from the Workspace side is the model relay's `modelRelayTarget`, which refuses a sign-in endpoint (501,
// environment's endpointRelay.test.ts), and no Workspace code (the Workspace DO and every route its Container reaches)
// calls `endpointCredential`, the RPC that gives a sign-in's access token. Only a Session and text generation call it.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "../src");
const files = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));

describe("a sign-in's token and the Workspace side", () => {
  it("is asked for only by a Session and text generation, never by Workspace code", () => {
    const callers = files(src)
      .filter((file) => /\.endpointCredential\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(src, file))
      .sort();
    expect(callers).toEqual(["endpointTextGeneration.ts", "session/endpoints.ts"]);
    for (const file of files(path.join(src, "workspace"))) expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/endpointCredential|accessToken/);
  });

  it("reaches the Environment from the Workspace for a credential only through the relay's target", () => {
    const workspace = fs.readFileSync(path.join(src, "workspace/WorkspaceDO.ts"), "utf8");
    const calls = [...workspace.matchAll(/environmentStub\([^)]*\)\.(\w+)\(/g)].map((match) => match[1]);
    // The Environment RPCs the Workspace DO calls: none of them gives a sign-in's token (modelRelayTarget refuses one).
    expect(calls).not.toContain("endpointCredential");
    expect(calls).toContain("modelRelayTarget");
  });
});
