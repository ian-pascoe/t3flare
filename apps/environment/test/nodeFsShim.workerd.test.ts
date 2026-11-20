// The `node:fs` shim's descriptors on real DO SQLite: an open with Node's numeric flags reads the file it opens
// (t3's `readThemeFileGuarded` opens Environment themes with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`), where it once
// read numeric flags as `w` and emptied the file.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vitest";

import * as store from "../src/platform/stateStore.ts";
import * as fs from "../src/shims/node-fs.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_OBJECTS: DurableObjectNamespace;
    }
  }
}

const inObject = <T>(name: string, run: () => T | Promise<T>) =>
  runInDurableObject(env.TEST_OBJECTS.getByName(name), async (_instance, state) => {
    store.bindStateStorage({ sql: state.storage.sql, transactionSync: (f) => state.storage.transactionSync(f) });
    return run();
  });

const GUARDED_READ = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0) | (NodeFS.constants.O_NONBLOCK ?? 0);

/** t3's `readThemeFileGuarded`, minus its error handling. */
const guardedRead = (path: string): string => {
  const fd = fs.openSync(path, GUARDED_READ);
  try {
    const info = fs.fstatSync(fd);
    const contents = new Uint8Array(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = fs.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return new TextDecoder().decode(contents.subarray(0, offset));
  } finally {
    fs.closeSync(fd);
  }
};

describe("node:fs shim descriptors", () => {
  it("reads a file opened with numeric read-only flags, and leaves it whole", async () => {
    await inObject("numeric-read", () => {
      store.mkdir("/t3/themes", { recursive: true });
      fs.writeFileSync("/t3/themes/a.json", '{"name":"A"}');
      expect(guardedRead("/t3/themes/a.json")).toBe('{"name":"A"}');
      expect(fs.readFileSync("/t3/themes/a.json", "utf8")).toBe('{"name":"A"}');
    });
  });

  it("refuses a missing file and, with O_NOFOLLOW, a symlink", async () => {
    await inObject("numeric-refusals", () => {
      store.mkdir("/t3/themes", { recursive: true });
      expect(() => fs.openSync("/t3/themes/missing.json", GUARDED_READ)).toThrow(/ENOENT/);
      fs.writeFileSync("/t3/themes/real.json", "{}");
      fs.symlinkSync("/t3/themes/real.json", "/t3/themes/link.json");
      if (NodeFS.constants.O_NOFOLLOW !== undefined) expect(() => fs.openSync("/t3/themes/link.json", GUARDED_READ)).toThrow(/ELOOP/);
    });
  });

  it("creates, truncates and appends as the numeric write flags say", async () => {
    await inObject("numeric-write", () => {
      const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } = NodeFS.constants;
      store.mkdir("/t3/w", { recursive: true });
      fs.closeSync(fs.openSync("/t3/w/f", O_WRONLY | O_CREAT | O_EXCL));
      expect(() => fs.openSync("/t3/w/f", O_WRONLY | O_CREAT | O_EXCL)).toThrow(/EEXIST/);
      fs.writeFileSync("/t3/w/f", "kept");
      fs.closeSync(fs.openSync("/t3/w/f", O_WRONLY | O_APPEND));
      expect(fs.readFileSync("/t3/w/f", "utf8")).toBe("kept");
      fs.closeSync(fs.openSync("/t3/w/f", O_WRONLY | O_TRUNC));
      expect(fs.readFileSync("/t3/w/f", "utf8")).toBe("");
    });
  });

  it("reads sequentially from the descriptor's position when none is given", async () => {
    await inObject("sequential-read", () => {
      store.mkdir("/t3/r", { recursive: true });
      fs.writeFileSync("/t3/r/f", "abcdef");
      const fd = fs.openSync("/t3/r/f", "r");
      const buffer = new Uint8Array(4);
      expect(fs.readSync(fd, buffer, 0, 4, null)).toBe(4);
      expect(fs.readSync(fd, buffer, 0, 4, 1)).toBe(4);
      expect(new TextDecoder().decode(buffer)).toBe("bcde");
      expect(fs.readSync(fd, buffer, { position: null })).toBe(2);
      expect(new TextDecoder().decode(buffer.subarray(0, 2))).toBe("ef");
      fs.closeSync(fd);
    });
  });
});
