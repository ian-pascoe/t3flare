// Limit readings (SPI-1174): a subscription endpoint's usage windows, read from the rate-limit headers of its answers, which
// feed t3's limit meters. The Session (each Durable answer on an endpoint) and the model relay (each CLI request) read
// them where SPI-1173 records usage, and send them to the Environment DO (`recordLimits`), which keeps the latest of each
// window and shows one limit source per endpoint.
//
// Two vendors send windows in headers, each read as its own client reads them (U84 pins both shapes):
//
// - **ChatGPT's Codex limits**: `x-codex-primary-used-percent` (a percentage, decimal), `x-codex-primary-window-minutes`
//   (whole minutes) and `x-codex-primary-reset-at` (epoch seconds), and the same for `secondary`. Codex's own reader:
//   openai/codex `codex-rs/codex-api/src/rate_limits.rs` at 662a634e, `parse_rate_limit_for_limit` (:57, the names at
//   :68-80) and `parse_rate_limit_window` (:195, a window only with a used percent, and not an all-zero one: :207-215).
//   Only the default `codex` family is read; Codex also reads other `x-<limit>-primary-*` families (:28), which name
//   model-specific limits.
// - **Claude's unified limits**: `anthropic-ratelimit-unified-5h-utilization` (a fraction: 0.42 is 42 %),
//   `anthropic-ratelimit-unified-5h-reset` (epoch seconds) and `-5h-status`, the same for `7d`; and the overall
//   `anthropic-ratelimit-unified-status` with its `-representative-claim` and `-reset`. Not in Anthropic's docs: read as
//   Claude Code 2.1.325 reads them (its binary's `strings`: the claims table `[["five_hour","5h"],["seven_day","7d"],…]`
//   and the reader `Rn` that takes `-utilization`, `-reset`, `-surpassed-threshold`, `-status` per claim, a utilization
//   shown as `Math.round(utilization*100)`), as SPI-1172 read the reset's unit.
//
// GitHub Copilot sends no documented header of its plan's quota (its premium requests are read from its own account API,
// which a model answer does not carry), so a Copilot endpoint has no meter.
//
// Defensive, as lenient as the vendors' own clients: a number is read as Claude Code's `Number()` and Codex's
// `parse::<f64>` read it (a decimal with any fraction or an exponent: `0.30000000000000004`, `1e-05`), but only a finite
// one of at least 0 and with no sign, unit or hex prefix (where the two clients disagree, neither reads it). A used share
// is clamped to 100 % (an overspent window is spent); a reset is rounded to the second, as Claude Code does, and kept only
// when it is after the answer and within a year of it; a length is rounded to the minute and kept from 1 minute to 31
// days. Anything else drops that value (a window with no used share is not read at all). Nothing here can fail an
// answer. A reading names its endpoint and its windows: never a token, an account or an organization (Anthropic's
// `anthropic-organization-id` is not read).
import { ENDPOINT_ID } from "./endpoints.ts";

/** The windows read: ChatGPT's primary and secondary, Claude's five-hour and seven-day. */
export const LIMIT_WINDOW_IDS = ["primary", "secondary", "five_hour", "seven_day"] as const;
export type LimitWindowId = (typeof LIMIT_WINDOW_IDS)[number];

/** Whose windows they are: the vendor's family, which picks t3's driver for the meter. */
export type LimitFamily = "codex" | "claude";

/** t3's kinds of window (`ServerProviderUsageWindow.kind`). */
export type LimitWindowKind = "session" | "weekly" | "monthly" | "other";

/**
 * Each window's facts: its vendor, how it is named and of what kind when its length is not known (Codex names slots, so
 * its primary is its short window), and, for Claude's, the claim its headers name and its fixed length.
 */
export const LIMIT_WINDOWS: Readonly<
  Record<LimitWindowId, { readonly family: LimitFamily; readonly label: string; readonly kind: LimitWindowKind; readonly claude?: { readonly claim: "5h" | "7d"; readonly minutes: number } }>
> = {
  primary: { family: "codex", label: "Primary", kind: "session" },
  secondary: { family: "codex", label: "Secondary", kind: "weekly" },
  five_hour: { family: "claude", label: "5-hour", kind: "session", claude: { claim: "5h", minutes: 5 * 60 } },
  seven_day: { family: "claude", label: "Weekly", kind: "weekly", claude: { claim: "7d", minutes: 7 * 24 * 60 } },
};

