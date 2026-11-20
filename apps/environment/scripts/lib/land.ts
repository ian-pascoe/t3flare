// What a trusted job checks before a proposed pin is published as proven or lands on `main` (ADR-0037; in-app
// updates plan D4; review F2, F3). The facts come from git and GitHub (`scripts/land-check.ts`, `scripts/updates-ci.ts`);
// the files themselves were written by a job that ran upstream code, so nothing here trusts their content: each rule
// checks it. Dependency-free.
import { bareKey, closure, DEPENDENCY_FIELDS, importerKey, type Json, nameOfKey } from "../../../../scripts/lockGraph.ts";
import { compareVersions, CLI_PIN_FILES, EXACT_VERSION, NIGHTLY_TAG, type Pin, T3_PIN_FILES } from "../../src/updates/pins.ts";
import { type Fingerprint, LIST_COMMAND, UPDATE_COMMAND, watchedFiles } from "./upstreamFingerprintFixture.ts";

export const LAND_ALLOWLIST = { t3: T3_PIN_FILES, cli: CLI_PIN_FILES } as const;

export interface LandFacts {
  readonly pin: Pin;
  /** `git merge-base --is-ancestor origin/main <candidate>` passed. */
  readonly mainIsAncestor: boolean;
  /** `git rev-list --count origin/main..<candidate>`. */
  readonly commits: number;
  /** `git diff --name-only origin/main <candidate>`. */
  readonly files: ReadonlyArray<string>;
  /** A t3 bump: the candidate's `t3code` gitlink, and the commit of the tag the caller named (never the report's). */
  readonly gitlink?: string | undefined;
  readonly tagCommit?: string | undefined;
}

/** Why the candidate may not land by its shape (one commit, its kind's files, the tag's gitlink), or undefined. */
export const landRefusal = (facts: LandFacts): string | undefined => {
  if (!facts.mainIsAncestor) return "origin/main is not an ancestor of the branch: main moved on, or the branch is not a bump of it";
  if (facts.commits !== 1) return `the branch is ${facts.commits} commits on origin/main, not one`;
  const allowed = new Set<string>(LAND_ALLOWLIST[facts.pin.kind]);
  const outside = facts.files.filter((file) => !allowed.has(file));
  if (outside.length > 0) return `a ${facts.pin.kind} bump may not change ${outside.join(", ")}`;
  if (facts.files.length === 0) return "the branch changes nothing";
  if (facts.pin.kind === "t3") {
    if (facts.gitlink === undefined || facts.tagCommit === undefined || facts.gitlink !== facts.tagCommit) {
      return `the t3code gitlink ${facts.gitlink ?? "?"} is not ${facts.pin.tag}'s commit ${facts.tagCommit ?? "?"}`;
    }
  }
  return undefined;
};

/**
 * Land, or only deploy (F2): when main already holds the pin (or a newer one), there is nothing to push, and the land
 * deploys main's tip. That is how a press recovers a land whose push went through and whose deploy failed, whether or
 * not the branch is still there.
 */
export const landMode = (pin: Pin, main: { readonly tag?: string | undefined; readonly cliVersion?: string | undefined }): "land" | "deploy-only" => {
  if (pin.kind === "t3") return main.tag !== undefined && NIGHTLY_TAG.test(main.tag) && compareVersions(main.tag.slice(1), pin.tag.slice(1)) >= 0 ? "deploy-only" : "land";
  return main.cliVersion !== undefined && compareVersions(main.cliVersion, pin.version) >= 0 ? "deploy-only" : "land";
};

/** A t3 bump's root package.json: only `packageManager` and `engines.node` move (gen-workspace.ts's two fields). */
export const t3ManifestRefusal = (before: string, after: string): string | undefined => {
  const strip = (text: string) => {
    const json = JSON.parse(text) as { packageManager?: unknown; engines?: Record<string, unknown> };
    const { packageManager: _, engines, ...rest } = json;
    const { node: __, ...otherEngines } = engines ?? {};
    return JSON.stringify({ ...rest, engines: otherEngines });
  };
  return strip(before) === strip(after) ? undefined : "package.json changes more than packageManager and engines.node";
};

