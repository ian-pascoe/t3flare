// The Harness panel's Environment skills API (SPI-1148, plan §5), under `/_t3flare/harness/api/skills`: the list, a view,
// and the owner's changes (preview, install, check, update, remove, enable). `panel.ts` routes here after its guards
// (Access, JSON, Origin, `Sec-Fetch-Site`, CSRF), so these answer only well-formed requests. A GitHub failure is a 502
// whose text is the failure's whole message; a request that runs out of time keeps nothing.
import { checkSkills, fetchSkills, type KeptForCheck, previewSkills, type RepoReader, type SkillRepo } from "./fetch.ts";
import { MAX_ENVIRONMENT_SKILLS, MAX_SET_BYTES } from "./checks.ts";
import { parseSkillSource } from "./source.ts";
import type { ReadAccess } from "./contents.ts";
import type { EnvironmentSkillRow, SkillStore } from "./store.ts";

/** How long one request may read GitHub for: the Environment DO also runs t3 (ADR-0004). */
export const REQUEST_BUDGET_MS = 60_000;

/** The most `(repo, ref)` groups one update check reads. */
export const MAX_CHECK_GROUPS = 40;

/** The preview's word on files other than `SKILL.md` (plan A8). */
export const OTHER_FILES_NOTE = "Other files are checked when the skill is installed.";

export interface SkillsApiDeps {
  readonly store: SkillStore;
  /** A reader of `repo` with the Environment's credential (`readAccessFor`), ending at `deadline`. */
  readonly reader: (repo: SkillRepo, deadline: number) => Promise<{ readonly reader: RepoReader; readonly how: ReadAccess["how"] }>;
  /** No installed repo is known: reads would be unauthenticated (shown on the page without minting, plan A9). */
  readonly unauthenticated: () => boolean;
  readonly caller: string;
  readonly now: () => number;
}

export type SkillsAnswer = { readonly status: number; readonly json: unknown } | { readonly status: number; readonly text: string };

const ok = (json: unknown): SkillsAnswer => ({ status: 200, json });
const refuse = (status: number, text: string): SkillsAnswer => ({ status, text });

const short = (commit: string) => commit.slice(0, 7);

/** A kept skill's GitHub URL for one of its files at its commit. */
export const fileUrl = (row: Pick<EnvironmentSkillRow, "repo" | "path" | "commit">, file: string): string =>
  `https://github.com/${row.repo}/blob/${row.commit}/${[...row.path.split("/").filter(Boolean), ...file.split("/")].map(encodeURIComponent).join("/")}`;

/** The kept skills and their totals against the set's limits, disabled ones apart (E3). */
export const skillsOverview = (deps: Pick<SkillsApiDeps, "store" | "unauthenticated">) => {
  const skills = deps.store.list();
  const enabled = skills.filter((skill) => skill.enabled);
  const bytes = skills.reduce((sum, skill) => sum + skill.bytes, 0);
  const disabledBytes = skills.filter((skill) => !skill.enabled).reduce((sum, skill) => sum + skill.bytes, 0);
  return {
    skills,
    totals: { count: skills.length, enabled: enabled.length, disabled: skills.length - enabled.length, bytes, disabledBytes, maxBytes: MAX_SET_BYTES, maxSkills: MAX_ENVIRONMENT_SKILLS },
    hash: deps.store.hash(),
    unauthenticated: deps.unauthenticated(),
    refusals: deps.store.refusals(),
  };
};

/** `GET …/skills/view?name=`: `SKILL.md` as text, the other files as path, size and GitHub URL at the commit. */
export const viewSkill = (deps: Pick<SkillsApiDeps, "store">, name: string): SkillsAnswer => {
  const row = deps.store.get(name);
  if (row === undefined) return refuse(404, `No Environment skill is named ${name}.`);
  return ok({
    skill: row,
    skillMd: deps.store.content(name, "SKILL.md") ?? "",
    files: deps.store.files(name).map((file) => ({ path: file.path, size: file.size, url: fileUrl(row, file.path) })),
  });
};

const stringField = (body: Record<string, unknown>, key: string): string | undefined => (typeof body[key] === "string" ? body[key] : undefined);

