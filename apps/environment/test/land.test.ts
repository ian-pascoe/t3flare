// What the trusted update jobs check and decide (ADR-0037; in-app updates plan D4; review F1, F2, F3, A1): a candidate's
// shape, the t3 bump's manifest and lock, the report a bump job hands over, landing or only deploying, and what a
// `bump.yml` run does.
import { describe, expect, it } from "vitest";

import {
  bumpAttemptOf,
  bumpReportNotes,
  landBindingRefusal,
  landMode,
  landRefusal,
  lockProvenance,
  planT3,
  readBumpReport,
  t3LockRefusal,
  t3ManifestRefusal,
  type LandFacts,
  type T3LockInput,
} from "../scripts/lib/land.ts";

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
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: NEXT, gate: "update" }), { kind: "t3", gate: "update", tag: NEXT })).toEqual({ changed: true, to: NEXT, gate: "update", callLand: true });
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: `${NEXT}\nsha=evil`, gate: "update" }), { kind: "t3", gate: "update" })).toMatch(/not a nightly tag/);
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: NEXT, gate: "update" }), { kind: "t3", gate: "update", tag: TAG })).toMatch(/not the requested/);
    expect(readBumpReport(JSON.stringify({ ok: true, changed: "yes", to: NEXT, gate: "full" }), { kind: "t3", gate: "full" })).toMatch(/boolean/);
    expect(readBumpReport(JSON.stringify({ ok: false }), { kind: "t3", gate: "full" })).toMatch(/not a pass/);
    expect(readBumpReport("[]", { kind: "t3", gate: "full" })).toMatch(/not a JSON object/);
  });

  it("tells the pull request only flag-shaped names and whether the acceptance test was retried (U4, U18)", () => {
    expect(bumpReportNotes(JSON.stringify({ unclassifiedCapabilities: ["newFlag", "x\n## injected", 3, "$(rm -rf)"], acceptanceRetry: { firstFailures: [] } }))).toEqual({
      unclassified: ["newFlag"],
      acceptanceRetried: true,
    });
    expect(bumpReportNotes(JSON.stringify({ unclassifiedCapabilities: null, acceptanceRetry: null }))).toEqual({ unclassified: [], acceptanceRetried: false });
    expect(bumpReportNotes("nope")).toEqual({ unclassified: [], acceptanceRetried: false });
  });

  it("records the gate the run was asked for: a report claiming another is refused (A8)", () => {
    expect(readBumpReport(JSON.stringify({ ok: true, changed: true, to: NEXT, gate: "full" }), { kind: "t3", gate: "update" })).toMatch(/not the requested update/);
  });

  it("lands a CLI bump that changed, and only deploys when prod runs an older pin than main's (F2)", () => {
    const report = (changed: boolean) => JSON.stringify({ ok: true, cli: "codex", changed, to: "0.169.0" });
    expect(readBumpReport(report(true), { kind: "cli", cli: "codex" })).toMatchObject({ callLand: true });
    expect(readBumpReport(report(false), { kind: "cli", cli: "codex", running: "0.167.2" })).toMatchObject({ changed: false, callLand: true });
    expect(readBumpReport(report(false), { kind: "cli", cli: "codex", running: "0.169.0" })).toMatchObject({ callLand: false });
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
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: NEXT })).not.toHaveProperty("proven");
    // Only a proven branch's tip is handed to land.yml (review B1).
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch("update") })).toMatchObject({ mode: "land", proven: true });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch(undefined) })).toMatchObject({ mode: "bump" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG, branch: branch("full", false) })).toMatchObject({ mode: "bump" });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: NEXT, mainTag: TAG })).toMatchObject({ mode: "bump", tag: NEXT });
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: "main" })).toMatch(/nightly tag/);
  });

  it("refuses an Update to a tag older than what main already pins, saying why (D6, A11)", () => {
    expect(planT3({ event: "workflow_dispatch", land: true, verify: false, tag: TAG, mainTag: NEXT })).toMatch(/prod is moving to v0\.1\.11-nightly\.20261117\.4851, newer than/);
  });

  it("hourly: stops retrying a tag that failed a deterministic step twice on this main, until main, the nightly or a hand moves", () => {
    const MAIN = "a".repeat(40);
    const failed = (step: string, to = NEXT, base = MAIN) => ({ base, to, failedStep: step });
    const hourly = (attempts: Parameters<typeof planT3>[0]["attempts"], mainSha = MAIN) =>
      planT3({ event: "schedule", land: false, verify: false, newest: NEXT, mainTag: TAG, mainSha, attempts });
    const check = "check (pnpm run check: patches, typecheck, lint, test)";
    expect(hourly([failed(check), failed(check)])).toMatchObject({ mode: "skip", reason: expect.stringMatching(/failed "check/) });
    expect(hourly([failed("lock matches t3's, one effect"), failed(check)])).toMatchObject({ mode: "skip" });
    // One failure is retried once (a flaky unit test); so is a step that can fail by chance.
    expect(hourly([failed(check)])).toMatchObject({ mode: "bump" });
    expect(hourly([failed(check), failed("acceptance test against the bump stage (full gate)")])).toMatchObject({ mode: "bump" });
    expect(hourly([failed("regenerate the workspace and install"), failed("regenerate the workspace and install")])).toMatchObject({ mode: "bump" });
    // Something moved: main, or the tag tried.
    expect(hourly([failed(check), failed(check)], "b".repeat(40))).toMatchObject({ mode: "bump" });
    expect(hourly([failed(check), failed(check, TAG)])).toMatchObject({ mode: "bump" });
    // An unreadable report, or none read, never stops a run.
    expect(hourly([failed(check), undefined])).toMatchObject({ mode: "bump" });
    expect(hourly(undefined)).toMatchObject({ mode: "bump" });
    // A run by hand is never stopped.
    expect(planT3({ event: "workflow_dispatch", land: false, verify: false, tag: NEXT, mainSha: MAIN, attempts: [failed(check), failed(check)] })).toMatchObject({ mode: "bump" });
  });

  it("reads an attempt only from a strictly shaped report", () => {
    const steps = [{ name: "move t3code to x", ok: true }, { name: "check (pnpm run check: …)", ok: false }];
    expect(bumpAttemptOf(JSON.stringify({ base: "c".repeat(40), to: NEXT, steps }))).toEqual({ base: "c".repeat(40), to: NEXT, failedStep: "check (pnpm run check: …)" });
    expect(bumpAttemptOf(JSON.stringify({ base: "c".repeat(40), to: NEXT, steps: [{ name: "x", ok: true }] }))).toMatchObject({ failedStep: undefined });
    expect(bumpAttemptOf(JSON.stringify({ to: NEXT, steps }))).toBeUndefined();
    expect(bumpAttemptOf(JSON.stringify({ base: "c".repeat(40), to: "main", steps }))).toBeUndefined();
    expect(bumpAttemptOf("not json")).toBeUndefined();
  });

  it("verify and by-hand runs bump", () => {
    expect(planT3({ event: "workflow_dispatch", land: false, verify: true })).toMatchObject({ mode: "bump", tag: "" });
    expect(planT3({ event: "workflow_dispatch", land: false, verify: false, tag: NEXT })).toMatchObject({ mode: "bump", tag: NEXT });
  });
});

describe("a t3 bump's lock against main's (B2)", () => {
  const entry = (integrity: string) => ({ resolution: { integrity } });
  const header = { lockfileVersion: "9.0", settings: { autoInstallPeers: true }, packageExtensionsChecksum: "x" };
  const env = { lockfileVersion: "9.0", importers: { ".": { packageManagerDependencies: { pnpm: { specifier: "12.14.0", version: "12.14.0" } } } } };
  type Graph = { readonly a: string; readonly rolldown: string; readonly react: string };
  /** A lock where t3's importer installs `a`, and t3flare's installs `rolldown` (→ `b`) and `react` through the catalog. */
  const lockOf = (graph: Graph) => {
    const main: Record<string, any> = {
      ...header,
      catalogs: { default: { react: { specifier: graph.react, version: graph.react } } },
      overrides: { a: graph.a },
      patchedDependencies: {},
      importers: {
        "t3code/apps/x": { dependencies: { a: { specifier: graph.a, version: graph.a } } },
        "apps/environment": { dependencies: { rolldown: { specifier: "^1.2.0", version: graph.rolldown }, react: { specifier: "catalog:", version: graph.react } } },
      },
      packages: { [`a@${graph.a}`]: entry("sha512-A"), [`rolldown@${graph.rolldown}`]: entry("sha512-R"), "b@1.0.0": entry("sha512-B"), [`react@${graph.react}`]: entry("sha512-C") },
      snapshots: { [`a@${graph.a}`]: {}, [`rolldown@${graph.rolldown}`]: { dependencies: { b: "1.0.0" } }, "b@1.0.0": {}, [`react@${graph.react}`]: {} },
    };
    return { main, documents: [env, main] };
  };
  const workspace = (graph: Graph) => ({ catalog: { react: graph.react }, overrides: { a: graph.a }, patchedDependencies: {} });
  const base: Graph = { a: "1.0.0", rolldown: "1.2.13", react: "19.0.0" };
  /** The candidate made from `graph`, then changed by `tamper`; t3's own lock is the untampered graph. */
  const input = (graph: Graph, tamper: (lock: Record<string, any>) => void = () => {}): T3LockInput => {
    const clean = lockOf(graph).main;
    const t3Main = { ...clean, importers: { "apps/x": clean.importers["t3code/apps/x"] } };
    const after = lockOf(graph);
    tamper(after.main);
    return { after, main: lockOf(base), t3: { main: t3Main, documents: [env, t3Main] }, mainWorkspace: workspace(base), afterWorkspace: workspace(graph), patchHashes: {} };
  };
  const moved: Graph = { ...base, react: "19.1.0" };

  it("passes what t3 moved: its own graph, and an importer of ours that follows t3's catalog", () => {
    expect(t3LockRefusal(input({ ...base, a: "1.1.0" }))).toBeUndefined();
    expect(t3LockRefusal(input(moved))).toBeUndefined();
  });

  it("refuses a candidate that repoints a t3flare importer", () => {
    expect(t3LockRefusal(input({ ...base, rolldown: "1.2.12" }))).toMatch(/apps\/environment repoints rolldown, which t3 did not move/);
  });

  it("refuses a moved dependency whose snapshot brings a package (the cycle-3 probe: react@19.1.0 → evil@6.6.6)", () => {
    const evil = (lock: Record<string, any>) => {
      lock.snapshots["react@19.1.0"] = { dependencies: { evil: "6.6.6" } };
      lock.snapshots["evil@6.6.6"] = {};
      lock.packages["evil@6.6.6"] = entry("sha512-E");
    };
    expect(t3LockRefusal(input(moved, evil))).toMatch(/changes react@19\.1\.0 outside t3's graph/);
  });

  it("refuses a moved dependency aliased to another package (the probe's alias: evil-pkg@6.6.6)", () => {
    const alias = (lock: Record<string, any>) => {
      lock.importers["apps/environment"].dependencies.react = { specifier: "catalog:", version: "evil-pkg@6.6.6" };
      lock.snapshots["evil-pkg@6.6.6"] = {};
      lock.packages["evil-pkg@6.6.6"] = entry("sha512-E");
    };
    expect(t3LockRefusal(input(moved, alias))).toMatch(/points react at another package/);
    // A version of the same package that neither t3's graph nor a lock holds.
    const unknown = (lock: Record<string, any>) => {
      lock.importers["apps/environment"].dependencies.react = { specifier: "catalog:", version: "19.2.0" };
      lock.snapshots["react@19.2.0"] = {};
    };
    expect(t3LockRefusal(input(moved, unknown))).toMatch(/points react at react@19\.2\.0, which neither/);
  });

  it("refuses a moved dependency repointed to a workspace link, in an importer or in a snapshot", () => {
    const linked = (lock: Record<string, any>) => void (lock.importers["apps/environment"].dependencies.react = { specifier: "catalog:", version: "link:../../anything" });
    expect(t3LockRefusal(input(moved, linked))).toMatch(/points react at a workspace link/);
    // main's rolldown also depends on `a`, which t3 moves 1.0.0 → 1.1.0.
    const withA = (a: string) => {
      const candidate = input({ ...base, a: "1.1.0" }, (lock) => void (lock.snapshots["rolldown@1.2.13"] = { dependencies: { b: "1.0.0", a } }));
      candidate.main.main.snapshots["rolldown@1.2.13"] = { dependencies: { b: "1.0.0", a: "1.0.0" } };
      return candidate;
    };
    expect(t3LockRefusal(withA("1.1.0"))).toBeUndefined();
    expect(t3LockRefusal(withA("link:../../anything"))).toMatch(/changes rolldown@1\.2\.13 outside t3's graph/);
  });

  it("accepts a peer-suffix variant of one of main's snapshots, and refuses one that changes anything else", () => {
    const peer = (deps: Record<string, string>) => (lock: Record<string, any>) => {
      lock.importers["apps/environment"].dependencies.rolldown = { specifier: "^1.2.0", version: "1.2.13(typescript@7.0.2)" };
      delete lock.snapshots["rolldown@1.2.13"];
      lock.snapshots["rolldown@1.2.13(typescript@7.0.2)"] = { dependencies: deps };
    };
    expect(t3LockRefusal(input(base, peer({ b: "1.0.0" })))).toBeUndefined();
    expect(t3LockRefusal(input(base, peer({ b: "1.0.0", evil: "6.6.6" })))).toMatch(/changes rolldown@1\.2\.13\(typescript@7\.0\.2\) outside/);
    expect(t3LockRefusal(input(base, peer({ b: "1.0.1" })))).toMatch(/changes rolldown@1\.2\.13\(typescript@7\.0\.2\) outside/);
  });

  it("refuses a candidate that adds a snapshot for an unrelated package, or changes one outside t3's graph", () => {
    expect(t3LockRefusal(input(base, (lock) => void (lock.snapshots["is-odd@3.0.1"] = {})))).toMatch(/adds is-odd@3\.0\.1 outside t3's graph/);
    expect(t3LockRefusal(input(base, (lock) => void (lock.snapshots["rolldown@1.2.13"] = { dependencies: { b: "1.0.0", evil: "6.6.6" } })))).toMatch(/changes rolldown@1\.2\.13 outside t3's graph/);
  });

  it("refuses an importer whose other fields moved, and a header that is not t3's or the workspace's", () => {
    expect(t3LockRefusal(input(base, (lock) => void (lock.importers["apps/environment"].dependenciesMeta = { rolldown: { injected: true } })))).toMatch(/fields besides its dependencies/);
    const changed = input(base);
    expect(t3LockRefusal({ ...changed, afterWorkspace: { ...changed.afterWorkspace, overrides: { a: "9.9.9" } } })).toMatch(/overrides are not the workspace's/);
    expect(t3LockRefusal({ ...changed, patchHashes: { "x@1.0.0": "abc" } })).toMatch(/patchedDependencies/);
  });
});

describe("land.yml's binding to the proven commit (B1)", () => {
  const sha = "a".repeat(40);
  const branch = "bump/cli-codex-0.169.0";

  it("lands the proven commit its branch still points at", () => {
    expect(landBindingRefusal({ branch, sha, tip: sha, proof: { gate: "update" } })).toBeUndefined();
  });

  it("refuses without the commit, a moved or deleted branch, or a proof that does not count", () => {
    expect(landBindingRefusal({ branch, sha: undefined, tip: sha, proof: { gate: "full" } })).toMatch(/needs the proven commit/);
    expect(landBindingRefusal({ branch, sha: "main", tip: sha, proof: { gate: "full" } })).toMatch(/needs the proven commit/);
    expect(landBindingRefusal({ branch, sha, tip: "b".repeat(40), proof: { gate: "full" } })).toMatch(/is at b+, not the proven/);
    expect(landBindingRefusal({ branch, sha, tip: undefined, proof: { gate: "full" } })).toMatch(/is at nothing/);
    expect(landBindingRefusal({ branch, sha, tip: sha, proof: { gate: undefined, reason: "its run is on agent/x, not main" } })).toBe("its run is on agent/x, not main");
    expect(landBindingRefusal({ branch, sha, tip: sha, proof: undefined })).toMatch(/proof was not read/);
  });
});
