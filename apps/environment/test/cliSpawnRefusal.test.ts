// SPI-1176: a CLI spawn the Environment refuses (no Model endpoint serves the CLI) shows its reason in t3, not t3's
// "Failed to open <driver> provider session <id>." The wrapper puts a `ProviderSetupError` with the refusal under t3's
// open error, and t3's failure text reads through to it (`knownProviderFailureMessage`, as `ProviderTurnStartService`'s
// `startFailureMessage` does).
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { describe, expect, it } from "vitest";
import { noEndpointFor } from "../src/agents/cliProfiles.ts";
import { spawnRefusalOf, wrapCliAdapter } from "../src/provider/cli/wrapper.ts";

const driver = ProviderDriverKind.make("codex");
const providerSessionId = ProviderSessionId.make("session-1");
const instanceId = ProviderInstanceId.make("codex");
const refusal = noEndpointFor("Codex", "OpenAI Responses");
const spawnError = (tag: "PermissionDenied" | "Unknown", description: string) =>
  PlatformError.systemError({ _tag: tag, module: "ChildProcess", method: "spawn", description, pathOrDescriptor: "codex" });

describe("the CLI wrapper's open (SPI-1176)", () => {
  /** A stand-in for t3's adapter whose open fails as t3's Codex adapter's does on a refused spawn. */
  const refusing = (cause: unknown) =>
    ({
      instanceId,
      driver,
      getCapabilities: () => Effect.die("unused"),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.fail(new ProviderAdapter.ProviderAdapterOpenSessionError({ driver, providerSessionId, cause })),
    }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const open = (adapter: ProviderAdapter.ProviderAdapterV2["Service"]) =>
    Effect.runPromise(
      Effect.scoped(
        wrapCliAdapter(adapter, { sessions: new Map() }).openSession({
          threadId: ThreadId.make("thread-refused"),
          providerSessionId,
          modelSelection: { instanceId, model: "x" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode: "default", cwd: "/w/x" }),
        } as never),
      ).pipe(Effect.flip),
    );

  it("fails a refused spawn's open with the refusal as t3's failure text", async () => {
    const cause = spawnError("PermissionDenied", `t3flare: ${refusal}`);
    // Unmapped, t3's own open error shows nothing: the refusal reaches t3 through the wrapper alone.
    expect(knownProviderFailureMessage({ cause: new ProviderAdapter.ProviderAdapterOpenSessionError({ driver, providerSessionId, cause }) })).toBeUndefined();
    const failed = await open(refusing(cause));
    expect(failed._tag).toBe("ProviderAdapterOpenSessionError");
    expect(knownProviderFailureMessage({ cause: failed })).toBe(`${refusal}.`);
    expect(refusal).toContain("Settings page");
  });

  it("passes any other open failure through as it was", async () => {
    const failed = await open(refusing(spawnError("Unknown", "t3flare: the Container did not start")));
    expect(knownProviderFailureMessage({ cause: failed })).toBeUndefined();
    // Only the Environment's own refusal reads through: a bare permission error from the OS is not one.
    expect(spawnRefusalOf(spawnError("PermissionDenied", "EACCES"))).toBeUndefined();
  });
});