/** `POST …/skills/preview` `{ source }`: the candidates at the resolved commit, each with what it would replace. */
const preview = async (deps: SkillsApiDeps, body: Record<string, unknown>): Promise<SkillsAnswer> => {
  const parsed = parseSkillSource(stringField(body, "source") ?? "");
  if (!parsed.ok) return refuse(400, parsed.message);
  const { source } = parsed;
  const { reader, how } = await deps.reader({ owner: source.owner, name: source.name }, deps.now() + REQUEST_BUDGET_MS);
  const found = await previewSkills(reader, source);
  if (found.status === "failed") return refuse(502, found.message);
  return ok({
    ...found,
    how,
    note: OTHER_FILES_NOTE,
    skills: found.skills.map((skill) => {
      const kept = deps.store.get(skill.name);
      const same = kept !== undefined && kept.repo === source.repo && kept.path === skill.path && kept.ref === source.ref && kept.digest === skill.digest;
      return {
        ...skill,
        ...(kept === undefined ? {} : same ? { unchanged: true } : { replaces: { repo: kept.repo, path: kept.path, ref: kept.ref, commit: short(kept.commit) } }),
      };
    }),
  });
};

/** `POST …/skills/install` `{ source, commit, folders }`: the folders the owner picked, fetched again at the previewed commit. */
const install = async (deps: SkillsApiDeps, body: Record<string, unknown>): Promise<SkillsAnswer> => {
  const parsed = parseSkillSource(stringField(body, "source") ?? "");
  if (!parsed.ok) return refuse(400, parsed.message);
  const commit = stringField(body, "commit") ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return refuse(400, "commit is the 40-hex commit the preview answered");
  const folders = Array.isArray(body.folders) ? body.folders.filter((folder): folder is string => typeof folder === "string") : [];
  if (folders.length === 0) return refuse(400, "folders names at least one skill's folder from the preview");
  const { source } = parsed;
  const { reader } = await deps.reader({ owner: source.owner, name: source.name }, deps.now() + REQUEST_BUDGET_MS);
  const fetched = await fetchSkills(reader, { repo: { owner: source.owner, name: source.name }, commit, folders });
  if (fetched.status === "failed") return refuse(502, fetched.message);
  const results: Array<{ readonly name: string; readonly path: string; readonly action?: string; readonly error?: string }> = [];
  for (const skill of fetched.skills) {
    const answer = await deps.store.apply({ kind: "install", skill, source: { repo: source.repo, path: skill.path, ref: source.ref, commit } }, deps.caller, deps.now());
    results.push(answer.ok ? { name: skill.name, path: skill.path, action: answer.action } : { name: skill.name, path: skill.path, error: answer.error });
  }
  for (const refused of fetched.refused) results.push({ name: refused.path.split("/").at(-1) || source.name, path: refused.path, error: refused.message });
  return ok({ commit, results, hash: deps.store.hash() });
};

/** The kept skills' files' blob SHAs, as an update check compares them. */
const keptForCheck = (deps: SkillsApiDeps, row: EnvironmentSkillRow): KeptForCheck => ({
  name: row.name,
  path: row.path,
  digest: row.digest,
  files: Object.fromEntries(deps.store.files(row.name).map((file) => [file.path, file.blob])),
});

