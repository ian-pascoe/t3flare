// @effect-diagnostics globalConsole:off
// The Environment skills the Environment DO keeps (SPI-1148, ADR-0033): one row per Skill (its Skill source, commit,
// digest, switch), one row per file (its text, GitHub's blob SHA, its size and SHA-256), and the hash of the enabled
// set. Part of the Environment settings entity (ADR-0032): every change bumps that entity's revision and is audited with
// `entity: "environment"`, never with file content.
//
// A change is one synchronous block (`transactionSync`): the revision is checked unmoved, the limits are checked against
// the rows as they are, then the rows, the set's hash, the revision and the audit entry are written. The set's hash is
// made before it, from the files' SHA-256s (no content read), against the revision read then; a moved revision makes it
// again. So two installs cannot interleave.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { EMPTY_SKILL_SET_HASH, type SkillSet, skillSetHash } from "@t3flare/skills";

import type { AuditEntry, HarnessStore } from "../harness/store.ts";
import { setProblem } from "./checks.ts";
import type { FetchedSkill } from "./fetch.ts";

/** A kept Environment skill: its Skill source and how it was taken. */
export interface EnvironmentSkillRow {
  readonly name: string;
  readonly description: string;
  /** `owner/name`. */
  readonly repo: string;
  /** Its folder in the repo (`""` at the root). */
  readonly path: string;
  /** The ref named at install (a branch, tag or commit), or null for the default branch. */
  readonly ref: string | null;
  /** The commit it is pinned to. */
  readonly commit: string;
  /** cloudpid's folder hash: SHA-256 over the kept files' paths and blob SHAs. */
  readonly digest: string;
  readonly enabled: boolean;
  readonly disableModelInvocation: boolean;
  readonly savedAt: number;
  readonly bytes: number;
  readonly files: number;
}

/** One kept file, without its text. */
export interface EnvironmentSkillFile {
  readonly path: string;
  readonly blob: string;
  readonly size: number;
  readonly sha256: string;
}

/** Where a Skill was installed from: its repo, folder, the ref named and the commit it resolved to. */
export interface SkillSource {
  readonly repo: string;
  readonly path: string;
  readonly ref: string | null;
  readonly commit: string;
}

export type SkillChange =
  | { readonly kind: "install"; readonly skill: FetchedSkill; readonly source: SkillSource }
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "enable"; readonly name: string; readonly enabled: boolean };

export type ChangeAnswer =
  | { readonly ok: true; readonly action: "skill-install" | "skill-update" | "skill-remove" | "skill-enable" | "skill-disable" | "unchanged"; readonly revision: number; readonly hash: string }
  | { readonly ok: false; readonly error: string };

/** A Workspace that refused or could not mount a set (plan §4.5). */
export interface SkillSetRefusal {
  readonly workspace: string;
  readonly hash: string;
  readonly message: string;
  readonly at: number;
}

