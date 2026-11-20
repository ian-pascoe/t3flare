// @effect-diagnostics globalDate:off
// Owner clients' Elicitation modes (ADR-0035's 2026-11-15 refinement, plan D12): one row per Owner caller's key and
// client name in `t3flare_settings_clients`, in the Environment DO's SQLite next to the Settings server's changes table.
//
// - The key is the endpoint's caller key (the Access `sub`, or `service-token`); the client name is the client's own
//   `clientInfo.name` (no version), cut and stripped of hidden characters as every client label is. The name is a label
//   with no security weight: the mode was always the client's own choice (E1), now kept on the panel instead of in the
//   client's URL, whose query Claude Code's OAuth discovery does not survive.
// - The endpoint records a client as seen, in `browser`, on its first request (`seen`); `lastSeen` is written at most
//   once per `SEEN_EVERY_MS`, so a chatty client costs one read per request once the table exists (the Environment DO
//   keeps one `ownerClients`, which creates it on its first call). At most `CLIENTS_PER_KEY` per key: a new name past
//   that evicts the least recently seen `browser` row first, and only then the least recently seen of any mode, so a flood
//   of names cannot grow the table or drop a mode the owner set while a `browser` row is left to go.
// - Only the Settings page's CSRF-guarded POST (harness/panel.ts) changes a mode or removes a row (`setMode`, `remove`).
//   No MCP door, and no Settings server tool, reaches them: the endpoint holds this behind `seen` alone.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { withoutHidden } from "@t3flare/harness-registry";

import { OWNER_MODES, type OwnerMode } from "./changes.ts";

export const CLIENTS_TABLE = "t3flare_settings_clients";
/** At most this many clients per Owner caller's key; a new one past it evicts the least recently seen `browser` one first. */
export const CLIENTS_PER_KEY = 50;
/** A client's name as kept: at most this many characters (an Owner client's label, plan D11). */
export const CLIENT_NAME_MAX = 60;
/** `lastSeen` is written at most this often per client. */
export const SEEN_EVERY_MS = 60 * 60_000;

/** One Owner client of one key, as the panel lists it. */
export interface OwnerClientEntry {
  readonly key: string;
  readonly clientName: string;
  readonly mode: OwnerMode;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface OwnerClients {
  /** Notes `clientName` of `key` as seen now (new ones in `browser`); answers its kept mode. The endpoint's only call. */
  seen(key: string, clientName: string): OwnerMode;
  /** Every kept client, by key, most recently seen first. */
  list(): ReadonlyArray<OwnerClientEntry>;
  /** The panel's: sets a known client's mode; answers its mode before, or undefined when it is unknown. */
  setMode(key: string, clientName: string, mode: OwnerMode): OwnerMode | undefined;
  /** The panel's: forgets a client; answers whether it was kept. */
  remove(key: string, clientName: string): boolean;
}

/** A client's name as kept and matched: its `clientInfo.name` without hidden characters, cut; undefined when empty. */
export const clientNameOf = (name: unknown): string | undefined => {
  if (typeof name !== "string") return undefined;
  // Cut before trimmed, as the endpoint's labels are cut, so a name kept in a 2025 session matches its `initialize`'s.
  const kept = withoutHidden(name).slice(0, CLIENT_NAME_MAX).trim();
  return kept === "" ? undefined : kept;
};

export const isOwnerMode = (value: unknown): value is OwnerMode => typeof value === "string" && (OWNER_MODES as ReadonlyArray<string>).includes(value);

type Row = {
  key: string;
  client_name: string;
  mode: string;
  first_seen: number;
  last_seen: number;
};

const entryOf = (row: Row): OwnerClientEntry => ({
  key: row.key,
  clientName: row.client_name,
  mode: isOwnerMode(row.mode) ? row.mode : "browser",
  firstSeen: Number(row.first_seen),
  lastSeen: Number(row.last_seen),
});

export const ownerClients = (sql: Pick<SqlStorage, "exec">, now: () => number = Date.now): OwnerClients => {
  let ready = false;
  const prepare = () => {
    if (ready) return;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CLIENTS_TABLE} (key TEXT NOT NULL, client_name TEXT NOT NULL, mode TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (key, client_name))`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS ${CLIENTS_TABLE}_seen ON ${CLIENTS_TABLE} (key, last_seen)`);
    ready = true;
  };
  const one = (key: string, clientName: string): Row | undefined =>
    sql.exec<Row>(`SELECT key, client_name, mode, first_seen, last_seen FROM ${CLIENTS_TABLE} WHERE key = ? AND client_name = ?`, key, clientName).toArray()[0];
  return {
    seen: (key, clientName) => {
      prepare();
      const at = now();
      const row = one(key, clientName);
      if (row !== undefined) {
        if (at - Number(row.last_seen) >= SEEN_EVERY_MS) sql.exec(`UPDATE ${CLIENTS_TABLE} SET last_seen = ? WHERE key = ? AND client_name = ?`, at, key, clientName);
        return entryOf(row).mode;
      }
      // Room for the new one first: this key's least recently seen `browser` rows go, then the least recently seen of any
      // mode (a row the owner set, `native` or `model`, sorts after every `browser` one).
      const spare = `ORDER BY (mode IN ('native', 'model')) ASC, last_seen ASC, first_seen ASC, client_name ASC LIMIT ?`;
      const count = Number(sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${CLIENTS_TABLE} WHERE key = ?`, key).toArray()[0]?.count ?? 0);
      if (count >= CLIENTS_PER_KEY) {
        sql.exec(
          `DELETE FROM ${CLIENTS_TABLE} WHERE key = ? AND client_name IN (SELECT client_name FROM ${CLIENTS_TABLE} WHERE key = ? ${spare})`,
          key,
          key,
          count - CLIENTS_PER_KEY + 1,
        );
      }
      sql.exec(`INSERT INTO ${CLIENTS_TABLE} (key, client_name, mode, first_seen, last_seen) VALUES (?, ?, 'browser', ?, ?)`, key, clientName, at, at);
      return "browser";
    },
    list: () => {
      prepare();
      return sql.exec<Row>(`SELECT key, client_name, mode, first_seen, last_seen FROM ${CLIENTS_TABLE} ORDER BY key, last_seen DESC, client_name`).toArray().map(entryOf);
    },
    setMode: (key, clientName, mode) => {
      prepare();
      const row = one(key, clientName);
      if (row === undefined) return undefined;
      sql.exec(`UPDATE ${CLIENTS_TABLE} SET mode = ? WHERE key = ? AND client_name = ?`, mode, key, clientName);
      return entryOf(row).mode;
    },
    remove: (key, clientName) => {
      prepare();
      if (one(key, clientName) === undefined) return false;
      sql.exec(`DELETE FROM ${CLIENTS_TABLE} WHERE key = ? AND client_name = ?`, key, clientName);
      return true;
    },
  };
};
