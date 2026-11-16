// Commissary's own count, until the hard cut (SPI-1173; removed with the Commissary readers at SPI-1176).
//
// While Commissary's request log is read for the page (`readers.ts`), a request it logs under a principal it is read
// for must not be counted again here. That is every request on an endpoint whose API key is such a principal's
// (`key:<id>` of a `cms_` key: the Model proxy's own, or one listed in COMMISSARY_USAGE_PRINCIPALS), wherever its base
// URL points (a `cms_` key opens nothing but Commissary). Its records are dropped as they arrive: the Session and the
// relay send them as for any endpoint, and only the Environment, which holds the keys, decides. No key leaves it, and
// the decision follows the key the endpoint has now. An endpoint whose key cannot be read is not counted by Commissary
// (it sends no request: the relay and the Session get no key for it), so its records, should any come, are kept. When
// the whole check fails, the call's entries are dropped: a missing record is safer than a doubled one.
import type { EndpointStore } from "../endpoints/store.ts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { MAX_USAGE_ENTRIES, usageEntryOf } from "@t3flare/models/usage";

import { principalOfApiKey } from "./commissary.ts";
import type { UsageStore } from "./records.ts";

/** The ids of the endpoints whose requests Commissary's log counts, from their keys (`apiKeyOf`). */
export const countedByCommissary = async (
  endpoints: ModelEndpoints,
  apiKeyOf: (endpointId: string) => Promise<string | undefined>,
  principals: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const counted = new Set<string>();
  if (principals.length === 0) return counted;
  for (const endpoint of endpoints.endpoints) {
    if (endpoint.auth !== "api-key") continue;
    const principal = principalOfApiKey(await apiKeyOf(endpoint.id).catch(() => undefined));
    if (principal !== undefined && principals.includes(principal)) counted.add(endpoint.id);
  }
  return counted;
};

/**
 * `countedByCommissary`, worked out once per revision of the endpoints (every save, a key's included, makes a new one):
 * each key is opened once per revision, not once per record.
 */
export const commissaryCountedCache = (work: (endpoints: ModelEndpoints) => Promise<ReadonlySet<string>>) => {
  let held: { readonly revision: number; readonly counted: Promise<ReadonlySet<string>> } | undefined;
  return (endpoints: ModelEndpoints): Promise<ReadonlySet<string>> => {
    if (held?.revision !== endpoints.revision) {
      const counted = work(endpoints);
      held = { revision: endpoints.revision, counted };
      // A failed read is not kept: the next record asks again.
      counted.catch(() => {
        if (held?.counted === counted) held = undefined;
      });
    }
    return held.counted;
  };
};

/**
 * What the `recordUsage` RPC keeps: at most `MAX_USAGE_ENTRIES` entries, but none on an endpoint Commissary's log
 * counts; none at all when that cannot be worked out.
 */
export const acceptUsage = async (
  input: unknown,
  deps: {
    readonly store: UsageStore;
    readonly endpoints: ModelEndpoints;
    readonly countedByCommissary: (endpoints: ModelEndpoints) => Promise<ReadonlySet<string>>;
    readonly now: () => number;
  },
): Promise<{ readonly kept: number }> => {
  const raw = typeof input === "object" && input !== null ? (input as { readonly entries?: unknown }).entries : undefined;
  const entries = (Array.isArray(raw) ? raw.slice(0, MAX_USAGE_ENTRIES) : []).flatMap((value: unknown) => usageEntryOf(value) ?? []);
  if (entries.length === 0) return { kept: 0 };
  let counted: ReadonlySet<string>;
  try {
    counted = await deps.countedByCommissary(deps.endpoints);
  } catch {
    return { kept: 0 };
  }
  const ours = entries.filter((entry) => !counted.has(entry.endpointId));
  return { kept: deps.store.record(ours, deps.endpoints, deps.now()) };
};

/**
 * `EnvironmentDO.recordUsage`: `acceptUsage` on the Environment's store and endpoints now, with the exclusion's
 * principals (`commissary.principals`, empty when Commissary's management API is not configured) and the keys opened
 * from the endpoint store, once per revision.
 */
export const usageRecorder = (deps: {
  readonly usage: () => UsageStore;
  readonly principals: () => ReadonlyArray<string>;
  readonly endpoints: Pick<EndpointStore, "load" | "resolve">;
  readonly now: () => number;
}) => {
  const counted = commissaryCountedCache((endpoints) => countedByCommissary(endpoints, async (id) => (await deps.endpoints.resolve(id))?.apiKey, deps.principals()));
  return (input: unknown): Promise<{ readonly kept: number }> => acceptUsage(input, { store: deps.usage(), endpoints: deps.endpoints.load(), countedByCommissary: counted, now: deps.now });
};
