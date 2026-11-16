// t3flare's own usage records (SPI-1173), kept in the Environment DO's SQLite: what the Sessions, text generation and the
// model relay record of each model answer on a Model endpoint (`@t3flare/models/usage`, through `recordUsage`), served
// to t3's Usage page by our scan readers (`readers.ts`) in place of any vendor's management API.
//
// Rolled up as they are written: one row per quarter hour, agent, endpoint, model, session and whether the cost is
// known, its counts the sum of the answers'. The Usage page buckets by hour at the finest, so a quarter hour loses
// nothing it shows, and it keeps the time zones whose offset is not whole hours (India's, Nepal's) on the right day. A
// busy session makes one row a quarter hour, not one a request, so a read of the whole window stays small.
//
// Bounded twice: rows older than the retention window (92 days, t3's own: `CACHE_RETENTION_DAYS` in `UsageService.ts`,
// the longest the page keeps a transcript's usage, and more than its widest range) are deleted, and at most
// `MAX_USAGE_ROWS` rows are kept, the oldest dropped first (a guard against a runaway writer: a heavy owner makes a few
// hundred rows a day). Both are pruned on a write, at most once an hour.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import type { EndpointModel, EndpointModelCost, ModelEndpoints } from "@t3flare/models/endpoints";
import { type UsageAgent, type UsageEntry, usageEntryOf } from "@t3flare/models/usage";

