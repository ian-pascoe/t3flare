// Fragility U10: the typecheck fails on errors in t3flare's files, and reports, without failing, errors in t3's own
// files that only this program's configuration sees.
import { describe, expect, it } from "vitest";

import { packagePath, parseDiagnostics, T3_ERRORS_COUNT, t3ErrorsHeading, typecheckVerdict, workerdOwnership } from "../scripts/lib/typecheckFilter.ts";

const cwd = "/repo/apps/environment";
const t3Root = "/repo/t3code";

const T3_ERROR = [
  "../../t3code/apps/server/src/cloud/pinnedRuntime.ts(286,48): error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'BufferSource'.",
  "  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.",
].join("\n");
const OUR_ERROR = "src/t3/capabilities.ts(113,12): error TS2741: Property 'accessTokenRenewal' is missing in type '{}'.";
const SUGGESTION = "src/connect/service.ts(62,54): suggestion TS377141: Add `{ readonly brand: unique symbol }` as the second type argument.";

describe("the typecheck's verdict", () => {
  it("reads each diagnostic with the lines that continue it", () => {
    const { diagnostics, unparsed } = parseDiagnostics(`${SUGGESTION}\n${T3_ERROR}\n\n${OUR_ERROR}\n`);
    expect(unparsed).toEqual([]);
    expect(diagnostics.map((d) => [d.file, d.category])).toEqual([
      ["src/connect/service.ts", "suggestion"],
      ["../../t3code/apps/server/src/cloud/pinnedRuntime.ts", "error"],
      ["src/t3/capabilities.ts", "error"],
    ]);
    expect(diagnostics[1]!.text).toBe(T3_ERROR);
  });

  it("passes when every error is in t3's own files, and reports them", () => {
    const verdict = typecheckVerdict(2, `${SUGGESTION}\n${T3_ERROR}\n`, cwd, t3Root);
    expect(verdict.ok).toBe(true);
    expect(verdict.t3Errors.map((d) => d.text)).toEqual([T3_ERROR]);
    expect(verdict.ours.map((d) => d.category)).toEqual(["suggestion"]);
  });

  it("fails on an error in our files, whatever t3's files hold", () => {
    expect(typecheckVerdict(2, `${T3_ERROR}\n${OUR_ERROR}\n`, cwd, t3Root)).toMatchObject({ ok: false });
    expect(typecheckVerdict(2, `${OUR_ERROR}\n`, cwd, t3Root)).toMatchObject({ ok: false });
  });

  it("fails when the compiler exits non-zero with no error to show for it", () => {
    expect(typecheckVerdict(1, "error: could not read tsconfig.json\n", cwd, t3Root)).toMatchObject({ ok: false, reason: expect.stringMatching(/exited 1/) });
    expect(typecheckVerdict(0, `${SUGGESTION}\n`, cwd, t3Root)).toMatchObject({ ok: true });
  });

  it("prints a heading over t3's errors that the bump reads their count back from", () => {
    expect(T3_ERRORS_COUNT.exec(`ours\n\n${t3ErrorsHeading(3)}\n${T3_ERROR}`)?.[1]).toBe("3");
    expect(T3_ERRORS_COUNT.exec(OUR_ERROR)).toBeNull();
  });

  it("fails beside a t3 error when the compiler printed anything else, or died by a signal", () => {
    expect(typecheckVerdict(2, `${T3_ERROR}\nerror TS2688: Cannot find type definition file for 'node'.\n`, cwd, t3Root)).toMatchObject({ ok: false, reason: expect.stringMatching(/TS2688/) });
    expect(typecheckVerdict(2, `${T3_ERROR}\npanic: runtime error: index out of range\ngoroutine 1 [running]:\n`, cwd, t3Root)).toMatchObject({ ok: false });
    expect(typecheckVerdict(null, `${T3_ERROR}\n`, cwd, t3Root)).toMatchObject({ ok: false, reason: expect.stringMatching(/signal/) });
  });

  it("passes errors in our files that a program does not own, and fails on one in a file it owns", () => {
    const ownership = (file: string) => file.endsWith(".workerd.test.ts");
    const workerdError = "test/stateStore.workerd.test.ts(3,1): error TS2322: no.";
    const verdict = typecheckVerdict(2, `${OUR_ERROR}\n${T3_ERROR}\n`, cwd, t3Root, ownership);
    expect(verdict).toMatchObject({ ok: true, ours: [] });
    expect(verdict.elsewhereErrors.map((d) => d.text)).toEqual([OUR_ERROR]);
    expect(verdict.t3Errors.map((d) => d.text)).toEqual([T3_ERROR]);
    expect(typecheckVerdict(2, `${OUR_ERROR}\n`, cwd, t3Root, ownership)).toMatchObject({ ok: true });
    expect(typecheckVerdict(2, `${OUR_ERROR}\n${workerdError}\n`, cwd, t3Root, ownership)).toMatchObject({ ok: false });
  });

  it("judges the workerd program's files on the resolved path, however the compiler prints it", () => {
    for (const file of ["test/stateStore.workerd.test.ts", "./test/stateStore.workerd.test.ts", `${cwd}/test/stateStore.workerd.test.ts`, "test\\stateStore.workerd.test.ts"]) {
      expect(packagePath(file, cwd)).toBe("test/stateStore.workerd.test.ts");
      expect(typecheckVerdict(2, `${file}(3,1): error TS2322: no.\n`, cwd, t3Root, workerdOwnership)).toMatchObject({ ok: false, ours: [{ file }] });
    }
    for (const file of ["src/shims/node-fs.ts", "./src/shims/node-fs.ts", `${cwd}/src/shims/node-fs.ts`]) {
      expect(typecheckVerdict(2, `${file}(18,54): error TS18046: no.\n`, cwd, t3Root, workerdOwnership)).toMatchObject({ ok: true, ours: [], elsewhereErrors: [{ file }] });
    }
  });

  it("fails on an error in a file the program cannot place", () => {
    const outside = "../../packages/harness-registry/src/index.ts(1,1): error TS2322: no.";
    expect(typecheckVerdict(2, `${outside}\n${T3_ERROR}\n`, cwd, t3Root, workerdOwnership)).toMatchObject({ ok: false, reason: expect.stringMatching(/no program owns/) });
  });

  it("counts a file as t3's only inside the submodule", () => {
    const sibling = "../../t3code-shims/x.ts(1,1): error TS1: no.";
    expect(typecheckVerdict(2, `${sibling}\n`, cwd, t3Root)).toMatchObject({ ok: false });
  });
});
