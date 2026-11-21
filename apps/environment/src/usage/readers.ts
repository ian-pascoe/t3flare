// t3's usage readers for t3flare's agents (`shadows/builtInDrivers.ts`). t3's own readers scan each CLI's transcripts on
// the host; here the agents run in Durable Objects and Containers, so each reader reads t3flare's own usage records
// (`records.ts`, SPI-1173), one source per agent: every Model endpoint's requests.
import type { UsageProviderKind } from "@t3tools/contracts";
import type { ProviderUsageReader, ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";
import { agentsOf, type UsageStore, usageRecordOfRow } from "./records.ts";

type ScanReader<Config> = Extract<ProviderUsageReader<Config, never>, { readonly kind: "scan" }>;

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

/** The reader t3's usage service runs for `provider`: t3flare's own records. */
export const usageReader = <Config>(provider: UsageProviderKind): ScanReader<Config> => ownUsageReader<Config>(provider, () => environmentServices().usage);
