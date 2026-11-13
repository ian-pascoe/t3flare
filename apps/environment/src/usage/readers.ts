// @effect-diagnostics globalFetch:off globalDate:off
// Parity G8 (SPI-999): t3's usage readers for t3flare's agents (`shadows/builtInDrivers.ts`), all from Commissary's
// request log (`commissary.ts`). t3's own readers scan each CLI's transcripts on the host; here the agents run in
// Durable Objects and Containers, and every one of their model calls is in Commissary's log, so one read serves the four
// readers (Pi, Codex, Claude, OpenCode). Unconfigured, each reader reports no source, as before.
import type { UsageProviderKind } from "@t3tools/contracts";
import type { ProviderUsageReader, ProviderUsageScan, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";
import { CommissaryError, type CommissaryManagement, type CommissaryUsageProvider, type Fetch, readUsageRecords, toUsageRecord } from "./commissary.ts";

/** A read is reused for this long by the other readers of one usage request, and by the next request. */
export const USAGE_READ_TTL_MS = 60_000;

interface Read {
  readonly sinceMs: number;
  readonly at: number;
  readonly answer: Promise<{ readonly records: ReadonlyArray<UsageRecord>; readonly truncated: boolean } | { readonly error: string }>;
}

/** One read of Commissary's log, shared (module state: the Environment DO is alone in its isolate). */
export const sharedRead = (now: () => number, fetcher: Fetch) => {
  let last: Read | undefined;
  return (config: CommissaryManagement, sinceMs: number, fresh: boolean): Read["answer"] => {
    const at = now();
    // A read from an earlier start covers a later one; a forced refresh reuses only a read still in flight.
    const reusable = last !== undefined && last.sinceMs <= sinceMs && at - last.at < (fresh ? 1_000 : USAGE_READ_TTL_MS);
    if (reusable && last !== undefined) return last.answer;
    const answer = readUsageRecords(fetcher, config, sinceMs, toUsageRecord).catch((cause: unknown) => ({
      error: cause instanceof CommissaryError ? cause.message : "Commissary's management API could not be read.",
    }));
    last = { sinceMs, at, answer };
    return answer;
  };
};

/** The scan sources a reader reports for its provider from one read. */
export const scansOf = (
  provider: UsageProviderKind,
  read: Awaited<Read["answer"]>,
  label: string,
): ReadonlyArray<ProviderUsageScan> => {
  const dir = `commissary://${label}/${provider}`;
  if ("error" in read) return [{ dir, volumeId: "commissary", files: null, status: "failed", message: read.error }];
  return [
    {
      dir,
      volumeId: "commissary",
      files: [{ path: `${dir}/records`, records: read.records.filter((record) => record.provider === provider) }],
      status: read.truncated ? "partial" : "ok",
      ...(read.truncated ? { message: "Commissary has more requests in this window than one read takes; older ones are left out." } : {}),
    },
  ];
};

export type SharedRead = ReturnType<typeof sharedRead>;

/** A reader for one provider over `read`, with the settings from `config` (the Environment's binding by default). */
export const makeCommissaryUsageReader = <Config>(
  provider: CommissaryUsageProvider,
  read: SharedRead,
  config: () => CommissaryManagement | undefined = () => environmentServices().commissary,
): ProviderUsageReader<Config, never> => ({
  kind: "scan",
  provider,
  scan: Effect.fn("commissaryUsageReader.scan")(function* ({ windowStartMs, awaitRefresh }) {
    const configured = config();
    if (configured === undefined) return [];
    const answer = yield* Effect.promise(() => read(configured, windowStartMs, awaitRefresh));
    return scansOf(provider, answer, new URL(configured.url).host);
  }),
});

const defaultRead = sharedRead(
  () => Date.now(),
  (input, init) => fetch(input, init),
);

/** The reader t3's usage service runs for `provider`. */
export const commissaryUsageReader = <Config>(provider: CommissaryUsageProvider): ProviderUsageReader<Config, never> =>
  makeCommissaryUsageReader<Config>(provider, defaultRead);
