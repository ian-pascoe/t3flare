// @effect-diagnostics globalDate:off
// How t3 shows the kept limit readings (SPI-1174; `limits.ts` keeps them): one t3 limit source per subscription endpoint
// with any, its windows with their shares, resets and lengths.
//
// - **Stale meters say so.** A window not read for `STALE_AFTER_MS` (no answer on the endpoint since) gives its source
//   t3's `error`, which t3 shows as a notice beside the still-shown meters: when it was last read.
// - **A passed reset shows reset** (0 % used, no reset time), as the vendor's window is, until an answer reads it again.
import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { familyOfWindow, type LimitFamily, LIMIT_WINDOWS, type LimitWindowId, type LimitWindowKind } from "@t3flare/models/limits";

import type { StoredWindow } from "./limits.ts";

/** A window not read for this long shows when it was last read. */
export const STALE_AFTER_MS = 30 * 60 * 1000;
/** The source ids t3 shows: one per endpoint. */
export const LIMIT_SOURCE_PREFIX = "t3flare-endpoint-";

/** t3's driver whose meter a family's windows show as (its icon, color and pooling). */
const DRIVER: Readonly<Record<LimitFamily, string>> = { codex: "codex", claude: "claudeAgent" };

const DAY_MINUTES = 24 * 60;

/** A window's kind by its length (Codex's slots are five hours and a week); by its own when the length is unknown. */
const kindOf = (id: LimitWindowId, minutes: number | null): LimitWindowKind => {
  if (minutes === null) return LIMIT_WINDOWS[id].kind;
  if (minutes <= DAY_MINUTES) return "session";
  if (minutes <= 8 * DAY_MINUTES) return "weekly";
  if (minutes >= 28 * DAY_MINUTES) return "monthly";
  return "other";
};

/** A window's label by its length, as Codex and Claude name theirs ("5-hour", "Weekly"); by its own when unknown. */
const labelOf = (id: LimitWindowId, minutes: number | null): string => {
  if (minutes === null) return LIMIT_WINDOWS[id].label;
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
 * The account an endpoint's family of windows shows under: the endpoint's id (no account identity is kept), with its
 * family when the endpoint has both vendors' windows (t3 keys an account by source and id).
 */
const accountIdOf = (endpointId: string, family: LimitFamily, families: number): string => (families === 1 ? endpointId : `${endpointId} (${family})`);

/**
 * t3's limit sources: one per current endpoint with a kept window, labelled with the endpoint's label, one account per
 * vendor family. A window whose reset has passed shows reset; a stale source carries its notice.
 */
export const limitSnapshots = (windows: ReadonlyArray<StoredWindow>, endpoints: ModelEndpoints, now: number): ReadonlyArray<UsageLimitSourceSnapshot> =>
  endpoints.endpoints.flatMap((endpoint): ReadonlyArray<UsageLimitSourceSnapshot> => {
    const own = windows.filter((window) => window.endpoint === endpoint.id);
    if (own.length === 0) return [];
    const families = [...new Set(own.map((window) => familyOfWindow(window.id)))];
    const accounts = families.map((family) => {
      const mine = own.filter((window) => familyOfWindow(window.id) === family);
      return {
        id: accountIdOf(endpoint.id, family, families.length),
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
    // SAFETY: the snapshot is t3's `UsageLimitSourceSnapshot` field for field (the tests decode it with t3's schema); its
    // branded strings (the source id, the driver kind, the ISO times) are plain strings as t3's own sources hold them.
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
