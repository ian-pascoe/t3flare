// @effect-diagnostics nodeBuiltinImport:off
// SPI-1170: the image's pi launcher and handle command (`apps/sandbox-image/image/t3flare-pi`, `t3flare-pi-handle`) are
// shell, so what they restate is checked against its TypeScript sources here; what they do is `test:docker`'s
// (`piRelay.docker.test.ts`) and the stage's (`scripts/p1170.ts`). That they name every program by its absolute path is
// `launchPaths.test.ts`'s, with the rest of the launch path (SPI-1209).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { MODEL_HANDLE_ENV, modelRelayUrl } from "@t3flare/models/relay";
import { isProcessMarker } from "@t3flare/sandbox-image/process";
import { HANDLE } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { CLI_BIN, PI_HANDLE_COMMAND, PI_HANDLE_HOLDERS } from "../src/agents/cliProfiles.ts";

const image = path.resolve(import.meta.dirname, "../../sandbox-image/image");
const read = (name: string) => fs.readFileSync(path.join(image, name), "utf8");

describe("pi's launcher and handle command", () => {
  it("starts pi without the handle, by absolute paths, with the relay's host never proxied", () => {
    const script = read("t3flare-pi");
    expect(script).toMatch(new RegExp(`^exec /usr/bin/env -u ${MODEL_HANDLE_ENV} no_proxy="\\$lower" NO_PROXY="\\$upper" /\\S+/node /\\S+/cli\\.js "\\$@"$`, "m"));
    expect(script).toContain(`relay_host=${new URL(modelRelayUrl("x")).hostname}`);
  });

  it("adds the relay's host to no_proxy and NO_PROXY, each keeping its own entries, and leaves `*` as it is", () => {
    // The launcher with its last line (the exec) printing the two values it would set instead.
    const script = read("t3flare-pi").replace(/^exec .*$/m, `printf '%s|%s' "$lower" "$upper"`);
    const run = (env: Record<string, string>) => {
      const result = spawnSync("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(run({})).toBe("computer.internal|computer.internal");
    expect(run({ NO_PROXY: "example.org" })).toBe("example.org,computer.internal|example.org,computer.internal");
    expect(run({ no_proxy: "a.example" })).toBe("a.example,computer.internal|a.example,computer.internal");
    expect(run({ no_proxy: "a.example", NO_PROXY: "b.example,.c.example" })).toBe("a.example,computer.internal|b.example,.c.example,computer.internal");
    expect(run({ NO_PROXY: "*" })).toBe("*|*");
    expect(run({ no_proxy: "*", NO_PROXY: "b.example" })).toBe("*|b.example,computer.internal");
    expect(run({ no_proxy: "", NO_PROXY: "b.example" })).toBe("computer.internal|b.example,computer.internal");
  });

  it("takes only a process marker's shape (`isProcessMarker`), so no newline can match another line", () => {
    const script = read("t3flare-pi-handle");
    expect(script).toContain('case "$marker" in proc-*) ;;');
    expect(script).toContain('case "$marker" in *[!A-Za-z0-9-]*) fail');
    expect(isProcessMarker("proc-a-B-9")).toBe(true);
    expect(isProcessMarker("proc-a\nT3FLARE_EXEC=x")).toBe(false);
  });

  it("takes the handle only from the holder whose command line starts as PI_HANDLE_HOLDERS says, of this process's marker", () => {
    const script = read("t3flare-pi-handle");
    const words = /if \[ "\$words" = "([^"]+) " \]/.exec(script)?.[1];
    // The holder's first three words: setsid's, and the launcher the profile's argv names.
    expect(words).toBe("setsid --wait /opt/t3flare/bin/pi");
    expect(PI_HANDLE_HOLDERS).toEqual([`${words} --mode rpc`]);
    expect(script).toContain('/usr/bin/grep -qxF "T3FLARE_EXEC=$marker"');
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