const REFUSALS_KEY = "t3flare:environment:skill-refusals";
const REFUSALS_KEPT = 50;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS t3flare_env_skills (
    name TEXT PRIMARY KEY, description TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, ref TEXT, commit_sha TEXT NOT NULL,
    digest TEXT NOT NULL, enabled INTEGER NOT NULL, disable_model_invocation INTEGER NOT NULL, saved_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL, files INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS t3flare_env_skill_files (
    name TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL,
    PRIMARY KEY (name, path))`,
  `CREATE TABLE IF NOT EXISTS t3flare_env_skill_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** A SQL value as text (every text column holds text; a number is printed). */
const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

/** What an audit entry says of a Skill: its source and switch, never its files. */
const auditView = (row: EnvironmentSkillRow | undefined) =>
  row === undefined ? null : { repo: row.repo, path: row.path, ref: row.ref, commit: row.commit, digest: row.digest, enabled: row.enabled };

export interface SkillStoreOptions {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
  /** The Environment settings' revision and the audit log (ADR-0032). */
  readonly harness: HarnessStore;
  readonly kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
}

export type SkillStore = ReturnType<typeof skillStore>;

export const skillStore = (options: SkillStoreOptions) => {
  const { sql, harness } = options;
  for (const statement of SCHEMA) sql.exec(statement);

  const rowOf = (row: Record<string, unknown>): EnvironmentSkillRow => ({
    name: str(row.name),
    description: str(row.description),
    repo: str(row.repo),
    path: str(row.path),
    ref: row.ref === null ? null : str(row.ref),
    commit: str(row.commit_sha),
    digest: str(row.digest),
    enabled: Number(row.enabled) === 1,
    disableModelInvocation: Number(row.disable_model_invocation) === 1,
    savedAt: Number(row.saved_at),
    bytes: Number(row.bytes),
    files: Number(row.files),
  });

  const list = (): ReadonlyArray<EnvironmentSkillRow> => sql.exec("SELECT * FROM t3flare_env_skills ORDER BY name").toArray().map(rowOf);
  const get = (name: string): EnvironmentSkillRow | undefined => {
    const [row] = sql.exec("SELECT * FROM t3flare_env_skills WHERE name = ?", name).toArray();
    return row === undefined ? undefined : rowOf(row);
  };
  const filesOf = (name: string): ReadonlyArray<EnvironmentSkillFile> =>
    sql
      .exec("SELECT path, blob, size, sha256 FROM t3flare_env_skill_files WHERE name = ? ORDER BY path", name)
      .toArray()
      .map((row) => ({ path: str(row.path), blob: str(row.blob), size: Number(row.size), sha256: str(row.sha256) }));
  const content = (name: string, path: string): string | undefined => {
    const [row] = sql.exec("SELECT content FROM t3flare_env_skill_files WHERE name = ? AND path = ?", name, path).toArray();
    return row === undefined ? undefined : str(row.content);
  };
  const hash = (): string => {
    const [row] = sql.exec("SELECT value FROM t3flare_env_skill_meta WHERE key = 'hash'").toArray();
    return row === undefined ? EMPTY_SKILL_SET_HASH : str(row.value);
  };

  /** The enabled skills' files' SHA-256s by their path under the mount, with `change` applied: what the set's hash is made of. */
  const digestsAfter = (change: SkillChange): Record<string, string> => {
    const enabled = new Map(list().map((row) => [row.name, row.enabled]));
    if (change.kind === "install") enabled.set(change.skill.name, enabled.get(change.skill.name) ?? true);
    if (change.kind === "remove") enabled.delete(change.name);
    if (change.kind === "enable") enabled.set(change.name, change.enabled);
    const digests: Record<string, string> = {};
    for (const row of sql.exec("SELECT name, path, sha256 FROM t3flare_env_skill_files").toArray()) {
      const name = str(row.name);
      if (change.kind === "install" && name === change.skill.name) continue;
      if (enabled.get(name) === true) digests[`${name}/${str(row.path)}`] = str(row.sha256);
    }
    if (change.kind === "install" && enabled.get(change.skill.name) === true) {
      for (const [path, file] of Object.entries(change.skill.files)) digests[`${change.skill.name}/${path}`] = file.sha256;
    }
    return digests;
  };

  /** Writes `change` with the set's hash `next`, bumping the revision and auditing; inside `transactionSync`. */
  const write = (change: SkillChange, next: string, caller: string, at: number): ChangeAnswer => {
    const before = change.kind === "install" ? get(change.skill.name) : get(change.name);
    let action: Extract<ChangeAnswer, { ok: true }>["action"];
    if (change.kind === "install") {
      const { skill, source } = change;
      if (before !== undefined && before.digest === skill.digest && before.repo === source.repo && before.path === source.path && before.ref === source.ref) {
        return { ok: true, action: "unchanged", revision: harness.loadEnvironment().revision, hash: hash() };
      }
      const problem = setProblem(
        list().map((row) => ({ name: row.name, bytes: row.bytes })),
        [{ name: skill.name, bytes: skill.bytes }],
      );
      if (problem !== undefined) return { ok: false, error: `${skill.name} was not kept: ${problem}` };
      sql.exec("DELETE FROM t3flare_env_skill_files WHERE name = ?", skill.name);
      sql.exec(
        `INSERT INTO t3flare_env_skills (name, description, repo, path, ref, commit_sha, digest, enabled, disable_model_invocation, saved_at, bytes, files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, repo = excluded.repo, path = excluded.path, ref = excluded.ref,
           commit_sha = excluded.commit_sha, digest = excluded.digest, disable_model_invocation = excluded.disable_model_invocation,
           saved_at = excluded.saved_at, bytes = excluded.bytes, files = excluded.files`,
        skill.name,
        skill.description,
        source.repo,
        source.path,
        source.ref,
        source.commit,
        skill.digest,
        1,
        skill.disableModelInvocation ? 1 : 0,
        at,
        skill.bytes,
        Object.keys(skill.files).length,
      );
      for (const [path, file] of Object.entries(skill.files)) {
        sql.exec("INSERT INTO t3flare_env_skill_files (name, path, blob, size, sha256, content) VALUES (?, ?, ?, ?, ?, ?)", skill.name, path, file.blob, file.size, file.sha256, file.text);
      }
      action = before === undefined ? "skill-install" : "skill-update";
    } else if (change.kind === "remove") {
      if (before === undefined) return { ok: false, error: `no Environment skill is named ${change.name}` };
      sql.exec("DELETE FROM t3flare_env_skill_files WHERE name = ?", change.name);
      sql.exec("DELETE FROM t3flare_env_skills WHERE name = ?", change.name);
      action = "skill-remove";
    } else {
      if (before === undefined) return { ok: false, error: `no Environment skill is named ${change.name}` };
      if (before.enabled === change.enabled) return { ok: true, action: "unchanged", revision: harness.loadEnvironment().revision, hash: hash() };
      sql.exec("UPDATE t3flare_env_skills SET enabled = ? WHERE name = ?", change.enabled ? 1 : 0, change.name);
      action = change.enabled ? "skill-enable" : "skill-disable";
    }
    sql.exec("INSERT INTO t3flare_env_skill_meta (key, value) VALUES ('hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", next);
    const environment = harness.loadEnvironment();
    const revision = environment.revision + 1;
    harness.saveEnvironment({ ...environment, revision });
    const name = change.kind === "install" ? change.skill.name : change.name;
    const entry: AuditEntry = { entity: "environment", at, caller, action, target: name, before: auditView(before), after: auditView(get(name)) };
    harness.audit(entry);
    return { ok: true, action, revision, hash: next };
  };

  return {
    list,
    get,
    files: filesOf,
    content,
    /** The enabled set's hash: what a turn carries (plan §4.2). */
    hash,
    /** The enabled set with every file's text, keyed `<name>/<path>`: what a Workspace takes. */
    set: (): SkillSet => {
      const files: Record<string, string> = {};
      for (const row of sql
        .exec("SELECT f.name AS name, f.path AS path, f.content AS content FROM t3flare_env_skill_files f JOIN t3flare_env_skills s ON s.name = f.name WHERE s.enabled = 1")
        .toArray()) {
        files[`${str(row.name)}/${str(row.path)}`] = str(row.content);
      }
      return { hash: hash(), files };
    },
    /** Applies `change` as one synchronous block (see the header), trying again once when the revision moved. */
    apply: async (change: SkillChange, caller: string, at: number): Promise<ChangeAnswer> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = harness.loadEnvironment().revision;
        const next = await skillSetHash({}, digestsAfter(change));
        const answer = options.transactionSync(() => (harness.loadEnvironment().revision === revision ? write(change, next, caller, at) : undefined));
        if (answer !== undefined) return answer;
      }
      return { ok: false, error: "the Environment settings kept changing while this change was made; try again" };
    },
    /** A Workspace that refused or could not mount the set `hash` (plan §4.5): kept until it takes one. */
    noteRefusal: (refusal: SkillSetRefusal): void => {
      const kept = (options.kv.get<Array<SkillSetRefusal>>(REFUSALS_KEY) ?? []).filter((entry) => entry.workspace !== refusal.workspace);
      options.kv.put(REFUSALS_KEY, [...kept, refusal].slice(-REFUSALS_KEPT));
      console.log(JSON.stringify({ t3flare: "skill-set-refused", workspace: refusal.workspace, hash: refusal.hash.slice(0, 12), message: refusal.message.slice(0, 300) }));
    },
    /** A Workspace read the set: its refusal, if any, is dropped (it reports again if it refuses this one). */
    noteTaken: (workspace: string): void => {
      const kept = options.kv.get<Array<SkillSetRefusal>>(REFUSALS_KEY) ?? [];
      if (kept.some((entry) => entry.workspace === workspace)) options.kv.put(REFUSALS_KEY, kept.filter((entry) => entry.workspace !== workspace));
    },
    refusals: (): ReadonlyArray<SkillSetRefusal> => options.kv.get<Array<SkillSetRefusal>>(REFUSALS_KEY) ?? [],
  };
};
