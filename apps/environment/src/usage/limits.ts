// The limit readings t3flare keeps for t3's limit meters (SPI-1174): the windows each subscription endpoint's answers report
// in their rate-limit headers (`@t3flare/models/limits`), read by the Sessions, text generation and the model relay and
// sent through `recordLimits`. The Environment DO keeps the latest of each window, by endpoint, in its SQLite, so a
// reading outlives an eviction; `limitSources.ts` shows one t3 limit source per endpoint that has any.
//
// - **Last writer by response time.** A window is replaced only by a reading of a later answer (`at`, when the answer's
//   headers arrived where it was read), never by one that merely arrived later: many Sessions and CLI processes answer at
//   once, and their sends race.
// - **Per window.** An answer may report only some of an endpoint's windows (Claude's sends its seven-day window without
//   its five-hour one at times), so each window keeps its own latest reading.
// - **Only what a meter needs**: the endpoint's id, the window, its used share, reset and length, and when it was read.
//   Never a token, an account or an organization. A removed endpoint's windows are forgotten with it (`forget`), so an
//   endpoint added again under the same id starts with none.
//
// How t3 shows them (staleness, passed resets) is `limitMeters.ts`.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { acceptedLimitReading, LIMIT_WINDOW_IDS, type LimitWindowId, MAX_LIMIT_READINGS } from "@t3flare/models/limits";

/** A reading's time may be this far ahead of the Environment's clock (another isolate's); later ones are dropped. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;
/** One window's latest reading. */
export interface StoredWindow {
  readonly endpoint: string;
  readonly id: LimitWindowId;
  /** When the answer it was read from came (epoch ms). */
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly windowMinutes: number | null;
}

export interface LimitStore {
  /** Keeps each window of the valid readings on a current endpoint that is newer than the one kept; how many were kept. */
  record(input: unknown, endpoints: ModelEndpoints, now: number): number;
  /** Every window kept. */
  read(): ReadonlyArray<StoredWindow>;
  /** Drops a removed endpoint's windows. */
  forget(endpointId: string): void;
  /** Called after a write that kept anything, and after a `forget` (t3's meters update). */
  subscribe(listener: () => void): () => void;
}

let ready = new WeakSet<SqlStorage>();

const ensure = (sql: SqlStorage) => {
  if (ready.has(sql)) return;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS t3flare_limit_windows (
      endpoint TEXT NOT NULL, window TEXT NOT NULL, at INTEGER NOT NULL, used_percent REAL NOT NULL, resets_at INTEGER, window_minutes INTEGER,
      PRIMARY KEY (endpoint, window))`,
  );
  ready.add(sql);
};

/** For tests: forget which databases have their table. */
export const resetLimitStoreForTests = (): void => {
  ready = new WeakSet();
};

type Row = { endpoint: string; window: string; at: number; used_percent: number; resets_at: number | null; window_minutes: number | null };

export const limitStore = (sql: SqlStorage): LimitStore => {
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  };
  return {
    record(input, endpoints, now) {
      ensure(sql);
      const raw = typeof input === "object" && input !== null ? (input as { readonly readings?: unknown }).readings : undefined;
      const current = new Set(endpoints.endpoints.map((endpoint) => endpoint.id));
      let kept = 0;
      for (const value of Array.isArray(raw) ? raw.slice(0, MAX_LIMIT_READINGS) : []) {
        const reading = acceptedLimitReading(value);
        if (reading === undefined || !current.has(reading.endpointId) || reading.at > now + FUTURE_SLACK_MS) continue;
        for (const window of reading.windows) {
          // Only a later answer's reading replaces a window: the send that arrives last may carry the older answer.
          const changed = sql.exec(
            `INSERT INTO t3flare_limit_windows (endpoint, window, at, used_percent, resets_at, window_minutes) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (endpoint, window) DO UPDATE SET at = excluded.at, used_percent = excluded.used_percent, resets_at = excluded.resets_at,
               window_minutes = excluded.window_minutes
             WHERE excluded.at > t3flare_limit_windows.at
             RETURNING endpoint`,
            reading.endpointId,
            window.id,
            reading.at,
            window.usedPercent,
            window.resetsAt ?? null,
            window.windowMinutes ?? null,
          ).toArray();
          if (changed.length > 0) kept += 1;
        }
      }
      if (kept > 0) tell();
      return kept;
    },
    forget(endpointId) {
      ensure(sql);
      if (sql.exec("DELETE FROM t3flare_limit_windows WHERE endpoint = ? RETURNING endpoint", endpointId).toArray().length > 0) tell();
    },
    read() {
      ensure(sql);
      return sql
        .exec<Row>("SELECT endpoint, window, at, used_percent, resets_at, window_minutes FROM t3flare_limit_windows ORDER BY endpoint, window")
        .toArray()
        .flatMap((row): ReadonlyArray<StoredWindow> => {
          const id = LIMIT_WINDOW_IDS.find((known) => known === row.window);
          if (id === undefined) return [];
          return [
            {
              endpoint: row.endpoint,
              id,
              at: Number(row.at),
              usedPercent: Number(row.used_percent),
              resetsAt: row.resets_at === null ? null : Number(row.resets_at),
              windowMinutes: row.window_minutes === null ? null : Number(row.window_minutes),
            },
          ];
        });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