type LockDocuments = ReadonlyArray<{ readonly packages?: Readonly<Record<string, unknown>> } | null | undefined>;

const stable = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
    : JSON.stringify(value);

export interface LockProvenance {
  /** Entries neither lock vouches for that are not plain registry packages (a tarball URL, git, a directory): refused. */
  readonly refused: ReadonlyArray<string>;
  /** Entries neither lock vouches for, resolved from the npm registry by integrity alone: checked against the registry. */
  readonly registry: ReadonlyArray<{ readonly name: string; readonly version: string; readonly integrity: string }>;
}

/**
 * The package entries of t3's graph in a t3 bump's lock (F3), after `t3LockRefusal` has held everything outside that
 * graph to main's or t3's lock. An entry main's lock or t3's lock at the tag holds exactly is vouched for; any other must
 * be a plain registry entry (`resolution: {integrity}` and nothing else), which `land-check.ts` asks the npm registry to
 * confirm for that name@version. Anything else is refused.
 */
export const lockProvenance = (after: LockDocuments, main: LockDocuments, t3: LockDocuments): LockProvenance => {
  const vouched = new Map<string, Set<string>>();
  for (const documents of [main, t3]) {
    for (const document of documents) {
      for (const [key, entry] of Object.entries(document?.packages ?? {})) vouched.set(key, (vouched.get(key) ?? new Set()).add(stable(entry)));
    }
  }
  const refused: Array<string> = [];
  const registry: Array<{ name: string; version: string; integrity: string }> = [];
  for (const document of after) {
    for (const [key, entry] of Object.entries(document?.packages ?? {})) {
      if (vouched.get(key)?.has(stable(entry))) continue;
      const match = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(key);
      const resolution = (entry as { resolution?: Record<string, unknown> } | null)?.resolution;
      const integrity = resolution?.integrity;
      if (match === null || resolution === undefined || Object.keys(resolution).length !== 1 || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) {
        refused.push(key);
      } else registry.push({ name: match[1]!, version: match[2]!, integrity });
    }
  }
  return { refused, registry };
};

const T3_IMPORTER = "t3code/";
const sameJson = (a: unknown, b: unknown) => stable(a) === stable(b);

/** The package names a workspace's catalog, overrides and patches move between `before` and `after` (both t3-derived). */
export const workspaceMovedNames = (before: Json, after: Json): Set<string> => {
  const names = new Set<string>();
  for (const field of ["catalog", "overrides", "patchedDependencies"]) {
    const [a, b] = [before[field] ?? {}, after[field] ?? {}] as [Json, Json];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (sameJson(a[key], b[key])) continue;
      // `a@1.2>b`: both a and b move.
      for (const segment of key.split(">")) names.add(/^(@?[^@]+)/.exec(segment)?.[1] ?? segment);
    }
  }
  return names;
};

export interface T3LockInput {
  /** The candidate's lock, main's, and t3's own at the tag: each the main document and every document. */
  readonly after: { readonly main: Json; readonly documents: ReadonlyArray<Json> };
  readonly main: { readonly main: Json; readonly documents: ReadonlyArray<Json> };
  readonly t3: { readonly main: Json; readonly documents: ReadonlyArray<Json> };
  /** pnpm-workspace.yaml on main, and the candidate's (which `gen-workspace.ts --check` made from t3 at the tag). */
  readonly mainWorkspace: Json;
  readonly afterWorkspace: Json;
  /** sha256 of each patch file the candidate's workspace names, by its key, computed by the trusted job. */
  readonly patchHashes: Readonly<Record<string, string>>;
}

/**
 * The t3 bump's lock against main's (review B2): it may differ only where t3 moved. Allowed to change, all derived from
 * the t3 side: t3's own importers and everything they install (`verify-lock.ts` holds that closure to t3's own lock),
 * the names t3's catalog, overrides and patches moved, and the names whose versions moved inside t3's closure. Outside
 * t3's graph, t3flare's importers and every snapshot and package are main's or t3's own: an importer entry may move only
 * for a moved name, to a version of the same package t3's graph or a lock holds; a snapshot may differ from one of the
 * same package and version only in a peer suffix or a moved dependency naming the same package. The header is t3's
 * (settings, catalogs) and the workspace's (overrides, patches with their files' hashes); pnpm's own document is t3's.
 * Returns why not, or undefined.
 */
