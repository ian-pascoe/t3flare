// The upstream fingerprint (SPI-1011, fragility T2): our files that restate or emulate t3 code typecheck cannot watch
// are tied to hashes of t3's regions and to literals that must still appear in t3's source. A change to either fails
// here, naming our file to review and its register entry, until the fixture is updated after that review.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkFingerprint,
  extractRegion,
  FIXTURE_PATH,
  type Fingerprint,
  fingerprintFindings,
  gitBlobOf,
  hashRegion,
  normalise,
  REPORT_ONLY,
  REPORT_ONLY_ENV,
  UPDATE_COMMAND,
  updateFingerprint,
  watchedFiles,
} from "../scripts/lib/upstreamFingerprint.ts";

const ROOT = new URL("../../../", import.meta.url);
const FIXTURE = new URL(FIXTURE_PATH, ROOT);
const T3 = new URL("t3code/", ROOT);
const readT3 = (file: string) => fs.readFileSync(new URL(file, T3), "utf8");
/** A stand-in for git's blob id in the inline cases: any function of the bytes will do. */
const fakeBlobOf = (sources: (file: string) => string | undefined) => (file: string) => {
  const text = sources(file);
  return text === undefined ? undefined : `blob:${text}`;
};

describe("normalise", () => {
  it("ignores layout: line breaks, indentation and the trailing commas a reflow adds", () => {
    expect(normalise("foo(\n  a,\n  b,\n)")).toBe(normalise("foo(a, b)"));
    expect(normalise("const x = {\n\ta: 1,\n}")).toBe(normalise("const x = { a: 1 }"));
  });

  it("keeps words apart and code that differs different", () => {
    expect(normalise("const a = b")).not.toBe(normalise("consta = b"));
    expect(normalise('["status", "-z"]')).not.toBe(normalise('["status", "-z", "--no-ahead-behind"]'));
  });
});

describe("extractRegion", () => {
  const source = [
    'import * as Effect from "effect/Effect";',
    "",
    "// About the layer.",
    "const layerA = Layer.effect(A, makeA); // trailing",
    "export interface Options {",
    "  /** The env. */",
    "  readonly env?: Record<string, string>;",
    "}",
    "export const make = Effect.gen(function* () {",
    "  const descriptor = { label, capabilities: { a: true, b: flag === 1, ...(c ? { c: true } : {}) } };",
    "  return descriptor;",
    "});",
    "export class PeerLinks extends Context.Service<PeerLinks, { readonly link: () => void }>()(\"PeerLinks\") {}",
  ].join("\n");

  it("finds a top-level declaration by name, without its comments", () => {
    expect(extractRegion(source, { symbol: "layerA" })).toBe("const layerA = Layer.effect(A, makeA);");
    expect(extractRegion(source, { symbol: "Options" })).toBe(
      "export interface Options {\n  \n  readonly env?: Record<string, string>;\n}",
    );
    expect(extractRegion(source, { symbol: "PeerLinks" })).toContain("readonly link: () => void");
  });

  it("descends a dotted path into a declaration's body", () => {
    expect(extractRegion(source, { symbol: "make.descriptor.capabilities" })).toBe(
      "capabilities: { a: true, b: flag === 1, ...(c ? { c: true } : {}) }",
    );
    expect(extractRegion(source, { symbol: "make.capabilities" })).toBe(extractRegion(source, { symbol: "make.descriptor.capabilities" }));
  });

  it("can leave out an object's plain `true` flags, so a new flag alone does not change the hash", () => {
    const withNewFlag = source.replace("a: true,", "a: true, z: true,");
    const region = { symbol: "make.capabilities", omitTrueFlags: true };
    expect(extractRegion(source, region)).toBe("capabilities: {b: flag === 1,...(c ? { c: true } : {})}");
    expect(hashRegion(withNewFlag, region)).toBe(hashRegion(source, region));
    // A new conditional flag is a host condition: it changes the hash (fragility U4).
    expect(hashRegion(source.replace("a: true,", "a: true, ...(onMac ? { d: true } : {}),"), region)).not.toBe(hashRegion(source, region));
    expect(hashRegion(source.replace("flag === 1", "flag === 2"), region)).not.toBe(hashRegion(source, region));
  });

  it("takes `*` as every top-level statement but the imports", () => {
    const all = extractRegion(source, { symbol: "*" });
    expect(all).not.toContain("import");
    expect(all).toContain("const layerA");
    expect(all).toContain("export class PeerLinks");
  });

  it("answers undefined for a symbol that is gone", () => {
    expect(extractRegion(source, { symbol: "layerB" })).toBeUndefined();
    expect(extractRegion(source, { symbol: "make.missing" })).toBeUndefined();
  });
});

