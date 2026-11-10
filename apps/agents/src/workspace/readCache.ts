// @effect-diagnostics globalDate:off
// t3's passive git reads, answered without the Container while the repo has not changed (step 2a plan, section 2,
// revised in M2): every passive read the Container answers is kept with the repo's revision in computer's change log
// (`vfs_changes`) at the time it ran; the same argv, cwd, env and stdin at the same revision gets the same bytes back.
// Anything that changes the repo (an edit through the Workspace's files, a sync from the Container) moves the
// revision: the next read runs for real if the Container is running, and otherwise gets the last answer (`last`, any
// revision) patched with the write journal (`./staleReads.ts`, M3), never starting the Container.
import { REPO_ROOT } from "@t3flare/workspace-client";

export interface CachedAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** REPO_ROOT's two segments, as computer's VFS keeps them (`vfs_dirents` under the root inode, 1). */
const [ROOT_NAME, REPO_NAME] = REPO_ROOT.split("/").filter(Boolean) as [string, string];

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
  const memo = new Map<"git-dir" | "repo", { readonly global: number; readonly rev: number }>();
  const ensure = () => {
    if (!ready) sql.exec(SCHEMA);
    ready = true;
  };
  return {
    /**
     * The repo's revision (or its `.git`'s, for `git-dir`): the newest revision of any file, folder or deletion under it in computer's VFS
     * (`vfs_nodes.rev`, and `vfs_changes` for deletions). Recomputed only when the Workspace's global revision
     * (`vfs_meta.rev`, bumped by every write anywhere) moved, so a status poll between changes costs one row.
     */
    revision(scope: "git-dir" | "repo" = "repo"): number {
      try {
        const global = sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'").toArray()[0]?.v ?? 0;
        const known = memo.get(scope);
        if (known !== undefined && known.global === global) return known.rev;
        const segments = scope === "git-dir" ? [ROOT_NAME, REPO_NAME, ".git"] : [ROOT_NAME, REPO_NAME];
        const prefix = `/${segments.join("/")}`;
        // The subtree's root inode: one dirent hop per segment from the VFS root (inode 1).
        let inode: number | undefined = 1;
        for (const name of segments) {
          inode = sql
            .exec<{ child_inode: number }>("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", inode, name)
            .toArray()[0]?.child_inode;
          if (inode === undefined) break;
        }
        const nodes =
          inode === undefined
            ? 0
            : (sql
                .exec<{ rev: number | null }>(
                  `WITH RECURSIVE sub(inode) AS (
                     SELECT ?
                     UNION ALL
                     SELECT d.child_inode FROM sub JOIN vfs_dirents d ON d.parent_inode = sub.inode
                   )
                   SELECT MAX(n.rev) AS rev FROM sub JOIN vfs_nodes n ON n.inode = sub.inode`,
                  inode,
                )
                .toArray()[0]?.rev ?? 0);
        const deletions =
          sql.exec<{ rev: number | null }>("SELECT MAX(rev) AS rev FROM vfs_changes WHERE path >= ? AND path < ?", `${prefix}/`, `${prefix}0`).toArray()[0]
            ?.rev ?? 0;
        const rev = Math.max(nodes, deletions);
        memo.set(scope, { global, rev });
        return rev;
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
    /** The last real answer for `key` at any revision, and the revision it was made at (the stale reads' base). */
    last(key: string): { readonly rev: number; readonly answer: CachedAnswer } | undefined {
      ensure();
      const row = sql.exec<{ rev: number; answer: string }>("SELECT rev, answer FROM t3flare_git_reads WHERE key = ?", key).toArray()[0];
      return row === undefined ? undefined : { rev: row.rev, answer: JSON.parse(row.answer) as CachedAnswer };
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