export const t3LockRefusal = (input: T3LockInput): string | undefined => {
  const { after, main, t3 } = input;
  const [lock, base] = [after.main, main.main];
  for (const field of ["lockfileVersion", "settings", "packageExtensionsChecksum"]) {
    if (!sameJson(lock[field], t3.main[field])) return `the lock's ${field} is not t3's`;
  }
  // pnpm keeps only the catalog entries the install uses: each must be t3's.
  for (const [catalog, entries] of Object.entries<Json>(lock.catalogs ?? {})) {
    for (const [name, entry] of Object.entries(entries)) {
      if (!sameJson(entry, t3.main.catalogs?.[catalog]?.[name])) return `the lock's catalog entry ${name} is not t3's`;
    }
  }
  // The workspace's overrides, with `catalog:` read from its catalog, as pnpm records them.
  const workspace = input.afterWorkspace;
  const resolved = Object.fromEntries(
    Object.entries<string>(workspace.overrides ?? {}).map(([key, value]) => {
      const name = /^(@?[^@]+)/.exec(key.split(">").at(-1)!)?.[1] ?? key;
      const catalog = /^catalog:(.*)$/.exec(value);
      return [key, catalog === null ? value : catalog[1] === "" || catalog[1] === "default" ? workspace.catalog?.[name] : workspace.catalogs?.[catalog[1]!]?.[name]];
    }),
  );
  if (!sameJson(lock.overrides ?? {}, resolved)) return "the lock's overrides are not the workspace's";
  if (!sameJson(lock.patchedDependencies ?? {}, input.patchHashes)) return "the lock's patchedDependencies are not the workspace's patches";
  const env = (documents: ReadonlyArray<Json>, mainDocument: Json) => documents.filter((document) => document !== mainDocument);
  if (!sameJson(env(after.documents, lock), env(t3.documents, t3.main))) return "pnpm's own document is not t3's";

  const t3Importers = (doc: Json) => Object.keys(doc.importers ?? {}).filter((dir) => dir.startsWith(T3_IMPORTER));
  const ours = (doc: Json) => Object.keys(doc.importers ?? {}).filter((dir) => !dir.startsWith(T3_IMPORTER)).sort();
  const inT3 = closure(lock, t3Importers(lock));
  const versionsOf = (keys: Iterable<string>) => new Set([...keys].map(bareKey));
  const [beforeT3, afterT3] = [versionsOf(closure(base, t3Importers(base))), versionsOf(inT3)];
  const moved = workspaceMovedNames(input.mainWorkspace, input.afterWorkspace);
  for (const key of [...beforeT3].filter((key) => !afterT3.has(key)).concat([...afterT3].filter((key) => !beforeT3.has(key)))) moved.add(nameOfKey(key));

  // What a lock holds (a snapshot or package key), on main or in t3's own lock at the tag: what a repointed entry may name.
  const known = (key: string) =>
    base.snapshots?.[key] !== undefined || base.packages?.[bareKey(key)] !== undefined || t3.main.snapshots?.[key] !== undefined || t3.main.packages?.[bareKey(key)] !== undefined || afterT3.has(bareKey(key));
  /** The package a dependency value names: `1.2.3(peer)` names `name` itself, an alias `other@1.2.3` names `other`. */
  const targetName = (name: string, value: string) => nameOfKey(importerKey(name, value) ?? `${name}@`);

  // t3flare's importers: main's, but for a dependency whose name t3 moved, now at a version t3's graph or a lock holds,
  // of the same package; or a peer suffix. Their other fields (`dependenciesMeta`, …) are main's.
  if (!sameJson(ours(lock), ours(base))) return "t3flare's importers are not main's";
  for (const dir of ours(lock)) {
    const strip = (importer: Json) => Object.fromEntries(Object.entries(importer ?? {}).filter(([field]) => !(DEPENDENCY_FIELDS as ReadonlyArray<string>).includes(field)));
    if (!sameJson(strip(lock.importers[dir]), strip(base.importers[dir]))) return `${dir}'s fields besides its dependencies are not main's`;
    for (const field of DEPENDENCY_FIELDS) {
      const [now, was] = [(lock.importers[dir][field] ?? {}) as Json, (base.importers[dir][field] ?? {}) as Json];
      if (!sameJson(Object.keys(now).sort(), Object.keys(was).sort())) return `${dir}'s ${field} are not main's`;
      for (const name of Object.keys(now)) {
        if (sameJson(now[name], was[name])) continue;
        const [version, previous] = [String(now[name].version), String(was[name].version)];
        // A peer suffix only (the same package at the same version, its peers moved): its snapshot is checked below.
        if (now[name].specifier === was[name].specifier && bareKey(`${name}@${version}`) === bareKey(`${name}@${previous}`)) continue;
        if (!moved.has(name)) return `${dir} repoints ${name}, which t3 did not move`;
        if (now[name].specifier !== was[name].specifier && !String(was[name].specifier).startsWith("catalog:")) return `${dir} changes ${name}'s specifier`;
        if (targetName(name, version) !== targetName(name, previous)) return `${dir} points ${name} at another package`;
        const key = importerKey(name, version);
        if (key === undefined) return `${dir} points ${name} at a workspace link`;
        if (!known(key)) return `${dir} points ${name} at ${bareKey(key)}, which neither t3's graph nor a lock holds`;
      }
    }
  }

  // Snapshots: t3's own graph is held to t3's lock by verify-lock.ts. Every other one is main's, or a variant of a
  // snapshot of the same package and version in main's or t3's lock whose dependencies differ only in a peer suffix, or
  // in a name t3 moved, still naming the same package (review B2: nothing a moved entry reaches is taken on trust).
  const free = inT3;
  const differsOnlyWhereMoved = (now: Json, was: Json) => {
    const { dependencies: d1, optionalDependencies: o1, ...rest1 } = now;
    const { dependencies: d2, optionalDependencies: o2, ...rest2 } = was;
    if (!sameJson(rest1, rest2)) return false;
    for (const [a, b] of [[d1 ?? {}, d2 ?? {}], [o1 ?? {}, o2 ?? {}]] as Array<[Json, Json]>) {
      if (!sameJson(Object.keys(a).sort(), Object.keys(b).sort())) return false;
      for (const name of Object.keys(a)) {
        if (a[name] === b[name]) continue;
        if (targetName(name, String(a[name])) !== targetName(name, String(b[name]))) return false;
        if (moved.has(name)) {
          if (importerKey(name, String(a[name])) === undefined) return false;
          continue;
        }
        if (bareKey(`${name}@${a[name]}`) !== bareKey(`${name}@${b[name]}`)) return false;
      }
    }
    return true;
  };
  const variants = new Map<string, Array<Json>>();
  for (const snapshots of [base.snapshots ?? {}, t3.main.snapshots ?? {}] as Array<Json>) {
    for (const [key, entry] of Object.entries<Json>(snapshots)) variants.set(bareKey(key), [...(variants.get(bareKey(key)) ?? []), entry]);
  }
  for (const [key, entry] of Object.entries<Json>(lock.snapshots ?? {})) {
    if (free.has(key) || sameJson(entry, base.snapshots?.[key])) continue;
    const candidates = variants.get(bareKey(key)) ?? [];
    if (candidates.length === 0) return `the lock adds ${bareKey(key)} outside t3's graph`;
    if (!candidates.some((variant) => differsOnlyWhereMoved(entry, variant))) return `the lock changes ${key} outside t3's graph`;
  }
  // Packages: t3's graph's go to `lockProvenance`; any other is main's or t3's, exactly.
  const freeVersions = versionsOf(free);
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (freeVersions.has(key) || sameJson(entry, base.packages?.[key]) || sameJson(entry, t3.main.packages?.[key])) continue;
    return `the lock changes the package ${key} outside t3's graph`;
  }
  return undefined;
};

