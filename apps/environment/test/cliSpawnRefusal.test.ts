// SPI-1176: a CLI spawn the Environment refuses (no Model endpoint serves the CLI) shows its reason in t3, not t3's
// "Failed to open <driver> provider session <id>." The wrapper puts a `ProviderSetupError` with the refusal under t3's
// open error, and t3's failure text reads through to it (`knownProviderFailureMessage`, as `ProviderTurnStartService`'s
// `startFailureMessage` does).
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as PlatformError from "effect/PlatformError";
import { describe, expect, it } from "vitest";
import { noEndpointFor } from "../src/agents/cliProfiles.ts";
import { spawnRefusalOf, withSpawnRefusal } from "../src/provider/cli/wrapper.ts";

const driver = ProviderDriverKind.make("codex");
const providerSessionId = ProviderSessionId.make("session-1");
const instanceId = ProviderInstanceId.make("codex");
const refusal = noEndpointFor("Codex", "OpenAI Responses");
const spawnError = (tag: "PermissionDenied" | "Unknown", description: string) =>
  PlatformError.systemError({ _tag: tag, module: "ChildProcess", method: "spawn", description, pathOrDescriptor: "codex" });

describe("a refused CLI spawn (SPI-1176)", () => {
  it("shows the refusal through t3's open error", () => {
    const opened = new ProviderAdapter.ProviderAdapterOpenSessionError({ driver, providerSessionId, cause: spawnError("PermissionDenied", `t3flare: ${refusal}`) });
    expect(knownProviderFailureMessage({ cause: opened })).toBeUndefined();
    const mapped = withSpawnRefusal(instanceId, driver, providerSessionId)(opened);
    expect(mapped._tag).toBe("ProviderAdapterOpenSessionError");
    // t3's session manager wraps the open error once more before the turn start reads it.
    expect(knownProviderFailureMessage({ cause: mapped })).toBe(`${refusal}.`);
    expect(refusal).toContain("Harness panel");
  });

  it("leaves any other failure as it was", () => {
    const failed = new ProviderAdapter.ProviderAdapterOpenSessionError({ driver, providerSessionId, cause: spawnError("Unknown", "t3flare: the Container did not start") });
    expect(withSpawnRefusal(instanceId, driver, providerSessionId)(failed)).toBe(failed);
    expect(spawnRefusalOf(spawnError("PermissionDenied", "EACCES"))).toBeUndefined();
  });
});