export const USAGE_SLOT_MS = 15 * 60 * 1000;
export const USAGE_RETENTION_DAYS = 92;
export const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_USAGE_ROWS = 50_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** An entry's time may be this far ahead of the Environment's clock (another isolate's); later ones are dropped. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;

/** t3's usage provider each agent counts under: Pi's are the Durable agent, text generation and the pi CLI. */
export const PROVIDER_OF: Readonly<Record<UsageAgent, UsageProviderKind>> = {
  durable: "pi",
  "text-generation": "pi",
  pi: "pi",
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
};

/** The agents of one of t3's providers, in the order their sources are listed. */
export const agentsOf = (provider: UsageProviderKind): ReadonlyArray<UsageAgent> =>
  (Object.keys(PROVIDER_OF) as Array<UsageAgent>).filter((agent) => PROVIDER_OF[agent] === provider);

export interface StoredUsage {
  readonly slot: number;
  readonly agent: UsageAgent;
  readonly endpoint: string;
  readonly model: string;
  readonly session: string;
  readonly requests: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  /** null: no price was known when it was written; t3's rate table prices it. */
  readonly costUsd: number | null;
}

export interface UsageStore {
  /** Keeps the valid entries (the others are dropped); how many were kept. */
  record(entries: ReadonlyArray<unknown>, endpoints: ModelEndpoints, now: number): number;
  /** Every row from the quarter hour `sinceMs` is in, oldest first. */
  read(sinceMs: number): ReadonlyArray<StoredUsage>;
}

/**
 * The endpoint's listed model an answer names: the same id, or the longest listed id it is a dated version of
 * (`claude-sonnet-4-5-20250929` of `claude-sonnet-4-5`). Undefined when the endpoint lists neither.
 */
export const listedModelOf = (models: ReadonlyArray<EndpointModel>, modelId: string): EndpointModel | undefined => {
  const exact = models.find((model) => model.id === modelId);
  if (exact !== undefined) return exact;
  let best: EndpointModel | undefined;
  for (const model of models) {
    if (modelId.startsWith(`${model.id}-`) && (best === undefined || model.id.length > best.id.length)) best = model;
  }
  return best;
};

/** What the tokens cost at the model's prices (dollars per million tokens), or null when it has none. */
export const costAt = (cost: EndpointModelCost | undefined, entry: Pick<UsageEntry, "input" | "cacheRead" | "cacheWrite" | "output">): number | null => {
  if (cost === undefined) return null;
  const total = (entry.input * cost.input + entry.cacheRead * cost.cacheRead + entry.cacheWrite * cost.cacheWrite + entry.output * cost.output) / 1_000_000;
  return Number.isFinite(total) && total > 0 ? total : null;
};

type Row = {
  slot: number;
  agent: string;
  endpoint: string;
  model: string;
  session: string;
  priced: number;
  requests: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  cost_usd: number;
};

let ready = new WeakSet<SqlStorage>();

const ensure = (sql: SqlStorage) => {
  if (ready.has(sql)) return;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS t3flare_usage (
      slot INTEGER NOT NULL, agent TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, session TEXT NOT NULL, priced INTEGER NOT NULL,
      requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL, cost_usd REAL NOT NULL,
      PRIMARY KEY (slot, agent, endpoint, model, session, priced))`,
  );
  ready.add(sql);
};

/** For tests: forget which databases have their table. */
export const resetUsageStoreForTests = (): void => {
  ready = new WeakSet();
};

export const usageStore = (sql: SqlStorage, options: { readonly maxRows?: number } = {}): UsageStore => {
  const maxRows = options.maxRows ?? MAX_USAGE_ROWS;
  let prunedAt = Number.NEGATIVE_INFINITY;
  const prune = (now: number) => {
    if (now - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now;
    sql.exec("DELETE FROM t3flare_usage WHERE slot < ?", now - USAGE_RETENTION_MS);
    const rows = Number(sql.exec("SELECT COUNT(*) AS n FROM t3flare_usage").toArray()[0]?.n ?? 0);
    if (rows > maxRows) sql.exec("DELETE FROM t3flare_usage WHERE rowid IN (SELECT rowid FROM t3flare_usage ORDER BY slot LIMIT ?)", rows - maxRows);
  };
  return {
    record(entries, endpoints, now) {
      ensure(sql);
      let kept = 0;
      for (const raw of entries) {
        const entry = usageEntryOf(raw);
        if (entry === undefined || entry.at < now - USAGE_RETENTION_MS || entry.at > now + FUTURE_SLACK_MS) continue;
        const listed = listedModelOf(endpoints.endpoints.find((endpoint) => endpoint.id === entry.endpointId)?.models ?? [], entry.modelId);
        const cost = entry.costUsd ?? costAt(listed?.cost, entry);
        sql.exec(
          `INSERT INTO t3flare_usage (slot, agent, endpoint, model, session, priced, requests, input, cache_read, cache_write, output, reasoning, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (slot, agent, endpoint, model, session, priced) DO UPDATE SET
             requests = requests + 1, input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
             cache_write = cache_write + excluded.cache_write, output = output + excluded.output,
             reasoning = reasoning + excluded.reasoning, cost_usd = cost_usd + excluded.cost_usd`,
          Math.floor(entry.at / USAGE_SLOT_MS) * USAGE_SLOT_MS,
          entry.agent,
          entry.endpointId,
          listed?.id ?? entry.modelId,
          entry.session,
          cost === null ? 0 : 1,
          entry.input,
          entry.cacheRead,
          entry.cacheWrite,
          entry.output,
          entry.reasoning,
          cost ?? 0,
        );
        kept += 1;
      }
      prune(now);
      return kept;
    },
    read(sinceMs) {
      ensure(sql);
      const rows = sql
        .exec<Row>(
          "SELECT slot, agent, endpoint, model, session, priced, requests, input, cache_read, cache_write, output, reasoning, cost_usd FROM t3flare_usage WHERE slot >= ? ORDER BY slot",
          Math.floor(sinceMs / USAGE_SLOT_MS) * USAGE_SLOT_MS,
        )
        .toArray();
      return rows.map((row) => ({
        slot: Number(row.slot),
        agent: row.agent as UsageAgent,
        endpoint: row.endpoint,
        model: row.model,
        session: row.session,
        requests: Number(row.requests),
        input: Number(row.input),
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
        output: Number(row.output),
        reasoning: Number(row.reasoning),
        costUsd: Number(row.priced) === 1 ? Number(row.cost_usd) : null,
      }));
    },
  };
};

/**
 * A row as t3's usage record: its model is the slug (`<endpointId>/<modelId>`, so the page tells endpoints apart) and its
 * rate model the endpoint's own id, which t3's rate table prices when the row's cost is not known.
 */
export const toUsageRecord = (row: StoredUsage): UsageRecord => ({
  provider: PROVIDER_OF[row.agent],
  timestampMs: row.slot,
  model: `${row.endpoint}/${row.model}`,
  rateModel: row.model,
  sessionId: row.session === "" ? "" : `${row.agent}:${row.session}`,
  totals: {
    uncachedInputTokens: row.input,
    cachedInputTokens: row.cacheRead,
    cacheCreationTokens: row.cacheWrite,
    outputTokens: row.output,
    reasoningTokens: Math.min(row.reasoning, row.output),
  },
  reportedCostUsd: row.costUsd,
  speed: "standard",
  dedupeKey: null,
});
