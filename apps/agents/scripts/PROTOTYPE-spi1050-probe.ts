// PROTOTYPE, throwaway (SPI-1050 probe; branch spi-1050-probe, never main).
// Where does a Workspace DO's memory go with one big file in the repo? Runs computer's real SQLite VFS over node:sqlite
// (a shim of DO storage) and t3flare's real in-DO git (gitRepo.ts over isoFs.ts), and reports each phase's peak
// heap + ArrayBuffer bytes, sampled every 2 ms, against the 128 MB isolate limit.
//
//   node --expose-gc apps/agents/scripts/PROTOTYPE-spi1050-probe.ts <phase> [MiB]
//   phases: sync | guard | capture | status | loose-guard | loose-capture | read-loose
// Each phase runs in a fresh process (the runner below) so one phase's garbage doesn't count against the next.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

import { Workspace } from "@cloudflare/computer";
import * as git from "isomorphic-git";

import { captureCheckpoint, withinGuard, worktreeTree, type Repo } from "../src/workspace/gitRepo.ts";
import { isomorphicFs } from "../src/workspace/isoFs.ts";

const REPO = "/workspace/repo";
const MiB = 1024 * 1024;

// ---- DO storage shim over node:sqlite ----
const storageShim = () => {
  const db = new DatabaseSync(":memory:");
  const exec = (query: string, ...bindings: Array<unknown>) => {
    const norm = bindings.map((b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as Array<never>;
    const trimmed = query.trim();
    let rows: Array<Record<string, unknown>> = [];
    if (/^(SELECT|WITH|PRAGMA)/i.test(trimmed) || /RETURNING/i.test(trimmed)) {
      rows = db.prepare(trimmed).all(...norm) as Array<Record<string, unknown>>;
    } else if (/;\s*\S/.test(trimmed) && bindings.length === 0) {
      db.exec(trimmed);
    } else {
      db.prepare(trimmed).run(...norm);
    }
    const out = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) o[k] = v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
      return o;
    });
    return {
      toArray: () => out,
      one: () => out[0],
      raw: () => out.map((r) => Object.values(r))[Symbol.iterator](),
      [Symbol.iterator]: () => out[Symbol.iterator](),
      columnNames: out[0] ? Object.keys(out[0]) : [],
      rowsRead: 0,
      rowsWritten: 0,
    };
  };
  const kv = new Map<string, unknown>();
  return {
    sql: { exec, get databaseSize() { return 0; } },
    transactionSync: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    get: async (k: string) => kv.get(k),
    put: async (k: string, v: unknown) => void kv.set(k, v),
    delete: async (k: string) => kv.delete(k),
  };
};

// ---- peak sampler ----
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const measure = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  (globalThis as { gc?: () => void }).gc?.();
  const base = used();
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, used())), 2);
  const t0 = performance.now();
  try {
    const r = await fn();
    peak = Math.max(peak, used());
    return r;
  } finally {
    clearInterval(timer);
    console.log(JSON.stringify({ phase: label, peakAboveBaseMiB: +((peak - base) / MiB).toFixed(1), ms: Math.round(performance.now() - t0) }));
  }
};

// ---- fixture ----
const randomStream = (bytes: number) => {
  let left = bytes;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (left <= 0) return c.close();
      const n = Math.min(MiB, left);
      left -= n;
      c.enqueue(randomFillSync(new Uint8Array(n)));
    },
  });
};

let sql: ReturnType<typeof storageShim>["sql"];
const setup = async () => {
  const storage = storageShim();
  sql = storage.sql;
  const ws = new Workspace({ storage: storage as never, backends: [] });
  await ws.ready?.();
  const fs = isomorphicFs(ws);
  const repo: Repo = { fs, dir: REPO, cache: {} };
  await fs.promises.mkdir(REPO, { recursive: true } as never);
  await git.init({ fs, dir: REPO, defaultBranch: "main" });
  await fs.promises.writeFile(`${REPO}/README.md`, "hello\n");
  await git.add({ fs, dir: REPO, filepath: "README.md" });
  const who = { name: "p", email: "p@x", timestamp: 0, timezoneOffset: 0 };
  await git.commit({ fs, dir: REPO, message: "init", author: who, committer: who });
  return { ws, fs, repo };
};

/** A big file arriving as a pull does: streamed in 512 KiB chunks into the VFS (computer's writeFileStreaming). */
const syncBig = async (ws: Workspace, path: string, bytes: number) => {
  const provider = ws.provider() as unknown as { writeFile?: (p: string, c: unknown) => Promise<void> };
  const fsApi = (ws as unknown as { fs: { writeFile: (p: string, c: unknown) => Promise<void> } }).fs;
  await (fsApi?.writeFile ?? provider.writeFile!).call(fsApi ?? provider, path, randomStream(bytes));
};

