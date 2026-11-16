// @effect-diagnostics globalDate:off
// t3's limit meters from t3flare's own limit readings (SPI-1174): the windows each subscription endpoint's answers report
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
//   Never a token, an account or an organization. A removed endpoint's windows are dropped at the next write.
// - **Stale meters say so.** A window not read for `STALE_AFTER_MS` (no answer on the endpoint since) is shown with when
//   it was last read, as its source's notice; one whose reset has passed is shown reset (0 % used), as the vendor's window
//   is, until an answer reads it again.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { acceptedLimitReading, familyOfWindow, LIMIT_WINDOW_IDS, type LimitFamily, type LimitWindowId, MAX_LIMIT_READINGS } from "@t3flare/models/limits";

/** A window not read for this long shows when it was last read. */
export const STALE_AFTER_MS = 30 * 60 * 1000;
/** A reading's time may be this far ahead of the Environment's clock (another isolate's); later ones are dropped. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;
/** The source ids t3 shows: one per endpoint. */
export const LIMIT_SOURCE_PREFIX = "t3flare-endpoint-";

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
  /** Called after a write that kept anything (t3's meters update at once). */
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
      if (kept > 0) {
        // A removed endpoint's windows go with the next write (endpoint ids are never reused for another endpoint).
        const ids = [...current];
        sql.exec(`DELETE FROM t3flare_limit_windows WHERE endpoint NOT IN (${ids.map(() => "?").join(", ")})`, ...ids);
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            // A listener's failure is its own.
          }
        }
      }
      return kept;
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

// ---- t3's view: one limit source per endpoint ----

/** t3's driver whose meter a family's windows show as (its icon, color and pooling). */
const DRIVER: Readonly<Record<LimitFamily, string>> = { codex: "codex", claude: "claudeAgent" };

type Kind = "session" | "weekly" | "monthly" | "other";

const DAY_MINUTES = 24 * 60;

/** A window's kind by its length (Codex's slots are five hours and a week); by its slot when the length is unknown. */
const kindOf = (id: LimitWindowId, minutes: number | null): Kind => {
  if (minutes === null) return id === "primary" || id === "five_hour" ? "session" : "weekly";
  if (minutes <= DAY_MINUTES) return "session";
  if (minutes <= 8 * DAY_MINUTES) return "weekly";
  if (minutes >= 28 * DAY_MINUTES) return "monthly";
  return "other";
};

/** A window's label by its length, as Codex and Claude name theirs ("5-hour", "Weekly"). */
const labelOf = (id: LimitWindowId, minutes: number | null): string => {
  if (minutes === null) return id === "primary" ? "Primary" : id === "secondary" ? "Secondary" : id === "five_hour" ? "5-hour" : "Weekly";
  if (minutes === 7 * DAY_MINUTES) return "Weekly";
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
};

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** How long ago, in the largest whole unit: "12 minutes ago", "3 hours ago", "2 days ago". */
export const agoText = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The notice of an endpoint whose windows are stale: when each was last read ("Last read 3 hours ago …" when they all
 * read the same, else one part per stale window), or undefined while every window is fresh.
 */
const staleNotice = (windows: ReadonlyArray<StoredWindow>, now: number): string | undefined => {
  const stale = windows.filter((window) => now - window.at >= STALE_AFTER_MS);
  if (stale.length === 0) return undefined;
  const why = "limits are read from this endpoint's answers";
  const agos = new Set(stale.map((window) => agoText(now - window.at)));
  if (stale.length === windows.length && agos.size === 1) return `Last read ${[...agos][0]} (${why}).`;
  return `${stale.map((window) => `${labelOf(window.id, window.windowMinutes)} last read ${agoText(now - window.at)}`).join("; ")} (${why}).`;
};

/**
 * t3's limit sources: one per current endpoint with a kept window, labelled with the endpoint's label, one account per
 * vendor family (named by the endpoint's id: no account identity is kept). A window whose reset has passed shows reset;
 * a stale source carries its notice.
 */
export const limitSnapshots = (windows: ReadonlyArray<StoredWindow>, endpoints: ModelEndpoints, now: number): ReadonlyArray<UsageLimitSourceSnapshot> =>
  endpoints.endpoints.flatMap((endpoint): ReadonlyArray<UsageLimitSourceSnapshot> => {
    const own = windows.filter((window) => window.endpoint === endpoint.id);
    if (own.length === 0) return [];
    const families = [...new Set(own.map((window) => familyOfWindow(window.id)))];
    const accounts = families.map((family) => {
      const mine = own.filter((window) => familyOfWindow(window.id) === family);
      return {
        id: families.length === 1 ? endpoint.id : `${endpoint.id} (${family})`,
        driver: DRIVER[family],
        usageLimits: {
          checkedAt: iso(Math.max(...mine.map((window) => window.at))),
          windows: mine.map((window) => {
            const pending = window.resetsAt !== null && window.resetsAt > now;
            return {
              id: window.id,
              kind: kindOf(window.id, window.windowMinutes),
              label: labelOf(window.id, window.windowMinutes),
              // A window past its reset has reset at the vendor; the next answer reads its new use.
              usedPercent: window.resetsAt === null || pending ? window.usedPercent : 0,
              ...(pending ? { resetsAt: iso(window.resetsAt!) } : {}),
              ...(window.windowMinutes === null ? {} : { windowDurationMins: window.windowMinutes }),
            };
          }),
        },
      };
    });
    const notice = staleNotice(own, now);
    // SAFETY: the snapshot is t3's `UsageLimitSourceSnapshot` field for field; its branded strings (the source id, the
    // driver kind, the ISO times) are plain strings as t3's own sources hold them.
    return [
      {
        id: `${LIMIT_SOURCE_PREFIX}${endpoint.id}`,
        kind: "cliproxy",
        label: endpoint.label,
        checkedAt: iso(Math.max(...own.map((window) => window.at))),
        accounts,
        ...(notice === undefined ? {} : { error: notice }),
      } as unknown as UsageLimitSourceSnapshot,
    ];
  });
