// What the trusted update jobs check and decide (ADR-0037; in-app updates plan D4; review F1, F2, F3, A1): a candidate's
// shape, the t3 bump's manifest and lock, the report a bump job hands over, landing or only deploying, and what a
// `bump.yml` run does.
import { describe, expect, it } from "vitest";

import { landMode, landRefusal, lockProvenance, planT3, readBumpReport, t3ManifestRefusal, type LandFacts } from "../scripts/lib/land.ts";

const SHA = "cd9c39fe3c25ad71657cc0b8631b6de76775261e";
const TAG = "v0.1.11-nightly.20261117.4825";
const NEXT = "v0.1.11-nightly.20261117.4851";
const t3 = (patch: Partial<LandFacts> = {}): LandFacts => ({
  pin: { kind: "t3", tag: TAG },
  mainIsAncestor: true,
  commits: 1,
  files: ["mise.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "t3code"],
  gitlink: SHA,
  tagCommit: SHA,
  ...patch,
});

describe("a candidate's shape", () => {
  it("lands a t3 bump of one commit, its pinned files, at the tag", () => {
    expect(landRefusal(t3())).toBeUndefined();
  });

  it("refuses a branch main is not an ancestor of, or more than one commit", () => {
    expect(landRefusal(t3({ mainIsAncestor: false }))).toMatch(/not an ancestor/);
    expect(landRefusal(t3({ commits: 2 }))).toMatch(/2 commits/);
    expect(landRefusal(t3({ commits: 0 }))).toMatch(/0 commits/);
  });

  it("refuses a file outside the kind's allowlist", () => {
    expect(landRefusal(t3({ files: ["t3code", ".github/workflows/deploy-prod.yml"] }))).toMatch(/may not change \.github\/workflows\/deploy-prod\.yml/);
    expect(landRefusal({ ...t3(), pin: { kind: "cli", cli: "codex", version: "0.169.0" }, files: ["t3code"] })).toMatch(/cli bump may not change t3code/);
  });

  it("refuses a t3 gitlink that is not the requested tag's commit", () => {
    expect(landRefusal(t3({ gitlink: "0".repeat(40) }))).toMatch(/is not v0\.1\.11-nightly\.20261117\.4825's commit/);
    expect(landRefusal(t3({ tagCommit: undefined }))).toMatch(/commit \?/);
  });
});

describe("a t3 bump's content", () => {
  const manifest = (patch: Record<string, unknown>) => JSON.stringify({ name: "t3flare", packageManager: "pnpm@12.14.0", engines: { node: "26.13.1" }, scripts: { check: "vp" }, ...patch });

  it("lets package.json move only packageManager and engines.node", () => {
    expect(t3ManifestRefusal(manifest({}), manifest({ packageManager: "pnpm@12.15.0", engines: { node: "26.14.0" } }))).toBeUndefined();
    expect(t3ManifestRefusal(manifest({}), manifest({ scripts: { check: "vp", postinstall: "curl evil" } }))).toMatch(/more than/);
  });

  it("vouches for lock entries main's or t3's lock holds, checks plain registry ones, and refuses the rest", () => {
    const entry = (integrity: string, extra: Record<string, unknown> = {}) => ({ resolution: { integrity }, ...extra });
    const main = [{ packages: { "a@1.0.0": entry("sha512-AAAA") } }];
    const upstream = [{ packages: { "b@2.0.0": entry("sha512-BBBB") } }];
    const after = [
      {
        packages: {
          "a@1.0.0": entry("sha512-AAAA"),
          "b@2.0.0": entry("sha512-BBBB"),
          "@scope/c@3.1.0": entry("sha512-CCCC"),
          "d@1.0.0": { resolution: { integrity: "sha512-DDDD", tarball: "https://evil.example/d.tgz" } },
          "b@2.0.1": entry("sha512-not base64!"),
        },
      },
    ];
    expect(lockProvenance(after, main, upstream)).toEqual({ refused: ["d@1.0.0", "b@2.0.1"], registry: [{ name: "@scope/c", version: "3.1.0", integrity: "sha512-CCCC" }] });
    // A vouched key with another resolution is no longer vouched.
    expect(lockProvenance([{ packages: { "a@1.0.0": { resolution: { integrity: "sha512-ZZZZ" } } } }], main, upstream).registry).toHaveLength(1);
  });
});

describe("a bump job's report, read by a trusted job", () => {
  it("takes only strictly shaped fields, and the requested tag", () => {
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: NEXT, gate: "update" }), { kind: "t3", tag: NEXT })).toEqual({ changed: true, to: NEXT, gate: "update", land: true });
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: `${NEXT}\nsha=evil`, gate: "update" }), { kind: "t3" })).toMatch(/not a nightly tag/);
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: NEXT, gate: "update" }), { kind: "t3", tag: TAG })).toMatch(/not the requested/);
    expect(readBumpReport(JSON.stringify({ ok: true, changed: "yes", to: NEXT, gate: "full" }), { kind: "t3" })).toMatch(/boolean/);
    expect(readBumpReport(JSON.stringify({ ok: false }), { kind: "t3" })).toMatch(/not a pass/);
    expect(readBumpReport("[]", { kind: "t3" })).toMatch(/not a JSON object/);
  });

  it("lands a CLI bump that changed, and only deploys when prod runs an older pin than main's (F2)", () => {
    const report = (changed: boolean) => JSON.stringify({ ok: true, cli: "codex", changed, to: "0.169.0" });
    expect(readBumpReport(report(true), { kind: "cli", cli: "codex" })).toMatchObject({ land: true });
    expect(readBumpReport(report(false), { kind: "cli", cli: "codex", running: "0.167.2" })).toMatchObject({ changed: false, land: true });
    expect(readBumpReport(report(false), { kind: "cli", cli: "codex", running: "0.169.0" })).toMatchObject({ land: false });
    expect(readBumpReport(report(true), { kind: "cli", cli: "pi" })).toMatch(/not pi's/);
  });
});

