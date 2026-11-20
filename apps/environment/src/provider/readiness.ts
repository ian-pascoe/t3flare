// A provider's readiness for its models (SPI-1176), for Pi Durable and the CLI drivers alike: ready with a model; with
// none (no Model endpoint lists one it can use), it needs setup, its message pointing to the Settings page. t3 shows a
// `warning` provider as "Needs attention" with the message, and its banner on a thread of that provider.
import type { ServerProviderModel } from "@t3tools/contracts";
import type { ProviderProbeResult } from "@t3tools/provider-core/server/snapshotProbe";

/** The probe for `models`: `ready` (with `ready` as its message, if any), or needing setup with `setup` as its message. */
export const readinessOf = (models: ReadonlyArray<ServerProviderModel>, version: string | null, setup: string, ready?: string): ProviderProbeResult =>
  models.length > 0
    ? { installed: true, version, status: "ready", auth: { status: "authenticated" }, ...(ready === undefined ? {} : { message: ready }) }
    : { installed: true, version, status: "warning", auth: { status: "unknown" }, message: setup };
