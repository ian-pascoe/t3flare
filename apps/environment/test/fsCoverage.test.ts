// The node:fs coverage check (SPI-1301): which `node:fs` and `node:fs/promises` members a t3 module reads, and which of
// them the State directory's shims do not implement, so a call reaches workerd's own file system instead.
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

import { fsCoverage, fsCoverageFailure, fsUsageOf, shimSurfaceOf } from "../scripts/lib/fsCoverage.ts";

const usage = (code: string) => fsUsageOf(parseAst(code, { lang: "ts" }));
const uses = (code: string) => usage(code).uses.map(({ module, member, via }) => `${module}.${member} (${via})`);

describe("fsUsageOf", () => {
  it("reads a namespace import's members, and `promises` as node:fs/promises", () => {
    expect(
      uses(`import * as NodeFS from "node:fs";
        const fd = NodeFS.openSync(p, NodeFS.constants.O_RDONLY);
        await NodeFS.promises.readFile(p);`),
    ).toEqual(["fs.openSync (named)", "fs.constants (named)", "fs.promises (named)", "fs/promises.readFile (named)"]);
  });

  it("reads named imports, aliased or not, and a default import's members", () => {
    expect(
      uses(`import { readFileSync, statSync as stat } from "fs";
        import fsp, { open } from "node:fs/promises";
        await fsp.rm(p);`),
    ).toEqual(["fs.readFileSync (named)", "fs.statSync (named)", "fs/promises.open (named)", "fs/promises.rm (default)"]);
  });

  it("ignores type-only imports and type positions", () => {
    expect(
      uses(`import type { Stats } from "node:fs";
        import { type Dirent, existsSync } from "node:fs";
        import * as NodeFS from "node:fs";
        let info: NodeFS.BigIntStats; const f = (s: typeof NodeFS) => s;
        existsSync(p);`),
    ).toEqual(["fs.existsSync (named)"]);
  });

  it("ignores modules other than node:fs, and code in strings", () => {
    expect(uses('import * as fs from "node:path"; fs.join(a); const s = `const fs = require("node:fs"); fs.readSync(0)`;')).toEqual([]);
  });

  it("calls a binding used as a value, a computed member or a re-export opaque", () => {
    const { opaque } = usage(`import * as NodeFS from "node:fs";
      import fsp from "node:fs/promises";
      register(NodeFS); fsp[name](p);
      export * from "fs";`);
    expect(opaque).toEqual([
      'export * from "fs"',
      "NodeFS (node:fs) used as a value",
      "fsp (node:fs/promises) read with a computed member",
    ]);
  });

  it("calls a dynamic import opaque", () => {
    expect(usage('const fs = await import("node:fs");').opaque).toEqual(['import("node:fs")']);
  });

  it("reads destructured members, of a binding, its `promises` or an awaited dynamic import", () => {
    const result = usage(`import * as NodeFS from "node:fs";
      import fsd from "fs";
      const { watch, readSync: read } = NodeFS;
      const { open } = fsd;
      const { opendir } = NodeFS.promises;
      const { rm, promises: { cp } } = await import("node:fs");`);
    expect(result.uses.map(({ module, member, via }) => `${module}.${member} (${via})`)).toEqual([
      "fs.watch (named)",
      "fs.readSync (named)",
      "fs.open (default)",
      "fs.promises (named)",
      "fs/promises.opendir (named)",
      "fs.rm (named)",
      "fs.promises (named)",
      "fs/promises.cp (named)",
    ]);
    expect(result.opaque).toEqual([]);
  });

  it("calls a destructuring rest, or a computed key, opaque", () => {
    expect(usage('import * as F from "node:fs"; const { a, ...rest } = F; const { [k]: b } = F;').opaque).toEqual([
      "F (node:fs) destructured with a rest element",
      "F (node:fs) destructured with a computed key",
    ]);
  });

  it("follows node:fs's `promises` through a named import, and calls it opaque anywhere else", () => {
    const result = usage(`import * as NodeFS from "node:fs";
      import { promises as fsp } from "node:fs";
      await fsp.opendir(p);
      const q = NodeFS.promises; q.watch(p);`);
    expect(result.uses.map(({ module, member }) => `${module}.${member}`)).toEqual(["fs.promises", "fs/promises.opendir", "fs.promises"]);
    expect(result.opaque).toEqual(["NodeFS.promises (node:fs/promises) used as a value"]);
  });

  it("calls a re-export of node:fs's `promises` opaque", () => {
    expect(usage('export { promises } from "node:fs";').opaque).toEqual(['export { promises } from "node:fs"']);
  });
});