/** A proposed t3 branch as the plan sees it: its proof (A1) and whether it sits on main. */
export interface ProposedBranch {
  readonly gate: "update" | "full" | undefined;
  readonly mainIsAncestor: boolean;
  readonly commits: number;
}

export interface T3PlanInput {
  readonly event: "schedule" | "workflow_dispatch";
  /** The dispatch's `tag`, `land` and `verify` inputs. */
  readonly tag?: string | undefined;
  readonly land: boolean;
  readonly verify: boolean;
  /** The newest nightly on t3code's origin, and the tag main's gitlink is. */
  readonly newest?: string | undefined;
  readonly mainTag?: string | undefined;
  /** `bump/<tag>` of the tag the run is about, when it exists. */
  readonly branch?: ProposedBranch | undefined;
  /** Hourly: the commit of main this run would test, and the newest earlier hourly attempts, newest first. */
  readonly mainSha?: string | undefined;
  readonly attempts?: ReadonlyArray<BumpAttempt | undefined> | undefined;
}

/**
 * The names of `scripts/bump.ts`'s steps whose failure the same inputs reproduce: the same t3 tag on the same t3flare
 * commit fails them again. bump.ts names its steps from here, so the plan's reading of a report follows a rename. The
 * install (the registry) and every step after the check (Docker, Cloudflare, the stage, npm) can fail by chance.
 */
