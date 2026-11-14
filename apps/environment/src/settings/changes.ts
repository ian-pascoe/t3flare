// @effect-diagnostics globalDate:off
// The Settings server's changes table (plan D8, D16): `t3flare_settings_changes` in the Environment DO's SQLite, one row
// per change, the record as JSON, indexed by caller key and hash. It is the Open change table (M4, SPI-1199): an asked
// change waiting for its answer is a row in state `open` until it closes. A free change made through the server is kept
// as an already-closed row (state `applied`, tier `free`), so the caps count every change from one place.
//
// Kept in storage, not memory: the Environment resets after about 60 s idle (ADR-0003), which can fall between the ask
// and the owner's click. Rows expire and are pruned lazily, on every read and write of the table: an open row past its
// `expiresAt` closes as `expired`, and a closed row goes `CLOSED_KEPT_MS` after it closed (the longest a cap looks back:
// a run of strikes and the lock after its last). No alarm is added (ADR-0003: one alarm).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { MCP_ELICITATION_WAIT_MS } from "@cloudpid/mcp/types";
import type { NeedsPage as TierNeedsPage } from "@t3flare/harness-registry";
import { sha256Hex } from "@t3flare/skills";

import { base64Url } from "../harness/keys.ts";
import type { ChangeView } from "./render.ts";

export const CHANGES_TABLE = "t3flare_settings_changes";

/** Three strikes count as a run when they fall within this long of each other (plan D16). */
export const STRIKE_WINDOW_MS = 60 * 60_000;
/** A run of strikes refuses the caller's asked changes this long after its last strike (plan D16). */
export const STRIKE_LOCK_MS = 60 * 60_000;

/** How long a closed row is kept: the longest a cap looks back, a run of strikes and the lock after it (plan D16). */
export const CLOSED_KEPT_MS = STRIKE_WINDOW_MS + STRIKE_LOCK_MS;

/** How long an Open change waits for its answer (plan D8): the MCP host's question wait, `QUESTION_WAIT_MS`, which is this. */
export const CHANGE_TTL_MS = MCP_ELICITATION_WAIT_MS;

/** A duration as the texts name it: "10 minutes", "an hour", "2 hours". */
export const durationText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "an hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
};

/** An apply that never closed (the Environment reset while it ran) is closed as failed this long after its expiry. */
export const APPLYING_GRACE_MS = 5 * 60_000;

/** Applied changes of any tier, per caller, per hour (plan D16). */
export const APPLIED_CAP = 30;
export const APPLIED_WINDOW_MS = 60 * 60_000;

/** Reads of any kind, per caller (a thread), per hour (M3 review: reads are bounded as changes are, D16-style). */
export const READ_CAP = 240;
/** Reads that reach GitHub or an MCP server, per caller, per hour: they spend a token's or a server's limits. */
export const NETWORK_READ_CAP = 20;
export const READ_WINDOW_MS = 60 * 60_000;
/** The Settings server's reads that reach GitHub or an MCP server. */
export const NETWORK_READS: ReadonlySet<string> = new Set(["test_mcp_server", "preview_skills", "check_skill_updates"]);

/** The reads table: one row per read through the server, kept an hour, for the read caps. */
export const READS_TABLE = "t3flare_settings_reads";

/**
 * Why a change is answered on the Change page alone (plan D6): what its tier says (a secret, a sign-in, skills' text),
 * or `oversize`, text a card would cut.
 */
export type NeedsPage = TierNeedsPage | "oversize";

/** A change's state (plan D8). `open` and `applying` are open; the rest are closed. */
export type ChangeState = "open" | "applying" | "applied" | "declined" | "withdrawn" | "expired" | "moved" | "failed";

/** An Owner client's Elicitation modes (plan D12), as `?elicitation_mode=` names them. */
export const OWNER_MODES = ["browser", "native", "model"] as const;
export type OwnerMode = (typeof OWNER_MODES)[number];

/** How an Open change is answered: on the owner-only card (own agents), or an Owner client's Elicitation mode (M5). */
export type ChangeMode = "card" | OwnerMode;

/** What answered a change (plan D8): the card, the Change page, an Owner client's form (`native`), its agent's `resume` (`model`). */
export type AnsweredBy = "card" | "page" | "client" | "agent";

/** What answered or closed a change: an answerer, or `stop` (the caller's Stop, turn end or going away, plan D9). */
export type ClosedBy = AnsweredBy | "stop";

/** Who asked, as a change records it (plan D8's `caller`). */
export interface ChangeCaller {
  readonly door: "own" | "owner";
  /** The cap's key: the thread id for an own agent, the Access `sub` for an Owner client. */
  readonly key: string;
  readonly principal: "agent" | "owner" | "service-token";
  readonly thread?: string;
  readonly agent?: string;
  /** An Owner client's own label, unverified. */
  readonly client?: { readonly name: string; readonly source: string };
}

