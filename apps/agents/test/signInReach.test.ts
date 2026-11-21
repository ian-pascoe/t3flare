// @effect-diagnostics nodeBuiltinImport:off
// No sign-in's token can reach a Container (SPI-1164; ADR-0016): from the Workspace side, the only way to a Model
// endpoint's credential is the model relay's `modelRelayTarget`, which since SPI-1171 gives a sign-in's access token
// for one request to the Workspace DO, which hands it to the relay's route in `WorkspaceProxy` (a Worker, outside the
// Container) and keeps it only by hash for the sync guard. No Workspace code calls `endpointCredential`, the Session's
// RPC; only a Session and text generation call it.
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
});
