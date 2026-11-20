// The node:fs coverage check (SPI-1301): which `node:fs` and `node:fs/promises` members a t3 module reads, and which of
// them the State directory's shims do not implement, so a call reaches workerd's own file system instead.
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

import { fsCoverage, fsUsageOf, shimSurfaceOf } from "../scripts/lib/fsCoverage.ts";

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