/** A change as the table keeps it: an Open change (tier `asked`), or a free change already applied. */
export interface ChangeRecord {
  readonly id: string;
  /** Whose revision. */
  readonly entity: "harness" | "environment";
  readonly expectedRevision?: number;
  /** The write tool's name. */
  readonly tool: string;
  /** The call's arguments, canonical JSON (never a secret: none is ever in them). */
  readonly args: unknown;
  /** SHA-256 of the tool and its canonical arguments without `expectedRevision`. */
  readonly hash: string;
  readonly tier: "free" | "asked";
  /** What the card and the Change page render (an asked change's). */
  readonly shown?: ChangeView;
  readonly needsPage?: NeedsPage;
  readonly mode?: ChangeMode;
  readonly caller: ChangeCaller;
  readonly createdAt: number;
  /** When an open change expires; a free row's is its creation. */
  readonly expiresAt?: number;
  readonly state: ChangeState;
  /** `cut`: a `native` stream the client ended unanswered withdrew it (plan D12). */
  readonly closed?: { readonly at: number; readonly by?: ClosedBy; readonly revision?: number; readonly error?: string; readonly cut?: true };
}

export const isOpen = (record: Pick<ChangeRecord, "state">): boolean => record.state === "open" || record.state === "applying";

/**
 * The key a caller's caps, open changes and reads are counted under (plan D16): its door and its own key, so a thread id
 * that happens to equal an Access `sub` is another caller (SPI-1201 review). Every `key` of `SettingsChanges` is one.
 */
export const capKeyOf = (door: ChangeCaller["door"], key: string): string => `${door}:${key}`;

export interface SettingsChanges {
  /** Applied changes by `key` since `since`, of any tier. */
  appliedSince(key: string, since: number): number;
  /** Keeps a free change made through the server, already closed. */
  recordApplied(record: ChangeRecord): void;
  /** Keeps a new Open change. */
  insert(record: ChangeRecord): void;
  /** A change by id (expired first when its time is up), or undefined when unknown or pruned. */
  get(id: string): ChangeRecord | undefined;
  /** Every open change, oldest first. */
  open(): ReadonlyArray<ChangeRecord>;
  /** The open changes of `key`, oldest first. */
  openBy(key: string): ReadonlyArray<ChangeRecord>;
  /** The closed asked changes of `key` that closed since `since`, newest first. */
  closedBy(key: string, since: number): ReadonlyArray<ChangeRecord>;
  /**
   * Replaces `id`'s record with `next` when its state is still one of `from`, in one synchronous block; answers whether
   * it did. Only this moves a change's state, so a second answer finds it already moved (plan D8: one answer).
   */
  replace(id: string, from: ReadonlyArray<ChangeState>, next: ChangeRecord): boolean;
  /** Counts one read by `key` (`network`: one that reaches GitHub or an MCP server; it counts as a read too). */
  noteRead(key: string, kind: "read" | "network", at: number): void;
  /** Reads by `key` since `since`: every read for `read`, those that reach the network for `network`. */
  readsSince(key: string, kind: "read" | "network", since: number): number;
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

/**
 * A change's hash (plan D8): SHA-256 of the tool and its change, canonical, without `expectedRevision`. The Settings
 * server passes the change as its planner normalized it (only the fields the change takes, SPI-1199 review), never the
 * raw arguments, so an extra key cannot make a declined change look new.
 */
export const changeHash = async (tool: string, args: Readonly<Record<string, unknown>>): Promise<string> => {
  const { expectedRevision: _expected, ...rest } = args;
  return sha256Hex(canonicalJson({ tool, args: rest }));
};

/** A change's id (plan D8): `chg_` and 32 random bytes, base64url. */
export const newChangeId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `chg_${base64Url(bytes)}`;
};

/** A well-formed change id, so a page path or a `resume` cannot name anything else. */
export const isChangeId = (id: string): boolean => /^chg_[A-Za-z0-9_-]{43}$/.test(id);