describe("shimSurfaceOf", () => {
  it("lists a shim's own named exports and its default object's own keys, not what it re-exports", () => {
    const surface = shimSurfaceOf(
      parseAst(
        `import * as real from "node:fs";
        export * from "node:fs";
        export function openSync() {}
        export const readFileSync = () => {}, existsSync = () => {};
        class Stats {}
        export { Stats, existsSync as exists };
        export default { ...real, openSync, readFileSync, ["computed"]: 1 };`,
        { lang: "ts" },
      ),
    );
    expect([...surface.named].toSorted((a, b) => a.localeCompare(b))).toEqual(["exists", "existsSync", "openSync", "readFileSync", "Stats"]);
    expect([...surface.defaultKeys].toSorted((a, b) => a.localeCompare(b))).toEqual(["openSync", "readFileSync"]);
  });
});

describe("fsCoverage", () => {
  const surfaces = {
    fs: { named: new Set(["openSync", "promises", "constants"]), defaultKeys: new Set(["openSync"]) },
    "fs/promises": { named: new Set(["readFile"]), defaultKeys: new Set(["readFile"]) },
  };

  it("names each use the shim does not implement, by module, with its importers", () => {
    const result = fsCoverage(
      [
        { importer: "apps/server/src/a.ts", usage: usage('import * as F from "node:fs"; F.openSync(p); F.createReadStream(p);') },
        { importer: "apps/server/src/b.ts", usage: usage('import F from "node:fs"; F.readSync(fd); F.openSync(p); F.createReadStream(p);') },
      ],
      surfaces,
      { fs: {}, "fs/promises": {} },
    );
    expect(result.uncovered).toEqual([
      { module: "fs", member: "createReadStream", importers: ["apps/server/src/a.ts", "apps/server/src/b.ts"] },
      { module: "fs", member: "readSync", importers: ["apps/server/src/b.ts"] },
    ]);
  });

  it("checks a default import's members against the default object", () => {
    const result = fsCoverage(
      [{ importer: "x.ts", usage: usage('import F from "node:fs"; F.constants;') }],
      surfaces,
      { fs: {}, "fs/promises": {} },
    );
    expect(result.uncovered).toEqual([{ module: "fs", member: "constants", importers: ["x.ts"] }]);
  });

  it("passes a member allowed with a reason, and reports an allowance nothing uses", () => {
    const result = fsCoverage(
      [{ importer: "x.ts", usage: usage('import * as F from "node:fs"; F.createReadStream(p);') }],
      surfaces,
      { fs: { createReadStream: "reason", watch: "reason" }, "fs/promises": {} },
    );
    expect(result.uncovered).toEqual([]);
    expect(result.allowed).toEqual(["fs.createReadStream"]);
    expect(result.unusedAllowances).toEqual(["fs.watch"]);
  });

  it("carries each importer's opaque uses", () => {
    const result = fsCoverage(
      [{ importer: "x.ts", usage: usage('import * as F from "node:fs"; use(F);') }],
      surfaces,
      { fs: {}, "fs/promises": {} },
    );
    expect(result.opaque).toEqual(["x.ts: F (node:fs) used as a value"]);
  });
});

describe("fsCoverageFailure", () => {
  it("passes coverage with nothing uncovered or opaque", () => {
    expect(fsCoverageFailure({ uncovered: [], opaque: [], allowed: ["fs.write"], unusedAllowances: ["fs.watch"] })).toBeUndefined();
  });

  it("names each uncovered member with its readers, and each opaque use, with what to do about each", () => {
    const failure = fsCoverageFailure({
      uncovered: [{ module: "fs", member: "readSync", importers: ["a.ts", "b.ts"] }],
      opaque: ["c.ts: F (node:fs) used as a value"],
      allowed: [],
      unusedAllowances: [],
    });
    expect(failure).toContain("node:fs.readSync, read by a.ts, b.ts");
    expect(failure).toContain("FS_ALLOWANCES");
    expect(failure).toContain("c.ts: F (node:fs) used as a value");
    expect(failure).toContain("rewrite");
  });
});