/** `POST …/skills/check` `{ names? }`: grouped by repo and ref, one commit and one tree per group, no file read. */
const check = async (deps: SkillsApiDeps, body: Record<string, unknown>): Promise<SkillsAnswer> => {
  const names = Array.isArray(body.names) ? new Set(body.names.filter((name): name is string => typeof name === "string")) : undefined;
  const rows = deps.store.list().filter((row) => names === undefined || names.has(row.name));
  const groups = new Map<string, Array<EnvironmentSkillRow>>();
  for (const row of rows) {
    const key = JSON.stringify([row.repo, row.ref]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const deadline = deps.now() + REQUEST_BUDGET_MS;
  const results: Array<Record<string, unknown>> = [];
  const keys = [...groups.keys()];
  for (const key of keys.slice(0, MAX_CHECK_GROUPS)) {
    const group = groups.get(key)!;
    const [owner = "", name = ""] = group[0]!.repo.split("/");
    const { reader } = await deps.reader({ owner, name }, deadline);
    const checked = await checkSkills(reader, { repo: { owner, name }, ref: group[0]!.ref, kept: group.map((row) => keptForCheck(deps, row)) });
    if (checked.status === "failed") {
      for (const row of group) results.push({ name: row.name, status: "failed", message: checked.message });
      continue;
    }
    for (const result of checked.results) {
      const row = group.find((each) => each.name === result.name)!;
      results.push({ ...result, from: short(row.commit), ...(result.status === "update" ? { commit: checked.commit, to: short(checked.commit) } : {}) });
    }
  }
  const skipped = keys.slice(MAX_CHECK_GROUPS).flatMap((key) => groups.get(key)!.map((row) => row.name));
  return ok({ results, ...(skipped.length === 0 ? {} : { note: `Checked the first ${MAX_CHECK_GROUPS} repositories and refs; check again for ${skipped.join(", ")}.` }) });
};

/** `POST …/skills/update` `{ name, commit }`: the kept skill's folder at that commit, under the same name. */
const update = async (deps: SkillsApiDeps, body: Record<string, unknown>): Promise<SkillsAnswer> => {
  const name = stringField(body, "name") ?? "";
  const commit = stringField(body, "commit") ?? "";
  const row = deps.store.get(name);
  if (row === undefined) return refuse(404, `No Environment skill is named ${name}.`);
  if (!/^[0-9a-f]{40}$/.test(commit)) return refuse(400, "commit is the 40-hex commit the check answered");
  const [owner = "", repoName = ""] = row.repo.split("/");
  const { reader } = await deps.reader({ owner, name: repoName }, deps.now() + REQUEST_BUDGET_MS);
  const fetched = await fetchSkills(reader, { repo: { owner, name: repoName }, commit, folders: [row.path] });
  if (fetched.status === "failed") return refuse(502, fetched.message);
  const [skill] = fetched.skills;
  if (skill === undefined) return refuse(422, `${name} was not updated, and is kept at ${short(row.commit)}: ${fetched.refused.map((refused) => refused.message).join("; ")}`);
  if (skill.name !== name) return refuse(422, `${name} was not updated: at ${short(commit)} its SKILL.md names it ${skill.name}. Install it under that name; removing ${name} is your choice.`);
  const before = new Map(deps.store.files(name).map((file) => [file.path, file.blob]));
  const after = new Map(Object.entries(skill.files).map(([path, file]) => [path, file.blob]));
  const answer = await deps.store.apply({ kind: "install", skill, source: { repo: row.repo, path: row.path, ref: row.ref, commit } }, deps.caller, deps.now());
  if (!answer.ok) return refuse(422, answer.error);
  return ok({
    name,
    action: answer.action,
    from: row.commit,
    to: commit,
    added: [...after.keys()].filter((path) => !before.has(path)).sort(),
    changed: [...after].filter(([path, blob]) => before.has(path) && before.get(path) !== blob).map(([path]) => path).sort(),
    removed: [...before.keys()].filter((path) => !after.has(path)).sort(),
    hash: answer.hash,
  });
};

/** `POST …/skills/remove` `{ name }` and `…/skills/enable` `{ name, enabled }`. */
const removeOrEnable = async (deps: SkillsApiDeps, body: Record<string, unknown>, op: "remove" | "enable"): Promise<SkillsAnswer> => {
  const name = stringField(body, "name") ?? "";
  if (op === "enable" && typeof body.enabled !== "boolean") return refuse(400, "the body is { name, enabled }");
  const answer = await deps.store.apply(op === "remove" ? { kind: "remove", name } : { kind: "enable", name, enabled: body.enabled === true }, deps.caller, deps.now());
  return answer.ok ? ok(answer) : refuse(404, `${answer.error}.`);
};

/** The write routes, by their path after `/api/skills`. */
export const SKILLS_WRITE_ROUTES = ["/preview", "/install", "/check", "/update", "/remove", "/enable"] as const;

/** A write route's answer to `body` (already through the panel's guards). */
export const skillsChange = (deps: SkillsApiDeps, route: (typeof SKILLS_WRITE_ROUTES)[number], body: Record<string, unknown>): Promise<SkillsAnswer> => {
  switch (route) {
    case "/preview":
      return preview(deps, body);
    case "/install":
      return install(deps, body);
    case "/check":
      return check(deps, body);
    case "/update":
      return update(deps, body);
    case "/remove":
      return removeOrEnable(deps, body, "remove");
    case "/enable":
      return removeOrEnable(deps, body, "enable");
  }
};