/** A loose git object of `bytes` random bytes, as a `git add` in the Container leaves it and a pull brings it over. */
const looseObject = async (ws: Workspace, bytes: number) => {
  const body = randomFillSync(new Uint8Array(bytes));
  const header = new TextEncoder().encode(`blob ${bytes}\0`);
  const full = new Uint8Array(header.length + bytes);
  full.set(header);
  full.set(body, header.length);
  const oid = createHash("sha1").update(full).digest("hex");
  const z = deflateSync(full, { level: 1 });
  const fsApi = (ws as unknown as { fs: { writeFile: (p: string, c: unknown) => Promise<void>; mkdir: (p: string, o: unknown) => Promise<void> } }).fs;
  await fsApi.mkdir(`${REPO}/.git/objects/${oid.slice(0, 2)}`, { recursive: true });
  await fsApi.writeFile(`${REPO}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, new ReadableStream({ start(c) { c.enqueue(z); c.close(); } }));
  return oid;
};

/** The prototype guard: the largest file under the repo (working tree and .git alike), one SQL query over computer's VFS. */
const MAX_FILE_BYTES = 8 * MiB;
const largestRepoFile = (): number => {
  const row = sql
    .exec(
      `WITH RECURSIVE root(inode) AS (
         SELECT d2.child_inode FROM vfs_dirents d1 JOIN vfs_dirents d2 ON d2.parent_inode = d1.child_inode
          WHERE d1.parent_inode = 1 AND d1.name = 'workspace' AND d2.name = 'repo'),
       tree(inode) AS (SELECT inode FROM root UNION ALL SELECT d.child_inode FROM vfs_dirents d JOIN tree t ON d.parent_inode = t.inode)
       SELECT COALESCE(MAX(n.size), 0) AS biggest, COUNT(*) AS nodes FROM tree t JOIN vfs_nodes n ON n.inode = t.inode WHERE n.type = 'file'`,
    )
    .one() as { biggest: number; nodes: number };
  return row.biggest;
};
const withinGuardV2 = async (repo: Repo) => (await withinGuard(repo)) && largestRepoFile() <= MAX_FILE_BYTES;

const phase = process.argv[2];
const size = Number(process.argv[3] ?? 100) * MiB;

if (phase === undefined) {
  // Runner: each phase in a fresh process.
  const phases = ["sync", "guard", "status", "capture", "loose-guard", "loose-capture", "read-loose", "guard-v2", "guard-v2-big", "guard-v2-2000"];
  for (const p of phases) {
    const r = spawnSync(process.execPath, ["--import", new URL("./PROTOTYPE-spi1050-hooks.mjs", import.meta.url).pathname, "--expose-gc", `--max-old-space-size=${process.env.HEAP ?? 4096}`, process.argv[1]!, p, process.argv[2] ?? "100"], { encoding: "utf8" });
    process.stdout.write(r.stdout.split("\n").filter((l) => l.includes('"phase"')).join("\n") + "\n");
    if (r.status !== 0) console.log(JSON.stringify({ phase: p, exit: r.status, stderr: r.stderr.slice(-600) }));
  }
} else {
  const { ws, repo } = await setup();
  const big = `${REPO}/big.bin`;
  if (phase === "guard-v2-2000") {
    const fsApi = (ws as unknown as { fs: { writeFile: (p: string, c: string) => Promise<void>; mkdir: (p: string, o: unknown) => Promise<void> } }).fs;
    for (let d = 0; d < 40; d++) {
      await fsApi.mkdir(`${REPO}/src/d${d}`, { recursive: true });
      for (let f = 0; f < 50; f++) await fsApi.writeFile(`${REPO}/src/d${d}/f${f}.ts`, `export const x = ${f};\n`.repeat(200));
    }
    const ok = await measure("guard v2 on 2,000 small files (SQL size check)", () => withinGuardV2(repo));
    console.log(JSON.stringify({ guardV2: ok, largest: largestRepoFile() }));
  } else if (phase === "guard-v2" || phase === "guard-v2-big") {
    if (phase === "guard-v2-big") await syncBig(ws, big, size);
    else await looseObject(ws, size);
    const ok = await measure(`guard v2, ${phase === "guard-v2-big" ? "big untracked file" : "big loose object"}`, () => withinGuardV2(repo));
    console.log(JSON.stringify({ guardV2: ok, guardV1: await withinGuard(repo), largestMiB: +(largestRepoFile() / MiB).toFixed(1) }));
  } else if (phase === "sync") await measure(`sync ${size / MiB} MiB file into the VFS`, () => syncBig(ws, big, size));
  else if (phase.startsWith("loose")) {
    await looseObject(ws, size);
    if (phase === "loose-guard") await measure("withinGuard, big loose object only", () => withinGuard(repo));
    else await measure("captureCheckpoint, big loose object only", () => captureCheckpoint(repo, "refs/t3/checkpoints/x", 0));
  } else if (phase === "read-loose") {
    const oid = await looseObject(ws, size);
    await measure("git.readBlob of the big loose object", () => git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: {} }));
  } else {
    await syncBig(ws, big, size);
    if (phase === "guard") console.log(JSON.stringify({ withinGuard: await measure("withinGuard, big untracked file", () => withinGuard(repo)) }));
    else if (phase === "status") await measure("worktreeTree (statusMatrix + hash), big untracked file", () => worktreeTree(repo, null, false));
    else if (phase === "capture") await measure("captureCheckpoint, big untracked file", () => captureCheckpoint(repo, "refs/t3/checkpoints/x", 0));
  }
}
