// @effect-diagnostics globalFetch:off globalDate:off
// t3's usage readers for t3flare's agents (`shadows/builtInDrivers.ts`). t3's own readers scan each CLI's transcripts on
// the host; here the agents run in Durable Objects and Containers, so each reader reads two sources:
//
// - t3flare's own usage records (`records.ts`, SPI-1173), one source per agent: every Model endpoint's requests but
//   those Commissary's log counts;
// - Commissary's request log (`commissary.ts`, parity G8, SPI-999), one read serving the four readers: the Model proxy's
//   traffic (and an endpoint's on a key it is read for). Unconfigured, it reports no source. Removed at the hard cut
//   (SPI-1176), with `commissaryCount.ts`' exclusion of its endpoints.
import type { UsageProviderKind } from "@t3tools/contracts";
import type { ProviderUsageReader, ProviderUsageScan, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";
import { CommissaryError, type CommissaryManagement, type CommissaryUsageProvider, type Fetch, readUsageRecords, toUsageRecord, USAGE_PROVIDERS } from "./commissary.ts";
import { agentsOf, type UsageStore, usageRecordOfRow } from "./records.ts";

type ScanReader<Config> = Extract<ProviderUsageReader<Config, never>, { readonly kind: "scan" }>;

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
): ScanReader<Config> => ({
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
export const commissaryUsageReader = <Config>(provider: CommissaryUsageProvider): ScanReader<Config> =>
  makeCommissaryUsageReader<Config>(provider, defaultRead);

// ---- t3flare's own records (SPI-1173) ----

/**
 * A reader of t3flare's own usage records (`records.ts`) for one of t3's providers: one source per agent counted under
 * it (Pi's: the Durable agent, text generation and Pi, the CLI agent), so the page's sources say which agent spent what.
 */
const ownUsageReader = <Config>(provider: UsageProviderKind, store: () => UsageStore): ScanReader<Config> => ({
  kind: "scan",
  provider,
  scan: ({ windowStartMs }) =>
    Effect.sync(() => {
      let rows: ReturnType<UsageStore["read"]> | undefined;
      try {
        rows = store().read(windowStartMs);
      } catch {
        // An unreadable table is a failed source, never a failed page.
      }
      return agentsOf(provider).map((agent): ProviderUsageScan => {
        const dir = `t3flare://usage/${agent}`;
        if (rows === undefined) return { dir, volumeId: "t3flare", status: "failed", message: "t3flare's usage records could not be read.", files: null };
        return { dir, volumeId: "t3flare", status: "ok", files: [{ path: `${dir}/records`, records: rows.filter((row) => row.agent === agent).map(usageRecordOfRow) }] };
      });
    }).pipe(Effect.withSpan("ownUsageReader.scan")),
});

const isCommissaryProvider = (provider: UsageProviderKind): provider is CommissaryUsageProvider => (USAGE_PROVIDERS as ReadonlyArray<string>).includes(provider);

/**
 * The reader t3's usage service runs for `provider`: t3flare's own records, then Commissary's request log for the
 * providers it attributes (`USAGE_PROVIDERS`). The two never count one request twice (`commissaryCount.ts`).
 */
export const usageReader = <Config>(provider: UsageProviderKind): ScanReader<Config> => {
  const own = ownUsageReader<Config>(provider, () => environmentServices().usage);
  if (!isCommissaryProvider(provider)) return own;
  const commissary = commissaryUsageReader<Config>(provider);
  return {
    kind: "scan",
    provider,
    scan: (input) => Effect.zipWith(own.scan(input), commissary.scan(input), (ours, theirs) => [...ours, ...theirs], { concurrent: true }),
  };
};
