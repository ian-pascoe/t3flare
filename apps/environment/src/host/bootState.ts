// @effect-diagnostics globalDate:off
// The Environment DO's boot record and safe mode (ADR-0010's admin routes), in DO key-value storage.
//
// Every boot of t3 is counted before it starts, so a boot that takes the isolate down with it still
// counts as failed. After SAFE_MODE_AFTER_FAILURES boots in a row fail, the next boot does not start t3:
// the DO enters safe mode, where only the admin routes answer (health, read-only SQL, the toggle,
// restart), until the owner turns it off. Safe mode can also be turned on by hand.

/** The part of DO storage this needs, so tests can pass a Map-backed fake. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export const SAFE_MODE_AFTER_FAILURES = 3;

export interface BootRecord {
  /** Boots started, ever. */
  readonly boots: number;
  /** Boots in a row that started and did not succeed. */
  readonly consecutiveFailures: number;
  readonly lastStartedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly lastError: string | null;
}

export interface SafeMode {
  readonly on: boolean;
  readonly reason: "boot-failures" | "manual" | null;
  readonly since: string | null;
}

const BOOT_KEY = "t3flare/boot";
const SAFE_MODE_KEY = "t3flare/safe-mode";
const FAULT_KEY = "t3flare/fault/boot-failures";

const EMPTY_RECORD: BootRecord = {
  boots: 0,
  consecutiveFailures: 0,
  lastStartedAt: null,
  lastSucceededAt: null,
  lastError: null,
};
const SAFE_MODE_OFF: SafeMode = { on: false, reason: null, since: null };

export const readBootRecord = async (kv: KeyValue): Promise<BootRecord> => (await kv.get<BootRecord>(BOOT_KEY)) ?? EMPTY_RECORD;

export const readSafeMode = async (kv: KeyValue): Promise<SafeMode> => (await kv.get<SafeMode>(SAFE_MODE_KEY)) ?? SAFE_MODE_OFF;

export const setSafeMode = async (kv: KeyValue, on: boolean, reason: SafeMode["reason"], now: Date): Promise<SafeMode> => {
  const next: SafeMode = on ? { on, reason, since: now.toISOString() } : SAFE_MODE_OFF;
  await kv.put(SAFE_MODE_KEY, next);
  if (!on) {
    // Leaving safe mode gives t3 a fresh run of attempts.
    const record = await readBootRecord(kv);
    await kv.put(BOOT_KEY, { ...record, consecutiveFailures: 0 });
  }
  return next;
};

export type BootDecision = { readonly start: true; readonly record: BootRecord } | { readonly start: false; readonly safeMode: SafeMode };

/**
 * Whether to start t3 now. Records the attempt before it runs, or enters safe mode when too many boots in a
 * row have failed.
 */
export const beginBoot = async (kv: KeyValue, now: Date): Promise<BootDecision> => {
  const safeMode = await readSafeMode(kv);
  if (safeMode.on) return { start: false, safeMode };
  const record = await readBootRecord(kv);
  if (record.consecutiveFailures >= SAFE_MODE_AFTER_FAILURES) {
    return { start: false, safeMode: await setSafeMode(kv, true, "boot-failures", now) };
  }
  const next: BootRecord = {
    ...record,
    boots: record.boots + 1,
    consecutiveFailures: record.consecutiveFailures + 1,
    lastStartedAt: now.toISOString(),
  };
  await kv.put(BOOT_KEY, next);
  return { start: true, record: next };
};

export const bootSucceeded = async (kv: KeyValue, now: Date): Promise<BootRecord> => {
  const record = await readBootRecord(kv);
  const next: BootRecord = { ...record, consecutiveFailures: 0, lastSucceededAt: now.toISOString(), lastError: null };
  await kv.put(BOOT_KEY, next);
  return next;
};

export const bootFailed = async (kv: KeyValue, error: unknown): Promise<BootRecord> => {
  const record = await readBootRecord(kv);
  const next: BootRecord = { ...record, lastError: String(error).slice(0, 2000) };
  await kv.put(BOOT_KEY, next);
  return next;
};

/** A test fault (admin route): the next `count` boots fail before t3 starts. */
export const injectBootFailures = (kv: KeyValue, count: number) => kv.put(FAULT_KEY, Math.max(0, Math.trunc(count)));

/** Takes one injected failure, if any is left. */
export const takeInjectedFailure = async (kv: KeyValue): Promise<boolean> => {
  const left = (await kv.get<number>(FAULT_KEY)) ?? 0;
  if (left <= 0) return false;
  await kv.put(FAULT_KEY, left - 1);
  return true;
};