describe("landing or only deploying (F2)", () => {
  it("only deploys when main already holds the pin or a newer one, branch or not", () => {
    expect(landMode({ kind: "t3", tag: NEXT }, { tag: NEXT })).toBe("deploy-only");
    expect(landMode({ kind: "t3", tag: TAG }, { tag: NEXT })).toBe("deploy-only");
    expect(landMode({ kind: "t3", tag: NEXT }, { tag: TAG })).toBe("land");
    expect(landMode({ kind: "t3", tag: NEXT }, {})).toBe("land");
    expect(landMode({ kind: "cli", cli: "codex", version: "0.169.0" }, { cliVersion: "0.169.0" })).toBe("deploy-only");
    expect(landMode({ kind: "cli", cli: "codex", version: "0.169.0" }, { cliVersion: "0.167.2" })).toBe("land");
  });
});

describe("what a bump.yml run does", () => {
  const branch = (gate: "update" | "full" | undefined, mainIsAncestor = true, commits = 1) => ({ gate, mainIsAncestor, commits });

  it("hourly: skips a pinned nightly or one proposed through the Full gate, and bumps one only the Update gate proved (A1)", () => {
    expect(planT3({ event: "schedule", land: false, verify: false, newest: NEXT, mainTag: NEXT })).toMatchObject({ mode: "skip" });
    expect(planT3({ event: "schedule", land: false, verify: false, newest: NEXT, mainTag: TAG, branch: branch("full") })).toMatchObject({ mode: "skip" });
    expect(planT3({ event: "schedule", land: false, verify: false, newest: NEXT, mainTag: TAG, branch: branch("update") })).toMatchObject({ mode: "bump", tag: NEXT });
    // A forged branch (no proof) does not hide a nightly.
    expect(planT3({ event: "schedule", land: false, verify: false, newest: NEXT, mainTag: TAG, branch: branch(undefined) })).toMatchObject({ mode: "bump", tag: NEXT });
  });

  it("an Update: lands when main pins the tag (a retry after a failed deploy) or a proven branch sits on main; else bumps", () => {
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: NEXT })).toMatchObject({ mode: "land" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch("update") })).toMatchObject({ mode: "land" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch(undefined) })).toMatchObject({ mode: "bump" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch("full", false) })).toMatchObject({ mode: "bump" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG })).toMatchObject({ mode: "bump", tag: NEXT });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: "main" })).toMatch(/nightly tag/);
  });

  it("verify and by-hand runs bump", () => {
    expect(planT3({ event: "workflow_dispatch", land: false, verify: true })).toMatchObject({ mode: "bump", tag: "" });
    expect(planT3({ event: "workflow_dispatch", land: false, verify: false, tag: NEXT })).toMatchObject({ mode: "bump", tag: NEXT });
  });
});
