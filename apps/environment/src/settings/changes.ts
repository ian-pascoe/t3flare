// @effect-diagnostics globalDate:off
// The Settings server's changes table (plan D8, D16): `t3flare_settings_changes` in the Environment DO's SQLite, one row
// per change, the record as JSON, indexed by caller key and hash. The caps count from it. M3 writes only applied free
// changes, as already-closed rows (plan D16), for the applied cap; the Open changes of M4 (SPI-1199) are kept in the same
// table. Rows are pruned lazily, on every read and write, an hour after they close (ADR-0003: no alarm is added).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const CHANGES_TABLE = "t3flare_settings_changes";

/** How long a closed row is kept: the longest cap window (plan D16). */
export const CLOSED_KEPT_MS = 60 * 60_000;

/** Applied changes of any tier, per caller, per hour (plan D16). */
export const APPLIED_CAP = 30;
export const APPLIED_WINDOW_MS = 60 * 60_000;

/** Who asked, as a change records it (plan D8's `caller`). */
export interface ChangeCaller {
  readonly door: "own" | "owner";
  /** The cap's key: the thread id for an own agent, the Access `sub` for an Owner client. */
  readonly key: string;
  readonly principal: "agent" | "owner" | "service-token";
  readonly thread?: string;
  readonly agent?: string;
}

/** A change as the table keeps it. M3's rows are applied free changes; M4 extends the record to the Open change's. */
export interface ChangeRecord {
  readonly id: string;
  readonly entity: "harness" | "environment";
  readonly tool: string;
  /** The call's arguments, canonical JSON (never a secret: none is ever in them). */
  readonly args: unknown;
  readonly hash: string;
  readonly tier: "free" | "asked";
  readonly caller: ChangeCaller;
  readonly createdAt: number;
  readonly state: "applied";
  readonly closed: { readonly at: number; readonly revision: number };
}

export interface SettingsChanges {
  /** Applied changes by `key` since `since`. */
  appliedSince(key: string, since: number): number;
  recordApplied(record: ChangeRecord): void;
}

/** Canonical JSON: keys sorted at every depth. */
export const canonicalJson = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonicalJson).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
          .join(",")}}`;

/** A change's hash (plan D8): SHA-256 of the tool and its canonical arguments without `expectedRevision`. */
export const changeHash = async (tool: string, args: Readonly<Record<string, unknown>>): Promise<string> => {
  const { expectedRevision: _expected, ...rest } = args;
  const bytes = new TextEncoder().encode(canonicalJson({ tool, args: rest }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** A change's id (plan D8): `chg_` and 32 random bytes, base64url. */
export const newChangeId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `chg_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
};

export const settingsChanges = (sql: Pick<SqlStorage, "exec">, now: () => number = Date.now): SettingsChanges => {
  let ready = false;
  const prepare = () => {
    if (!ready) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${CHANGES_TABLE} (id TEXT PRIMARY KEY, caller_key TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, record TEXT NOT NULL)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_caller ON ${CHANGES_TABLE} (caller_key, state, closed_at)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_hash ON ${CHANGES_TABLE} (hash)`);
      ready = true;
    }
    sql.exec(`DELETE FROM ${CHANGES_TABLE} WHERE closed_at IS NOT NULL AND closed_at < ?`, now() - CLOSED_KEPT_MS);
  };
  return {
    appliedSince: (key, since) => {
      prepare();
      const row = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${CHANGES_TABLE} WHERE caller_key = ? AND state = 'applied' AND closed_at >= ?`, key, since).toArray()[0];
      return Number(row?.count ?? 0);
    },
    recordApplied: (record) => {
      prepare();
      sql.exec(
        `INSERT INTO ${CHANGES_TABLE} (id, caller_key, hash, state, created_at, closed_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.caller.key,
        record.hash,
        record.state,
        record.createdAt,
        record.closed.at,
        JSON.stringify(record),
      );
    },
  };
};