export const DETERMINISTIC_STEPS = {
  /** Followed by the tag. */
  move: "move t3code to",
  lock: "lock matches t3's, one effect",
  check: "check (pnpm run check: patches, typecheck, lint, test)",
} as const;
type DeterministicStep = keyof typeof DETERMINISTIC_STEPS;

/** An earlier bump job's attempt, read from its report (untrusted; `bumpAttemptOf`). */
export interface BumpAttempt {
  /** The commit of t3flare it tested, and the tag it tried. */
  readonly base: string;
  readonly to: string;
  /**
   * Its first failed step: one of DETERMINISTIC_STEPS' keys, `other` for any other step, or undefined when none failed.
   * Never the report's own text, which a trusted job must not print (ADR-0037).
   */
  readonly failed: DeterministicStep | "other" | undefined;
}

/** A report's top-level object, or why not: the one parse every reader of an untrusted report shares. */
const reportObject = (text: string): Record<string, unknown> | string => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ? "the report is not a JSON object" : (parsed as Record<string, unknown>);
  } catch {
    return "the report is not JSON";
  }
};

const stepKindOf = (name: string): DeterministicStep | "other" => {
  if (name.startsWith(`${DETERMINISTIC_STEPS.move} `)) return "move";
  if (name === DETERMINISTIC_STEPS.lock) return "lock";
  if (name === DETERMINISTIC_STEPS.check) return "check";
  return "other";
};
/** How many hourly attempts in a row must fail a deterministic step before the plan stops retrying: one retry covers a flaky unit test. */
export const DETERMINISTIC_FAILURES_TO_STOP = 2;

/** An attempt from a bump job's report, or undefined when the report is not one this can read. */
export const bumpAttemptOf = (text: string): BumpAttempt | undefined => {
  const report = reportObject(text);
  if (typeof report === "string") return undefined;
  if (typeof report.base !== "string" || !/^[0-9a-f]{40}$/.test(report.base)) return undefined;
  if (typeof report.to !== "string" || !NIGHTLY_TAG.test(report.to)) return undefined;
  if (!Array.isArray(report.steps)) return undefined;
  const failed = (report.steps as Array<unknown>).find((s): s is { name: string } => s !== null && typeof s === "object" && (s as { ok?: unknown }).ok === false && typeof (s as { name?: unknown }).name === "string");
  return { base: report.base, to: report.to, failed: failed === undefined ? undefined : stepKindOf(failed.name) };
};

const failedDeterministically = (attempt: BumpAttempt | undefined, tag: string, mainSha: string): boolean =>
  attempt !== undefined &&
  attempt.to === tag &&
  attempt.base === mainSha &&
  attempt.failed !== undefined &&
  attempt.failed !== "other";

