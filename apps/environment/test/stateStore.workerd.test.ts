// The State directory (ADR-0007) on real DO SQLite: files above CHUNK_BYTES are split across rows, and every
// operation keeps the chunks consistent.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import * as store from "../src/platform/stateStore.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_OBJECTS: DurableObjectNamespace;
    }
  }
}

const bytes = (length: number, seed = 7) => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

/** Byte equality without Vitest's element-by-element diff, which takes seconds on megabytes. */
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

const inObject = <T>(name: string, run: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.TEST_OBJECTS.getByName(name), async (_instance, state) => {
    store.bindStateStorage({ sql: state.storage.sql, transactionSync: (f) => state.storage.transactionSync(f) });
    return run(state);
  });

const rowCount = (state: DurableObjectState, table: string) =>
  (state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one() as { n: number }).n;

describe("State directory", () => {
  it("keeps small files inline and large ones in 4 MiB chunks", async () => {
    await inObject("chunks", (state) => {
      store.mkdir("/t3/attachments", { recursive: true });
      store.writeFile("/t3/attachments/small.bin", bytes(1000));
      const large = bytes(store.CHUNK_BYTES * 2 + 12345);
      store.writeFile("/t3/attachments/large.bin", large);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(3);
      expect(store.get("/t3/attachments/large.bin")?.size).toBe(large.byteLength);
      expect(same(store.readFile("/t3/attachments/large.bin"), large)).toBe(true);
      expect(store.readFile("/t3/attachments/small.bin")).toEqual(bytes(1000));
      // A range across a chunk boundary reads only what it needs, and equals the same slice.
      const from = store.CHUNK_BYTES - 10;
      expect(store.readRange("/t3/attachments/large.bin", from, 30)).toEqual(large.slice(from, from + 30));
      expect(store.usage()).toEqual({ files: 2, bytes: 1000 + large.byteLength, chunked: 1 });
    });
  });

  it("appends, truncates, renames and removes chunked files without stray chunks", async () => {
    await inObject("ops", (state) => {
      store.mkdir("/t3/a", { recursive: true });
      const first = bytes(store.CHUNK_BYTES - 5, 1);
      store.writeFile("/t3/a/f.bin", first);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      store.writeFile("/t3/a/f.bin", bytes(20, 2), { append: true });
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);
      const joined = store.readFile("/t3/a/f.bin");
      expect(joined.byteLength).toBe(first.byteLength + 20);
      expect(same(joined.slice(0, first.byteLength), first)).toBe(true);

      store.truncate("/t3/a/f.bin", 100);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      expect(store.readFile("/t3/a/f.bin")).toEqual(first.slice(0, 100));

      store.writeFile("/t3/a/g.bin", bytes(store.CHUNK_BYTES + 1));
      store.rename("/t3/a", "/t3/b");
      expect(store.readFile("/t3/b/g.bin").byteLength).toBe(store.CHUNK_BYTES + 1);
      expect(() => store.readFile("/t3/a/g.bin")).toThrow(/ENOENT/);
      store.remove("/t3/b", { recursive: true });
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      expect(store.get("/t3/b")).toBeUndefined();
    });
  });

  it("reports Node-style errors", async () => {
    await inObject("errors", () => {
      expect(() => store.readFile("/missing")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      store.mkdir("/d");
      expect(() => store.mkdir("/d")).toThrow(expect.objectContaining({ code: "EEXIST" }));
      store.writeFile("/d/x", bytes(1));
      expect(() => store.remove("/d")).toThrow(expect.objectContaining({ code: "ENOTEMPTY" }));
      expect(() => store.writeFile("/nope/x", bytes(1))).toThrow(expect.objectContaining({ code: "ENOENT" }));
      store.symlink("/d/x", "/link");
      expect(store.resolve("/link")?.path).toBe("/d/x");
    });
  });

  it("migrates a spike-era table, keeping its files and backfilling their sizes", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("spike"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE t3flare_files (path TEXT PRIMARY KEY, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB,
        target TEXT, mode INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, birthtime_ms INTEGER NOT NULL)`);
      sql.exec(`INSERT INTO t3flare_files VALUES ('/', '/', 'dir', NULL, NULL, 493, 0, 0), ('/old.txt', '/', 'file', ?, NULL, 420, 0, 0)`, new TextEncoder().encode("hello"));
      store.bindStateStorage({ sql, transactionSync: (f) => state.storage.transactionSync(f) });
      expect(store.get("/old.txt")?.size).toBe(5);
      expect(new TextDecoder().decode(store.readFile("/old.txt"))).toBe("hello");
      // Binding again (a new object instance) does not migrate twice.
      store.bindStateStorage({ sql, transactionSync: (f) => state.storage.transactionSync(f) });
      expect(store.readFile("/old.txt").byteLength).toBe(5);
    });
  });
});