const parse = (text: unknown): ChangeRecord | undefined => {
  try {
    return typeof text === "string" ? (JSON.parse(text) as ChangeRecord) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The one log line of a closed change (plan D15): `settings-change` when it applied or expired (a change's own end),
 * `settings-refused` when it was declined, withdrawn, moved or failed. Never a value.
 */
export const closedLine = (record: ChangeRecord): Record<string, unknown> => ({
  t3flare: record.state === "applied" || record.state === "expired" ? "settings-change" : "settings-refused",
  via: "mcp",
  door: record.caller.door,
  tool: record.tool,
  change: record.id,
  tier: record.tier,
  mode: record.mode ?? null,
  outcome: record.state,
  answeredBy: record.closed?.by ?? null,
  ...(record.closed?.revision === undefined ? {} : { revision: record.closed.revision }),
  ...(record.closed?.error === undefined ? {} : { error: record.closed.error }),
  ...(record.closed?.cut === true ? { cut: true } : {}),
});

/**
 * The table over `sql`. `log` gets the line of each change the table itself closes (an expiry, or an apply the
 * Environment's restart cut off), since no answerer is there to write it.
 */
export const settingsChanges = (sql: Pick<SqlStorage, "exec">, now: () => number = Date.now, log?: (event: Record<string, unknown>) => void): SettingsChanges => {
  let ready = false;
  const write = (record: ChangeRecord) =>
    sql.exec(
      `INSERT OR REPLACE INTO ${CHANGES_TABLE} (id, caller_key, hash, state, created_at, closed_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      capKeyOf(record.caller.door, record.caller.key),
      record.hash,
      record.state,
      record.createdAt,
      record.closed?.at ?? null,
      JSON.stringify(record),
    );
  const rows = (where: string, ...params: Array<unknown>): Array<ChangeRecord> =>
    sql
      .exec<{ record: string }>(`SELECT record FROM ${CHANGES_TABLE} WHERE ${where}`, ...params)
      .toArray()
      .flatMap((row) => {
        const record = parse(row.record);
        return record === undefined ? [] : [record];
      });
  /** Creates the table once, closes what has expired, and prunes what closed over `CLOSED_KEPT_MS` ago. */
  const prepare = () => {
    if (!ready) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${CHANGES_TABLE} (id TEXT PRIMARY KEY, caller_key TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, record TEXT NOT NULL)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_caller ON ${CHANGES_TABLE} (caller_key, state, closed_at)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_hash ON ${CHANGES_TABLE} (hash)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS ${READS_TABLE} (caller_key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${READS_TABLE}_caller ON ${READS_TABLE} (caller_key, at)`);
      ready = true;
    }
    const at = now();
    // At most the Environment-wide cap of open rows (plan D16), so reading them all is cheap.
    for (const record of rows(`state IN ('open', 'applying')`)) {
      const expiresAt = record.expiresAt ?? record.createdAt;
      const closed: ChangeRecord | undefined =
        record.state === "open" && expiresAt <= at
          ? { ...record, state: "expired", closed: { at: expiresAt } }
          : record.state === "applying" && expiresAt + APPLYING_GRACE_MS <= at
            ? { ...record, state: "failed", closed: { at, error: "the Environment restarted while the change applied; read the settings to see whether it did" } }
            : undefined;
      if (closed === undefined) continue;
      write(closed);
      log?.(closedLine(closed));
    }
    sql.exec(`DELETE FROM ${CHANGES_TABLE} WHERE closed_at IS NOT NULL AND closed_at < ?`, at - CLOSED_KEPT_MS);
    sql.exec(`DELETE FROM ${READS_TABLE} WHERE at < ?`, at - READ_WINDOW_MS);
  };
  return {
    appliedSince: (key, since) => {
      prepare();
      const row = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${CHANGES_TABLE} WHERE caller_key = ? AND state = 'applied' AND closed_at >= ?`, key, since).toArray()[0];
      return Number(row?.count ?? 0);
    },
    recordApplied: (record) => {
      prepare();
      write(record);
    },
    insert: (record) => {
      prepare();
      write(record);
    },
    get: (id) => {
      prepare();
      return rows(`id = ?`, id)[0];
    },
    open: () => {
      prepare();
      return rows(`state IN ('open', 'applying') ORDER BY created_at, id`);
    },
    openBy: (key) => {
      prepare();
      return rows(`caller_key = ? AND state IN ('open', 'applying') ORDER BY created_at, id`, key);
    },
    closedBy: (key, since) => {
      prepare();
      return rows(`caller_key = ? AND closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at DESC, created_at DESC`, key, since).filter((record) => record.tier === "asked");
    },
    noteRead: (key, kind, at) => {
      prepare();
      sql.exec(`INSERT INTO ${READS_TABLE} (caller_key, kind, at) VALUES (?, ?, ?)`, key, kind, at);
    },
    readsSince: (key, kind, since) => {
      prepare();
      const row = sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${READS_TABLE} WHERE caller_key = ? AND at >= ?${kind === "network" ? " AND kind = 'network'" : ""}`, key, since)
        .toArray()[0];
      return Number(row?.count ?? 0);
    },
    replace: (id, from, next) => {
      prepare();
      const current = rows(`id = ?`, id)[0];
      if (current === undefined || !from.includes(current.state)) return false;
      write(next);
      return true;
    },
  };
};
