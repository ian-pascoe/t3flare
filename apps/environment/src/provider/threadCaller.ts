// Who a Settings server call comes from, as the Environment derives it (ADR-0034 §5, plan D3): never what the caller
// states. Two facts per thread, both failing closed:
//
// - Linked work (`threadLinkIn`): from t3's projection. `"own"` only when the thread's row, and every ancestor's row up
//   its lineage, is there and carries no link origin; a missing row is `"unknown"`, a link origin (well-formed or not)
//   is `"linked"`. `linkedWorkOf` (adapter.ts) reads a missing row as the owner's own work: fail-open for this purpose.
//   Walking the lineage is the fallback plan §9 names for a child of a linked thread that does not carry the origin.
// - A Durable thread's modes (`durableModes`): the record the pi Durable adapter writes when it calls `open` and
//   `submitTurn`, cleared when its provider session unregisters. Memory only: after an Environment restart there is
//   none, and writes are refused until the next turn writes it again. A CLI thread's modes are `cliThreadState`'s.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

import type { ThreadLink, ThreadModes } from "../settings/caller.ts";

/** The agent kind of a Durable Session's call (only Sessions call `EnvironmentDO.mcpCall`). */
export const DURABLE_AGENT = "piDurable";

/** How far up a lineage the link is looked for; a deeper one is `"unknown"`. */
export const MAX_LINEAGE = 32;

/** `thread`'s Linked work from t3's projection in `sql` (plan D3). */
export const threadLinkIn = (sql: Pick<SqlStorage, "exec">, thread: string): ThreadLink => {
  const seen = new Set<string>();
  let current: string | null = thread;
  while (current !== null) {
    if (seen.has(current) || seen.size >= MAX_LINEAGE) return "unknown";
    seen.add(current);
    let row: { origin: string | null; parent: string | null } | undefined;
    try {
      row = sql
        .exec<{ origin: string | null; parent: string | null }>(
          "SELECT json_extract(payload_json, '$.linkOrigin') AS origin, json_extract(payload_json, '$.lineage.parentThreadId') AS parent FROM orchestration_v2_projection_threads WHERE thread_id = ?",
          current,
        )
        .toArray()[0];
    } catch {
      // No projection yet (t3 never booted here), or a row that is not JSON.
      return "unknown";
    }
    if (row === undefined) return "unknown";
    if (row.origin !== null && row.origin !== undefined) return "linked";
    // No parent is null (or absent); a parent of any other shape is a lineage this cannot follow (SPI-1198 review).
    if (row.parent === null || row.parent === undefined) current = null;
    else if (typeof row.parent === "string" && row.parent !== "") current = row.parent;
    else return "unknown";
  }
  return "own";
};

const records = new Map<string, { readonly modes: ThreadModes; readonly owner: object }>();

/** The adapter's record of a Durable thread's modes, written at `open` and `submitTurn` by the session that owns it. */
export const noteDurableModes = (thread: string, modes: ThreadModes, owner: object): void => {
  records.set(thread, { modes, owner });
};

/** The provider session unregistered: its threads' records go (only those it wrote last). */
export const forgetDurableModes = (thread: string, owner: object): void => {
  if (records.get(thread)?.owner === owner) records.delete(thread);
};

/** A Durable thread's modes, or undefined when no live provider session recorded them. */
export const durableModes = (thread: string): ThreadModes | undefined => records.get(thread)?.modes;

/**
 * One provider session's part of the record (plan D3): the adapter notes a thread's modes at `open` and at each
 * `submitTurn`, and forgets every thread it noted when the session unregisters (its scope's finalizer). A newer session
 * that took a thread over keeps its own record.
 */
export const durableModeRecord = () => {
  const owner = {};
  const noted = new Set<string>();
  return {
    note: (thread: string, modes: ThreadModes) => {
      noted.add(thread);
      noteDurableModes(thread, modes, owner);
    },
    forgetAll: () => {
      for (const thread of noted) forgetDurableModes(thread, owner);
      noted.clear();
    },
  };
};
