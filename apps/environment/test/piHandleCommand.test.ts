// @effect-diagnostics nodeBuiltinImport:off
// SPI-1170: the image's pi launcher and handle command (`apps/sandbox-image/image/t3flare-pi`, `t3flare-pi-handle`) are
// shell, so what they restate is checked against its TypeScript sources here; what they do is `test:docker`'s
// (`piRelay.docker.test.ts`) and the stage's (`scripts/p1170.ts`).
import * as fs from "node:fs";
import * as path from "node:path";

import { MODEL_HANDLE_ENV } from "@t3flare/models/relay";
import { HANDLE } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { CLI_BIN, PI_HANDLE_COMMAND, PI_HANDLE_HOLDERS } from "../src/agents/cliProfiles.ts";

const image = path.resolve(import.meta.dirname, "../../sandbox-image/image");
const read = (name: string) => fs.readFileSync(path.join(image, name), "utf8");

describe("pi's launcher and handle command", () => {
  it("starts pi without the handle", () => {
    expect(read("t3flare-pi")).toMatch(new RegExp(`^exec env -u ${MODEL_HANDLE_ENV} \\S+/node \\S+/cli\\.js "\\$@"$`, "m"));
  });

  it("takes the handle only from the holder whose command line starts as PI_HANDLE_HOLDERS says, of this process's marker", () => {
    const script = read("t3flare-pi-handle");
    const words = /if \[ "\$words" = "([^"]+) " \]/.exec(script)?.[1];
    // The holder's first three words: setsid's, and the launcher the profile's argv names.
    expect(words).toBe("setsid --wait /opt/t3flare/bin/pi");
    expect(PI_HANDLE_HOLDERS).toEqual([`${words} --mode rpc`]);
    expect(script).toContain('grep -qxF "T3FLARE_EXEC=$marker"');
    expect(script).toContain(`s/^${MODEL_HANDLE_ENV}=//p`);
  });

  it("prints only a handle's shape (64 hex digits, as HANDLE)", () => {
    expect(HANDLE.source).toBe("^[0-9a-f]{64}$");
    const script = read("t3flare-pi-handle");
    expect(script).toContain("*[!0-9a-f]*");
    expect(script).toContain('[ "${#handle}" -eq 64 ]');
  });

  it("is installed where the profile names it, beside the launcher", () => {
    expect(PI_HANDLE_COMMAND).toBe(`${CLI_BIN}/t3flare-pi-handle`);
    for (const dockerfile of [path.join(image, "Dockerfile"), path.resolve(import.meta.dirname, "docker/Dockerfile")]) {
      const text = fs.readFileSync(dockerfile, "utf8");
      expect(text, dockerfile).toContain(`COPY --chmod=755 t3flare-pi-handle ${PI_HANDLE_COMMAND}`);
      expect(text, dockerfile).toContain(`COPY --chmod=755 t3flare-pi ${CLI_BIN}/pi`);
    }
  });
});