export type T3Plan = { readonly mode: "skip" | "bump" | "land"; readonly tag: string; readonly reason: string; readonly proven?: boolean };

const atOrAbove = (tag: string | undefined, target: string) => tag !== undefined && NIGHTLY_TAG.test(tag) && compareVersions(tag.slice(1), target.slice(1)) >= 0;

/**
 * What a `bump.yml` run does, decided by a trusted job before any upstream code runs (review F1, F2, A1):
 * - hourly: skip a nightly main already pins, or one already proposed through the Full gate; else bump it.
 * - an Update (`land`): land when main already pins it (land.yml then only deploys) or a branch the trusted publish job
 *   proved (either gate) sits one commit on main; else bump it through the Update gate first.
 * - anything else (by hand, verify): bump.
 */
export const planT3 = (input: T3PlanInput): T3Plan | string => {
  if (input.verify) return { mode: "bump", tag: "", reason: "verify main's own pin through the Full gate" };
  if (input.event === "schedule") {
    const newest = input.newest;
    if (newest === undefined) return { mode: "skip", tag: "", reason: "no nightly tag" };
    if (atOrAbove(input.mainTag, newest)) return { mode: "skip", tag: newest, reason: `${newest} is already pinned` };
    if (input.branch?.gate === "full") return { mode: "skip", tag: newest, reason: `${newest} is already proposed through the Full gate` };
    // The same tag on the same main failed the same way: another hour changes nothing. A commit on main, a newer
    // nightly or a run by hand tries again.
    const recent = (input.attempts ?? []).slice(0, DETERMINISTIC_FAILURES_TO_STOP);
    if (input.mainSha !== undefined && recent.length === DETERMINISTIC_FAILURES_TO_STOP && recent.every((attempt) => failedDeterministically(attempt, newest, input.mainSha!))) {
      return { mode: "skip", tag: newest, reason: `${newest} failed its ${recent[0]!.failed} step on this main ${DETERMINISTIC_FAILURES_TO_STOP} times; a change to main, a newer nightly or a run by hand tries again` };
    }
    return { mode: "bump", tag: newest, reason: input.branch?.gate === "update" ? `${newest} was proven by the Update gate only; the Full gate proposes it` : `${newest} is new` };
  }
  if (!input.land) return { mode: "bump", tag: input.tag ?? "", reason: "a bump by hand" };
  if (input.tag === undefined || !NIGHTLY_TAG.test(input.tag)) return `an Update needs a nightly tag, not ${JSON.stringify(input.tag)}`;
  // D6, review A11: an Update moves prod to exactly the client's tag. Main already past it means prod is about to move
  // past it too: refused, so the client is told why, rather than deploying the newer pin and failing its check later.
  if (input.mainTag !== undefined && NIGHTLY_TAG.test(input.mainTag) && compareVersions(input.mainTag.slice(1), input.tag.slice(1)) > 0) {
    return `prod is moving to ${input.mainTag}, newer than ${input.tag}: update to ${input.mainTag} once it is deployed`;
  }
  if (input.mainTag === input.tag) return { mode: "land", tag: input.tag, reason: `main already pins ${input.tag}; deploy it` };
  const branch = input.branch;
  if (branch !== undefined && branch.gate !== undefined && branch.mainIsAncestor && branch.commits === 1) {
    return { mode: "land", tag: input.tag, reason: `bump/${input.tag} is proven (${branch.gate} gate) on top of main`, proven: true };
  }
  return { mode: "bump", tag: input.tag, reason: `bump/${input.tag} is not proven on top of main` };
};

/**
 * A bump job's report, read by a trusted job (review F1): untrusted input, so every field it uses is checked against a
 * strict pattern, and a t3 report must pin the tag the caller asked for. Returns what the job may act on, or why not.
 */
