// @effect-diagnostics globalDate:off
// The publish recorder (step 3+, plan section 4.4): t3's AgentAwarenessRelay calls T3 Connect through its own HTTP
// client, so nothing of ours sees the relay's answer, but it logs each outcome. A Logger of ours keeps the last 100 of
// those events (thread, phase, the relay's delivery counts, a failure's status), mirrored to DO storage so they survive
// a reset, and holds the idle reset while a publish is still pending (review finding 3): a publish in flight, a
// completion inside t3's 5 s confirmation, or a failure t3 will retry. A refusal (401/403) is classified from the
// failure's text, which is never kept (review finding 8). The messages it matches are t3's (fragility U28).
import * as Logger from "effect/Logger";

import * as Idle from "../host/idle.ts";

export interface PublishDeliveries {
  readonly total: number;
  readonly queued: number;
  readonly successful: number;
  readonly failed: number;
  readonly kinds: ReadonlyArray<string>;
  readonly failedReasons: ReadonlyArray<string>;
}

export type PublishEvent = "publishing" | "deferred" | "confirmed" | "completed" | "failed" | "exhausted";

export interface PublishEntry {
  readonly at: string;
  readonly threadId: string;
  readonly event: PublishEvent;
  /** The awareness phase published (or deferred); null for a tombstone. */
  readonly phase?: string | null;
  readonly reason?: string;
  readonly ok?: boolean;
  readonly deliveries?: PublishDeliveries;
  /** A failure's HTTP status, when its text names one. */
  readonly status?: number;
  /** A failure's error tag, when its text names one. */
  readonly errorTag?: string;
  /** The relay refused this environment's credential (401/403): the link was removed or revoked. */
  readonly rejected?: boolean;
}

/** t3's log messages (`t3/src/relay/AgentAwarenessRelay.ts`), by the event each means. */
const MESSAGES: Record<string, PublishEvent> = {
  "publishing agent activity for thread": "publishing",
  "agent activity publish deferred pending confirmation": "deferred",
  "agent activity deferred publish confirmed": "confirmed",
  "agent activity publish completed": "completed",
  "agent activity publish failed": "failed",
  "agent activity publish retry budget exhausted": "exhausted",
};

/**
 * How long each pending event holds the idle reset: a publish has a 10 s timeout; a deferral confirms after 5 s; a
 * failure is retried after at most 16 s, then has its own 10 s timeout. Every hold is also capped (Idle).
 */
const HOLD_MS: Partial<Record<PublishEvent, number>> = {
  publishing: 15_000,
  deferred: 15_000,
  confirmed: 15_000,
  failed: 30_000,
};

const KEEP = 100;
const HOLD_PREFIX = "publish:";

const STATUS = /\bstatus(?:Code)?\D{0,3}([1-5]\d\d)\b/i;
const BARE_STATUS = /\b(40[0-9]|429|5\d\d)\b/;
const ERROR_TAG = /\b((?:Relay|HttpClient|HttpApiClient|Timeout|StatusCode|Transport|Response|Request)[A-Za-z]*Error)\b/;

const failureOf = (cause: unknown): Pick<PublishEntry, "status" | "errorTag" | "rejected"> => {
  const text = typeof cause === "string" ? cause : "";
  const status = Number((STATUS.exec(text) ?? BARE_STATUS.exec(text))?.[1]) || undefined;
  const errorTag = ERROR_TAG.exec(text)?.[1];
  const rejected = status === 401 || status === 403 || /RelayAuthInvalidError|Unauthorized|Forbidden/.test(text);
  return { ...(status === undefined ? {} : { status }), ...(errorTag === undefined ? {} : { errorTag }), rejected };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** One log event as an entry, or undefined when it is not one of t3's publish events. */
export const entryOf = (message: unknown, date: Date): PublishEntry | undefined => {
  const parts = Array.isArray(message) ? message : [message];
  const event = typeof parts[0] === "string" ? MESSAGES[parts[0]] : undefined;
  if (event === undefined) return undefined;
  const fields = parts.slice(1).find(isRecord) ?? {};
  const threadId = typeof fields.threadId === "string" ? fields.threadId : "unknown";
  const phase = "statePhase" in fields ? ((fields.statePhase as string | null) ?? null) : undefined;
  return {
    at: date.toISOString(),
    threadId,
    event,
    ...(phase === undefined ? {} : { phase }),
    ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
    ...(typeof fields.ok === "boolean" ? { ok: fields.ok } : {}),
    ...(isRecord(fields.deliveries) ? { deliveries: fields.deliveries as unknown as PublishDeliveries } : {}),
    ...(event === "failed" ? failureOf(fields.cause) : {}),
  };
};

export interface PublishStore {
  readonly read: () => unknown;
  readonly write: (entries: ReadonlyArray<PublishEntry>) => void;
}

export interface PublishRecorder {
  readonly record: (message: unknown, date: Date) => void;
  readonly entries: () => ReadonlyArray<PublishEntry>;
  /** What the status route reports: pending threads, the last success and failure, and whether the relay refuses us. */
  readonly summary: () => {
    readonly pending: ReadonlyArray<string>;
    readonly lastSuccess: PublishEntry | null;
    readonly lastFailure: PublishEntry | null;
    readonly rejected: boolean;
  };
  /** The phase each thread was last published with (the newest `publishing` entry). */
  readonly lastPublishedPhases: () => ReadonlyMap<string, string | null>;
  /** The t3 Logger that feeds it. */
  readonly logger: Logger.Logger<unknown, void>;
}

export const makePublishRecorder = (store: PublishStore): PublishRecorder => {
  const stored = store.read();
  const entries: Array<PublishEntry> = Array.isArray(stored) ? (stored as Array<PublishEntry>).slice(-KEEP) : [];
  const record = (message: unknown, date: Date) => {
    const parsed = entryOf(message, date);
    if (parsed === undefined) return;
    // The relay's answer names no phase: it answers the thread's latest publish.
    const publishing = parsed.event === "completed" || parsed.event === "failed" ? entries.findLast((e) => e.threadId === parsed.threadId && e.event === "publishing") : undefined;
    const entry: PublishEntry = publishing?.phase === undefined || parsed.phase !== undefined ? parsed : { ...parsed, phase: publishing.phase };
    entries.push(entry);
    if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
    const holdMs = HOLD_MS[entry.event];
    if (holdMs === undefined) Idle.release(`${HOLD_PREFIX}${entry.threadId}`);
    else Idle.hold(`${HOLD_PREFIX}${entry.threadId}`, date.getTime() + holdMs, { capped: true });
    try {
      store.write(entries);
    } catch {
      // Storage refused (a reset in progress): memory still has it.
    }
  };
  const last = (predicate: (entry: PublishEntry) => boolean) => entries.findLast(predicate) ?? null;
  return {
    record,
    entries: () => [...entries],
    summary: () => {
      const lastSuccess = last((entry) => entry.event === "completed" && entry.ok === true);
      const lastFailure = last((entry) => entry.event === "failed");
      return {
        pending: [...Idle.holds.keys()].filter((name) => name.startsWith(HOLD_PREFIX)).map((name) => name.slice(HOLD_PREFIX.length)),
        lastSuccess,
        lastFailure,
        rejected: lastFailure?.rejected === true && (lastSuccess === null || lastSuccess.at < lastFailure.at),
      };
    },
    lastPublishedPhases: () => {
      const phases = new Map<string, string | null>();
      for (const entry of entries) if (entry.event === "publishing" && entry.phase !== undefined) phases.set(entry.threadId, entry.phase);
      return phases;
    },
    logger: Logger.make((options) => record(options.message, options.date)),
  };
};
