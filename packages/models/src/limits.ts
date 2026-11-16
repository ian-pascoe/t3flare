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
// Strict and defensive: a value is read only in its documented form (digits, a decimal point; no sign, exponent or
// unit), a used share is clamped to 100 % (an overspent window is spent) and never negative, a reset is kept only when it
// is after the answer and within a year of it, and anything else drops that value (a window with no used share is not
// read at all). Nothing here can fail an answer. A reading names its endpoint and its windows: never a token, an account
// or an organization (Anthropic's `anthropic-organization-id` is not read).
import { ENDPOINT_ID } from "./endpoints.ts";

/** The windows read: ChatGPT's primary and secondary, Claude's five-hour and seven-day. */
export const LIMIT_WINDOW_IDS = ["primary", "secondary", "five_hour", "seven_day"] as const;
export type LimitWindowId = (typeof LIMIT_WINDOW_IDS)[number];

/** Whose windows they are: the vendor's family, which picks t3's driver for the meter. */
export type LimitFamily = "codex" | "claude";

export const familyOfWindow = (id: LimitWindowId): LimitFamily => (id === "primary" || id === "secondary" ? "codex" : "claude");

export interface LimitWindowReading {
  readonly id: LimitWindowId;
  /** 0 to 100. */
  readonly usedPercent: number;
  /** When the window resets (epoch ms), when the answer said and it is plausible. */
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

/** Claude's known windows' lengths: its headers name the claim, not its length. */
const CLAUDE_MINUTES = { five_hour: 5 * 60, seven_day: 7 * 24 * 60 } as const;

const DECIMAL = /^\d{1,9}(?:\.\d{1,9})?$/;
const INTEGER = /^\d{1,15}$/;

interface HeaderSource {
  get(name: string): string | null;
}

const header = (headers: HeaderSource, name: string): string | undefined => {
  const value = headers.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const decimal = (text: string | undefined): number | undefined => {
  if (text === undefined || !DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

const integer = (text: string | undefined): number | undefined => (text === undefined || !INTEGER.test(text) ? undefined : Number(text));

/** A used share as a percentage: clamped to 100, never negative (the forms read have no sign). */
const percent = (value: number): number => Math.min(100, Math.max(0, value));

/** A reset in epoch seconds as epoch ms, when it is after the answer and within a year of it. */
const resetOf = (text: string | undefined, at: number): number | undefined => {
  const seconds = integer(text);
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000;
  return ms > at && ms - at <= MAX_RESET_AHEAD_MS ? ms : undefined;
};

const minutesOf = (text: string | undefined): number | undefined => {
  const minutes = integer(text);
  return minutes !== undefined && minutes > 0 && minutes <= MAX_WINDOW_MINUTES ? minutes : undefined;
};

const window = (id: LimitWindowId, usedPercent: number, resetsAt: number | undefined, windowMinutes: number | undefined): LimitWindowReading => ({
  id,
  usedPercent: percent(usedPercent),
  ...(resetsAt === undefined ? {} : { resetsAt }),
  ...(windowMinutes === undefined ? {} : { windowMinutes }),
});

/** ChatGPT's Codex windows, as Codex reads them (`rate_limits.rs` `parse_rate_limit_window`). */
const codexWindows = (headers: HeaderSource, at: number): ReadonlyArray<LimitWindowReading> =>
  (["primary", "secondary"] as const).flatMap((slot) => {
    const used = decimal(header(headers, `x-codex-${slot}-used-percent`));
    if (used === undefined) return [];
    const rawMinutes = integer(header(headers, `x-codex-${slot}-window-minutes`));
    const rawReset = header(headers, `x-codex-${slot}-reset-at`);
    // Codex drops a window that says nothing: no use, no length, no reset.
    if (used === 0 && (rawMinutes === undefined || rawMinutes === 0) && rawReset === undefined) return [];
    return [window(slot, used, resetOf(rawReset, at), minutesOf(header(headers, `x-codex-${slot}-window-minutes`)))];
  });

/**
 * Claude's unified windows, as Claude Code reads them. A claim the answer refused (`rejected`) with no utilization is
 * spent: its own status, or the overall one naming it as the representative claim (with the overall reset).
 */
const claudeWindows = (headers: HeaderSource, at: number): ReadonlyArray<LimitWindowReading> => {
  const overall = header(headers, "anthropic-ratelimit-unified-status");
  const representative = header(headers, "anthropic-ratelimit-unified-representative-claim");
  return (
    [
      ["five_hour", "5h"],
      ["seven_day", "7d"],
    ] as const
  ).flatMap(([id, claim]) => {
    const prefix = `anthropic-ratelimit-unified-${claim}`;
    const utilization = decimal(header(headers, `${prefix}-utilization`));
    const reset = resetOf(header(headers, `${prefix}-reset`), at);
    if (utilization !== undefined) return [window(id, utilization * 100, reset, CLAUDE_MINUTES[id])];
    if (header(headers, `${prefix}-status`) === "rejected") return [window(id, 100, reset, CLAUDE_MINUTES[id])];
    if (overall === "rejected" && representative === id) {
      return [window(id, 100, reset ?? resetOf(header(headers, "anthropic-ratelimit-unified-reset"), at), CLAUDE_MINUTES[id])];
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
    const reset = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > at && resetsAt - at <= MAX_RESET_AHEAD_MS ? Math.trunc(resetsAt) : undefined;
    const minutes = typeof windowMinutes === "number" && Number.isInteger(windowMinutes) && windowMinutes > 0 && windowMinutes <= MAX_WINDOW_MINUTES ? windowMinutes : undefined;
    return [window(id, usedPercent, reset, minutes)];
  });
  return kept.length === 0 ? undefined : { endpointId, at: Math.trunc(at), windows: kept };
};