export const readBumpReport = (
  text: string,
  expect:
    | { readonly kind: "t3"; readonly gate: "update" | "full"; readonly tag?: string | undefined }
    | { readonly kind: "cli"; readonly cli: string; readonly running?: string | undefined },
): { readonly changed: boolean; readonly to: string; readonly gate: "update" | "full"; readonly callLand: boolean } | string => {
  const report = reportObject(text);
  if (typeof report === "string") return report;
  if (report.ok !== true) return "the report is not a pass";
  if (typeof report.changed !== "boolean") return "report.changed is not a boolean";
  const changed = report.changed;
  if (expect.kind === "t3") {
    if (typeof report.to !== "string" || !NIGHTLY_TAG.test(report.to)) return `report.to is not a nightly tag: ${JSON.stringify(report.to)}`;
    // Review A8: the gate is the one the run was asked for; the report must say it ran that one.
    if (report.gate !== expect.gate) return `the report's gate is ${JSON.stringify(report.gate)}, not the requested ${expect.gate}`;
    if (expect.tag !== undefined && report.to !== expect.tag) return `the report pins ${report.to}, not the requested ${expect.tag}`;
    return { changed, to: report.to, gate: expect.gate, callLand: changed };
  }
  if (report.cli !== expect.cli) return `the report is not ${expect.cli}'s`;
  if (typeof report.to !== "string" || !EXACT_VERSION.test(report.to)) return `report.to is not a version: ${JSON.stringify(report.to)}`;
  if (expect.running !== undefined && !EXACT_VERSION.test(expect.running)) return `the running version is not a version: ${JSON.stringify(expect.running)}`;
  // F2: a press while prod runs an older pin than main's newest lands nothing new, and only deploys (land.yml then
  // deploys main, whatever `to` says).
  return { changed, to: report.to, gate: "update", callLand: changed || (expect.running !== undefined && expect.running !== report.to) };
};

const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * What a t3 bump's pull request tells its reader beyond the pass (fragility U4, U18), from the untrusted report: the
 * capability flags stripped until classified (only names shaped as flags; anything else is dropped), whether the
 * acceptance test passed only on its second attempt, how many type errors in t3's own files the typecheck passed
 * over (U10; a whole number, else 0), and the upstream fingerprint's findings (T2; path-, symbol- and entry-shaped only,
 * a literal's text never). Never part of a decision to publish or land: the land check compares the files itself.
 */
export const bumpReportNotes = (
  text: string,
): { readonly unclassified: ReadonlyArray<string>; readonly acceptanceRetried: boolean; readonly t3TypeErrors: number; readonly fingerprint: ReadonlyArray<string> } => {
  const parsed = reportObject(text);
  const report = typeof parsed === "string" ? {} : parsed;
  const unclassified = Array.isArray(report.unclassifiedCapabilities)
    ? report.unclassifiedCapabilities.filter((key): key is string => typeof key === "string" && CAPABILITY_KEY.test(key)).slice(0, 50)
    : [];
  const t3TypeErrors = Number.isInteger(report.t3TypeErrors) && (report.t3TypeErrors as number) >= 0 && (report.t3TypeErrors as number) < 100_000 ? (report.t3TypeErrors as number) : 0;
  const fingerprint = Array.isArray(report.upstreamFingerprint) ? report.upstreamFingerprint.flatMap((finding) => findingSummary(finding) ?? []).slice(0, 50) : [];
  return { unclassified, acceptanceRetried: report.acceptanceRetry !== undefined && report.acceptanceRetry !== null, t3TypeErrors, fingerprint };
};