export const familyOfWindow = (id: LimitWindowId): LimitFamily => LIMIT_WINDOWS[id].family;

export interface LimitWindowReading {
  readonly id: LimitWindowId;
  /** 0 to 100. */
  readonly usedPercent: number;
  /** When the window resets (epoch ms, whole seconds), when the answer said and it is plausible. */
  readonly resetsAt?: number;
  /** The window's length in minutes, when known. */
  readonly windowMinutes?: number;
}

/** One answer's windows on one endpoint, and when the answer came (epoch ms): the latest answer's window wins. */
export interface LimitReading {
  readonly endpointId: string;
  readonly at: number;
  readonly windows: ReadonlyArray<LimitWindowReading>;
}

/** The longest window kept: a month and a day (ChatGPT's and Claude's are five hours and a week). */
export const MAX_WINDOW_MINUTES = 31 * 24 * 60;
/** How far after the answer a reset may be: past this it is not a window's reset. */
export const MAX_RESET_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** The most readings one `recordLimits` call carries. */
export const MAX_LIMIT_READINGS = 16;

/** A plain decimal, with any fraction and an exponent: what both vendors' clients read (no sign, unit or hex prefix). */
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

interface HeaderSource {
  get(name: string): string | null;
}

const header = (headers: HeaderSource, name: string): string | undefined => {
  const value = headers.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** A finite number of at least 0, or undefined. */
const numberOf = (text: string | undefined): number | undefined => {
  if (text === undefined || !NUMBER.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** A reset (epoch ms) when it is after the answer and within `MAX_RESET_AHEAD_MS` of it; undefined otherwise. */
export const plausibleReset = (ms: number | undefined, at: number): number | undefined =>
  ms !== undefined && Number.isFinite(ms) && ms > at && ms - at <= MAX_RESET_AHEAD_MS ? ms : undefined;

/** A window's length in whole minutes, from 1 minute to `MAX_WINDOW_MINUTES`; undefined otherwise. */
export const plausibleMinutes = (minutes: number | undefined): number | undefined => {
  if (minutes === undefined || !Number.isFinite(minutes)) return undefined;
  const whole = Math.round(minutes);
  return whole >= 1 && whole <= MAX_WINDOW_MINUTES ? whole : undefined;
};

/** A reset in epoch seconds (rounded, as Claude Code rounds it) as epoch ms, when plausible. */
const resetOf = (text: string | undefined, at: number): number | undefined => {
  const seconds = numberOf(text);
  return seconds === undefined ? undefined : plausibleReset(Math.round(seconds) * 1000, at);
};

/** One window: its share clamped to 100 %, and only the reset and length given. */
const window = (read: { readonly id: LimitWindowId; readonly usedPercent: number; readonly resetsAt?: number | undefined; readonly windowMinutes?: number | undefined }): LimitWindowReading => ({
  id: read.id,
  usedPercent: Math.min(100, Math.max(0, read.usedPercent)),
  ...(read.resetsAt === undefined ? {} : { resetsAt: read.resetsAt }),
  ...(read.windowMinutes === undefined ? {} : { windowMinutes: read.windowMinutes }),
});

/** ChatGPT's Codex windows, as Codex reads them (`rate_limits.rs` `parse_rate_limit_window`). */
const codexWindows = (headers: HeaderSource, at: number): ReadonlyArray<LimitWindowReading> =>
  (["primary", "secondary"] as const).flatMap((id) => {
    const used = numberOf(header(headers, `x-codex-${id}-used-percent`));
    if (used === undefined) return [];
    const rawMinutes = numberOf(header(headers, `x-codex-${id}-window-minutes`));
    const rawReset = header(headers, `x-codex-${id}-reset-at`);
    // Codex drops a window that says nothing: no use, no length, no reset.
    if (used === 0 && (rawMinutes === undefined || rawMinutes === 0) && rawReset === undefined) return [];
    return [window({ id, usedPercent: used, resetsAt: resetOf(rawReset, at), windowMinutes: plausibleMinutes(rawMinutes) })];
  });

/**
 * Claude's unified windows, as Claude Code reads them. A claim the answer refused (`rejected`) with no utilization is
 * spent: its own status, or the overall one naming it as the representative claim (with the overall reset).
 */
const claudeWindows = (headers: HeaderSource, at: number): ReadonlyArray<LimitWindowReading> => {
  const overall = header(headers, "anthropic-ratelimit-unified-status");
  const representative = header(headers, "anthropic-ratelimit-unified-representative-claim");
  return (["five_hour", "seven_day"] as const).flatMap((id) => {
    const { claim, minutes } = LIMIT_WINDOWS[id].claude!;
    const prefix = `anthropic-ratelimit-unified-${claim}`;
    const utilization = numberOf(header(headers, `${prefix}-utilization`));
    const resetsAt = resetOf(header(headers, `${prefix}-reset`), at);
    if (utilization !== undefined) return [window({ id, usedPercent: utilization * 100, resetsAt, windowMinutes: minutes })];
    if (header(headers, `${prefix}-status`) === "rejected") return [window({ id, usedPercent: 100, resetsAt, windowMinutes: minutes })];
    if (overall === "rejected" && representative === id) {
      return [window({ id, usedPercent: 100, resetsAt: resetsAt ?? resetOf(header(headers, "anthropic-ratelimit-unified-reset"), at), windowMinutes: minutes })];
    }
    return [];
  });
};

/**
 * The windows an answer's headers report, whichever vendor's they are (the names are each vendor's own, so one never
 * reads as the other); none for an answer with no limit headers. Never throws.
 */
export const limitWindowsOf = (headers: HeaderSource, at: number): ReadonlyArray<LimitWindowReading> => {
  try {
    return [...codexWindows(headers, at), ...claudeWindows(headers, at)];
  } catch {
    return [];
  }
};

/** The reading of an endpoint's answer, or undefined when it reports no window. */
export const limitReadingOf = (endpointId: string, headers: HeaderSource, at: number): LimitReading | undefined => {
  const windows = limitWindowsOf(headers, at);
  return windows.length === 0 ? undefined : { endpointId, at, windows };
};

/**
 * What every reader does with an answer's headers (the Session's fetch, the model relay): its reading, if any, to `send`.
 * Never throws: a reading that fails is lost, never the answer.
 */
export const noteLimitReading = (endpointId: string, headers: HeaderSource, at: number, send: (reading: LimitReading) => void): void => {
  try {
    const reading = limitReadingOf(endpointId, headers, at);
    if (reading !== undefined) send(reading);
  } catch {
    // Lost; the answer goes on.
  }
};

const isWindowId = (value: unknown): value is LimitWindowId => typeof value === "string" && (LIMIT_WINDOW_IDS as ReadonlyArray<string>).includes(value);

/**
 * A reading as the Environment accepts it from the agents Worker, or undefined: an endpoint id, a time, and windows each
 * with a known id and a used share from 0 to 100; a reset or a length that is not plausible is dropped, and so is a
 * second window of the same id.
 */
export const acceptedLimitReading = (value: unknown): LimitReading | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { endpointId, at, windows } = value as Record<string, unknown>;
  if (typeof endpointId !== "string" || !ENDPOINT_ID.test(endpointId)) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || !Array.isArray(windows)) return undefined;
  const seen = new Set<LimitWindowId>();
  const kept = windows.slice(0, LIMIT_WINDOW_IDS.length).flatMap((raw: unknown): ReadonlyArray<LimitWindowReading> => {
    if (typeof raw !== "object" || raw === null) return [];
    const { id, usedPercent, resetsAt, windowMinutes } = raw as Record<string, unknown>;
    if (!isWindowId(id) || seen.has(id)) return [];
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
    seen.add(id);
    return [
      window({
        id,
        usedPercent,
        resetsAt: plausibleReset(typeof resetsAt === "number" ? Math.trunc(resetsAt) : undefined, at),
        windowMinutes: typeof windowMinutes === "number" && Number.isInteger(windowMinutes) ? plausibleMinutes(windowMinutes) : undefined,
      }),
    ];
  });
  return kept.length === 0 ? undefined : { endpointId, at: Math.trunc(at), windows: kept };
};
