// @effect-diagnostics globalDate:off
// t3's passive git reads, answered without the Container while the repo has not changed (step 2a plan, section 2,
// revised in M2): every passive read the Container answers is kept with the repo's revision in computer's change log
// (`vfs_changes`) at the time it ran; the same argv, cwd, env and stdin at the same revision gets the same bytes back.
// Anything that changes the repo (an edit through the Workspace's files, a sync from the Container) moves the
// revision, and the next read runs for real.
import { REPO_ROOT } from "@t3flare/workspace-client";

export interface CachedAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS t3flare_git_reads (
  key TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  answer TEXT NOT NULL,
  used_at INTEGER NOT NULL
)`;

/** Most reads kept; t3's status poll uses about 30 shapes per branch. */
const MAX_ROWS = 500;

export const readKey = async (input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: string | undefined;
}): Promise<string> => {
  const env = Object.entries(input.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
  const text = JSON.stringify([input.argv, input.cwd, env, input.stdin ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const readCache = (sql: SqlStorage) => {
  let ready = false;
  const ensure = () => {
    if (!ready) sql.exec(SCHEMA);
    ready = true;
  };
  return {
    /** The repo's revision: the newest change under REPO_ROOT in computer's change log (0 before any). */
    revision(): number {
      try {
        const row = sql
          .exec<{ rev: number | null }>(
            "SELECT MAX(rev) AS rev FROM vfs_changes WHERE path = ? OR (path >= ? AND path < ?)",
            REPO_ROOT,
            `${REPO_ROOT}/`,
            `${REPO_ROOT}0`,
          )
          .toArray()[0];
        return row?.rev ?? 0;
      } catch {
        return -1;
      }
    },
    get(key: string, rev: number): CachedAnswer | undefined {
      ensure();
      if (rev < 0) return undefined;
      const row = sql.exec<{ rev: number; answer: string }>("SELECT rev, answer FROM t3flare_git_reads WHERE key = ?", key).toArray()[0];
      if (row === undefined || row.rev !== rev) return undefined;
      sql.exec("UPDATE t3flare_git_reads SET used_at = ? WHERE key = ?", Date.now(), key);
      return JSON.parse(row.answer) as CachedAnswer;
    },
    put(key: string, rev: number, answer: CachedAnswer): void {
      ensure();
      if (rev < 0) return;
      sql.exec(
        "INSERT INTO t3flare_git_reads (key, rev, answer, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev, answer = excluded.answer, used_at = excluded.used_at",
        key,
        rev,
        JSON.stringify(answer),
        Date.now(),
      );
      sql.exec(
        "DELETE FROM t3flare_git_reads WHERE key IN (SELECT key FROM t3flare_git_reads ORDER BY used_at DESC LIMIT -1 OFFSET ?)",
        MAX_ROWS,
      );
    },
    stats(): { readonly rows: number } {
      ensure();
      return { rows: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM t3flare_git_reads").one().n };
    },
  };
};