const REPO_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const REGISTER_ENTRY = /^U\d{1,4}$/;
const REGION_SYMBOL = /^(?:\*|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/;

/**
 * One upstream fingerprint finding (`Finding`, from the untrusted report) in a line for a commit message or a pull
 * request: paths, a symbol and a register entry only, each checked for its shape, never upstream text; paths and the
 * symbol go in backticks, so a path-shaped name is not linked. Undefined when it is not shaped so.
 */
export const findingSummary = (finding: unknown): string | undefined => {
  if (typeof finding !== "object" || finding === null) return undefined;
  const { kind, file, symbol, ourFile, entry } = finding as Record<string, unknown>;
  if (typeof file !== "string" || !REPO_PATH.test(file)) return undefined;
  if (kind === "moved") return `\`t3code/${file}\` changed outside the watched regions (nothing of ours to review)`;
  if (typeof ourFile !== "string" || !REPO_PATH.test(ourFile) || typeof entry !== "string" || !REGISTER_ENTRY.test(entry)) return undefined;
  const what = kind === "missing" ? "a literal" : (kind === "changed" || kind === "gone") && typeof symbol === "string" && symbol.length <= 100 && REGION_SYMBOL.test(symbol) ? symbol : undefined;
  return what === undefined ? undefined : `review \`${ourFile}\` (${entry}) for \`t3code/${file}\` (${kind === "missing" ? what : `\`${what}\``})`;
};

/** What a person does with a bump the upstream fingerprint holds (ADR-0037's SPI-1011 refinement). */
export const HELD_BUMP_STEPS =
  `cut a branch of your own from it (git switch -c <name> origin/bump/<tag>, then git submodule update --init t3code; the hourly bump force-pushes bump/<tag>), ` +
  `review each of our files the findings name (${LIST_COMMAND} lists them), run ${UPDATE_COMMAND}, ` +
  `commit, open a pull request from your branch and merge it; then close the bump's own pull request, which yours supersedes`;

/**
 * Why a t3 pin may not land by itself for the upstream fingerprint (SPI-1011; ADR-0037's SPI-1011 refinement), or
 * undefined. `fixtureText` is main's fixture (a bump may not change it); `blobOf` gives the candidate's t3 file's git
 * blob id (`gitBlobOf`), undefined when gone. Without a parser on the trusted runner, the check is coarser than the test's: any byte of a watched file
 * that moved since the review holds the pin for a person, even outside the watched regions.
 */
export const upstreamFingerprintRefusal = (fixtureText: string, blobOf: (file: string) => string | undefined): string | undefined => {
  let fingerprint: Fingerprint;
  try {
    fingerprint = JSON.parse(fixtureText) as Fingerprint;
    if (!Array.isArray(fingerprint.regions) || !Array.isArray(fingerprint.literals) || typeof fingerprint.files !== "object" || fingerprint.files === null) throw new Error("shape");
  } catch {
    return "the upstream fingerprint's fixture was not read";
  }
  const files = watchedFiles(fingerprint);
  const unrecorded = files.filter((file) => typeof fingerprint.files[file] !== "string");
  if (unrecorded.length > 0) return `the upstream fingerprint's fixture does not record ${unrecorded.join(", ")}: run ${UPDATE_COMMAND}`;
  const moved = files.filter((file) => {
    const blob = blobOf(file);
    return blob === undefined || blob !== fingerprint.files[file];
  });
  if (moved.length === 0) return undefined;
  return (
    `t3 files the upstream fingerprint watches changed since its review at ${String(fingerprint.reviewedCommit).slice(0, 12)} (${moved.join(", ")}): ` +
    `this bump needs a person: ${HELD_BUMP_STEPS} (ADR-0037's SPI-1011 refinement)`
  );
};

/**
 * Why land.yml may not land `sha` from `branch` (review B1), or undefined: it lands only the exact commit a trusted job
 * proved, while the branch still points at it, and only when its proof counts (`proof`: the gate, or why not).
 */
export const landBindingRefusal = (input: {
  readonly branch: string;
  readonly sha: string | undefined;
  readonly tip: string | undefined;
  readonly proof: { readonly gate: "update" | "full" } | { readonly gate: undefined; readonly reason: string } | undefined;
}): string | undefined => {
  if (input.sha === undefined || !/^[0-9a-f]{40}$/.test(input.sha)) return `landing ${input.branch} needs the proven commit, not ${JSON.stringify(input.sha ?? "")}`;
  if (input.tip !== input.sha) return `${input.branch} is at ${input.tip ?? "nothing"}, not the proven ${input.sha}`;
  if (input.proof === undefined) return `${input.sha}'s proof was not read`;
  if (input.proof.gate === undefined) return input.proof.reason;
  return undefined;
};