describe("checkFingerprint", () => {
  const files: Record<string, string> = {
    "apps/server/src/server.ts": "const layerA = Layer.effect(A, makeA);",
    "apps/server/src/git.ts": 'const args = [\n  "status",\n  "-z",\n];',
  };
  const read = (file: string) => {
    const text = files[file];
    if (text === undefined) throw new Error(`ENOENT: ${file}`);
    return text;
  };
  const fingerprint: Fingerprint = {
    reviewedCommit: "0123456789abcdef0123456789abcdef01234567",
    regions: [
      {
        file: "apps/server/src/server.ts",
        symbol: "*",
        hash: hashRegion(files["apps/server/src/server.ts"]!, { symbol: "*" }),
        ourFile: "apps/environment/src/t3/composition.ts",
        entry: "U1",
      },
    ],
    literals: [{ file: "apps/server/src/git.ts", literal: '"status", "-z"', ourFile: "apps/agents/src/workspace/staleReads.ts", entry: "U13" }],
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `blob:${text}`])),
  };
  const blobOf = fakeBlobOf((file) => files[file]);

  it("passes when every region hashes as recorded and every literal still appears", () => {
    expect(checkFingerprint(fingerprint, read, blobOf)).toEqual([]);
  });

  it("names our file, its register entry, the diff to read and the update command when a region changed", () => {
    files["apps/server/src/server.ts"] = "const layerA = Layer.effect(A, makeA);\nconst layerReactor = Layer.effectDiscard(start);";
    const [failure, ...rest] = checkFingerprint(fingerprint, read, blobOf);
    files["apps/server/src/server.ts"] = "const layerA = Layer.effect(A, makeA);";
    expect(rest).toEqual([]);
    expect(failure).toContain("t3code/apps/server/src/server.ts (*) changed: review apps/environment/src/t3/composition.ts (U1)");
    expect(failure).toContain("git -C t3code diff 0123456789ab -- apps/server/src/server.ts");
    expect(failure).toContain(UPDATE_COMMAND);
    files["apps/server/src/server.ts"] = "const layerB = 1;";
    expect(fingerprintFindings(fingerprint, read, blobOf)).toEqual([
      { kind: "changed", file: "apps/server/src/server.ts", symbol: "*", ourFile: "apps/environment/src/t3/composition.ts", entry: "U1" },
    ]);
    files["apps/server/src/server.ts"] = "const layerA = Layer.effect(A, makeA);";
  });

  it("fails on a region whose symbol or file is gone", () => {
    const gone = { ...fingerprint, regions: [{ ...fingerprint.regions[0]!, symbol: "layerB" }, { ...fingerprint.regions[0]!, file: "apps/server/src/gone.ts" }] };
    const failures = checkFingerprint(gone, read, blobOf);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("t3code/apps/server/src/server.ts (layerB) is gone: review apps/environment/src/t3/composition.ts (U1)");
    expect(failures[1]).toContain("t3code/apps/server/src/gone.ts (*) is gone");
  });

  it("fails on a literal t3's source no longer contains, however t3 lays it out", () => {
    const moved = { ...fingerprint, literals: [{ ...fingerprint.literals[0]!, literal: '"status", "--porcelain=2"' }] };
    const [failure] = checkFingerprint(moved, read, blobOf);
    expect(failure).toContain('t3code/apps/server/src/git.ts no longer contains `"status", "--porcelain=2"`: review apps/agents/src/workspace/staleReads.ts (U13)');
  });

  it("fails on a watched file whose bytes moved outside the watched regions: the land check compares whole files", () => {
    files["apps/server/src/git.ts"] = 'const args = [\n  "status",\n  "-z",\n];\n// a comment';
    const findings = fingerprintFindings(fingerprint, read, blobOf);
    const [failure] = checkFingerprint(fingerprint, read, blobOf);
    files["apps/server/src/git.ts"] = 'const args = [\n  "status",\n  "-z",\n];';
    expect(findings).toEqual([{ kind: "moved", file: "apps/server/src/git.ts" }]);
    expect(failure).toContain("t3code/apps/server/src/git.ts changed outside the watched regions");
    expect(failure).toContain(UPDATE_COMMAND);
  });
});

