// @effect-diagnostics globalDate:off
// The Pairing window (ADR-0010) in DO storage: an admin opens it for some minutes, t3 boots with its bootstrap grant
// seeded only while it is open, and the one alarm (ADR-0003) closes it on time, so t3 restarts without the grant.
// Outside the window an exchange presenting the bootstrap token is refused before t3 sees it.

import type { KeyValue } from "./bootState.ts";

/** The part of DO storage the window needs, so tests can pass a fake. */
export interface PairingStorage extends KeyValue {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

const ARMED_UNTIL_KEY = "t3flare/bootstrap/armed-until";

/** The longest an admin may arm pairing for. */
export const MAX_ARM_MINUTES = 60;

export const armedUntil = async (storage: KeyValue): Promise<Date | null> => {
  const value = await storage.get<string>(ARMED_UNTIL_KEY);
  return value === undefined ? null : new Date(value);
};

export const isArmed = async (storage: KeyValue, now: Date): Promise<boolean> => {
  const until = await armedUntil(storage);
  return until !== null && until.getTime() > now.getTime();
};

/** Opens the window for `minutes`, clamped to 1–MAX_ARM_MINUTES; returns when it closes. */
export const arm = async (storage: KeyValue, minutes: number, now: Date): Promise<Date> => {
  const until = new Date(now.getTime() + Math.min(Math.max(minutes, 1), MAX_ARM_MINUTES) * 60_000);
  await storage.put(ARMED_UNTIL_KEY, until.toISOString());
  return until;
};

export const disarm = async (storage: KeyValue): Promise<void> => {
  await storage.delete(ARMED_UNTIL_KEY);
};

/**
 * While t3 holds a seeded grant, the one alarm must fire by the window's close. An earlier pending alarm is kept.
 * (Inside `alarm()`, `getAlarm` reads null until something sets it again.)
 */
export const keepWindowClosing = async (storage: PairingStorage): Promise<void> => {
  const until = await armedUntil(storage);
  if (until === null) return;
  const current = await storage.getAlarm();
  if (current === null || current > until.getTime()) await storage.setAlarm(until.getTime());
};

/**
 * What the alarm does about the window when it fires: `close-window` once a seeded grant outlives it (restart t3 without
 * it); otherwise `keep`, after setting the alarm again for the close, since an earlier alarm may have displaced it.
 */
export const onAlarm = async (storage: PairingStorage, runtime: { readonly seeded: boolean }, now: Date): Promise<"close-window" | "keep"> => {
  if (!runtime.seeded) return "keep";
  if (!(await isArmed(storage, now))) return "close-window";
  await keepWindowClosing(storage);
  return "keep";
};

/**
 * The routes that exchange a bootstrap credential, which outside the window are refused when they present the token:
 * a session (`/api/auth/browser-session`, `/oauth/token`) and, step 3's L2, an MCP sign-in's pairing code
 * (`/oauth/mcp/decision`; t3 itself refuses a grant that is not one-time there, so this is defence in depth). t3's
 * `/oauth/mcp/approval` carries no credential.
 */
export const BOOTSTRAP_EXCHANGE_PATHS: ReadonlySet<string> = new Set(["/api/auth/browser-session", "/oauth/token", "/oauth/mcp/decision"]);

/** The credential fields of t3's bootstrap exchanges: `/api/auth/browser-session` (JSON) and `/oauth/token` (form). */
const CREDENTIAL_FIELDS = ["credential", "subject_token"] as const;

const fieldsOf = (body: string): ReadonlyArray<unknown> => {
  const values: Array<unknown> = [];
  try {
    const json: unknown = JSON.parse(body);
    if (typeof json === "object" && json !== null) {
      for (const field of CREDENTIAL_FIELDS) values.push((json as Record<string, unknown>)[field]);
      // `/oauth/mcp/decision`: `{ decision: { _tag: "pairing-code", code } }`.
      const decision = (json as { decision?: unknown }).decision;
      if (typeof decision === "object" && decision !== null) values.push((decision as Record<string, unknown>).code);
    }
  } catch {
    // Not JSON: read it as a form.
  }
  const form = new URLSearchParams(body);
  for (const field of CREDENTIAL_FIELDS) values.push(...form.getAll(field));
  return values;
};

/**
 * Whether a bootstrap exchange's body presents `token`: its credential field, parsed as JSON or as a form whatever the
 * content type, and trimmed as t3 trims it. Parsing defeats encodings a substring match misses (`\u` and `%` escapes).
 */
export const presentsBootstrapToken = (body: string, token: string): boolean =>
  fieldsOf(body).some((value) => typeof value === "string" && value.trim() === token);