describe("updateFingerprint", () => {
  const read = (file: string) => (file === "a.ts" ? "const a = 2;" : 'const b = ["x"];');
  const blobOf = fakeBlobOf(read);
  const stale: Fingerprint = {
    reviewedCommit: "old",
    regions: [{ file: "a.ts", symbol: "a", hash: "stale", ourFile: "ours.ts", entry: "U1" }],
    literals: [{ file: "b.ts", literal: '["x"]', ourFile: "ours.ts", entry: "U13" }],
    files: {},
  };

  it("records each region's current hash, each watched file's blob id, and the commit it was reviewed at", () => {
    const updated = updateFingerprint(stale, read, blobOf, "new");
    expect(updated.reviewedCommit).toBe("new");
    expect(updated.regions[0]!.hash).toBe(hashRegion("const a = 2;", { symbol: "a" }));
    expect(updated.files).toEqual({ "a.ts": "blob:const a = 2;", "b.ts": 'blob:const b = ["x"];' });
    expect(checkFingerprint(updated, read, blobOf)).toEqual([]);
  });

  it("refuses a gone region or literal: the fixture names those by hand", () => {
    expect(() => updateFingerprint({ ...stale, regions: [{ ...stale.regions[0]!, symbol: "gone" }] }, read, blobOf, "new")).toThrow(/a\.ts \(gone\) is gone/);
    expect(() => updateFingerprint({ ...stale, literals: [{ ...stale.literals[0]!, literal: '["y"]' }] }, read, blobOf, "new")).toThrow(/no longer contains/);
  });
});

describe("the pinned t3code against the checked-in fingerprint", () => {
  const fingerprint = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fingerprint;

  // The register is the list of what is fingerprinted: T2's "Covers" cell names every entry the fixture watches.
  it("watches the register entries T2 names in docs/upstream-fragility.md, and no others", () => {
    const register = fs.readFileSync(new URL("docs/upstream-fragility.md", ROOT), "utf8");
    const covers = /^\| T2 \|.*\| ((?:U\d+, )*U\d+) \| [^|]* \|$/m.exec(register)?.[1];
    expect(covers, "docs/upstream-fragility.md's T2 row no longer ends with its Covers and Ticket cells").toBeDefined();
    const entries = new Set([...fingerprint.regions, ...fingerprint.literals].map((watched) => watched.entry));
    expect([...entries].toSorted(), "the fixture's entries and T2's Covers cell differ: update the one that is wrong").toEqual(covers!.split(", ").toSorted());
  });

  it("records each watched file's blob id, for the land check", () => {
    expect(Object.keys(fingerprint.files).toSorted()).toEqual(watchedFiles(fingerprint));
  });

  // scripts/bump.ts sets REPORT_ONLY_ENV for its `pnpm run check` and reports the findings in a step of its own: a change
  // holds the pin for a person at the land check instead (ADR-0037's SPI-1011 refinement).
  const reportOnly = process.env[REPORT_ONLY_ENV] === REPORT_ONLY;

  // Under a full `pnpm run check` this parses t3's largest files on a loaded machine: well past vitest's 5 s default.
  // It is also the land check's byte-for-byte comparison: a watched file whose blob id moved is a `moved` finding.
  it.skipIf(reportOnly)("matches: every watched region, literal and file is as last reviewed", () => {
    expect(checkFingerprint(fingerprint, readT3, gitBlobOf(fileURLToPath(T3)))).toEqual([]);
  }, 30_000);
});
