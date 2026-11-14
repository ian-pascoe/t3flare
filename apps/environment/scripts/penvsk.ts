// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1148's stage evidence (stage `penvsk`): Environment skills installed on the Harness panel's API, delivered to a
// Workspace and its Container, and used by a Durable agent, through t3's own calls as the web client makes them. Run
// through the stage's `run`, which sets the stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run penvsk penvsk fixture      push the fixture repo's branches spi1148-env and spi1148-refusals
//   node scripts/stage.ts run penvsk penvsk public       mattpocock/skills at a pinned commit (env-install-public.json)
//   node scripts/stage.ts run penvsk penvsk private      a folder of the private fixture repo outside any root (env-install-private.json)
//   node scripts/stage.ts run penvsk penvsk precedence   the Repo fruit-code against the Environment's (env-precedence.json)
//   node scripts/stage.ts run penvsk penvsk update       check and update while the Container runs; the wait's shape (env-update.json)
//   node scripts/stage.ts run penvsk penvsk nocontainer  an install, then a turn that reads it; no Container (env-no-container.json)
//   node scripts/stage.ts run penvsk penvsk readonly     writes under the mount refused, the agent's included (env-readonly.json)
//   node scripts/stage.ts run penvsk penvsk remove       gone from the snapshot, the mount and the Container (env-remove.json)
//   node scripts/stage.ts run penvsk penvsk refusals     what an install refuses (env-refusals.json)
//   node scripts/stage.ts run penvsk penvsk shoot        the panel's Skills section (skills-<desktop|phone>-<light|dark>.png)
//
// M0's probes (env-probe.json at f64889a, env-sync.json at 1fdd389) ran through a temporary admin route, removed in M2;
// see this file's history at those commits. Evidence goes to docs/steps/spi-1001/, tokens and cookies redacted; each
// file names the deployed commit.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_PENVSK_MODEL ?? "anthropic/claude-sonnet-5-5";
const DURABLE = { instanceId: "piDurable", model: SLUG, options: [] };
const T3 = process.env.T3_URL ?? "";
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1001");
const REPO_FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/skills");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);
const PROJECT = "penvsk-proj";
const MOUNT = "/workspace/.agents/skills";
const FIXTURE_REPO = "ian-pascoe/t3flare-fixture";
const ENV_BRANCH = "spi1148-env";
const REFUSALS_BRANCH = "spi1148-refusals";

const SECRET_KEYS = /token|authorization|cookie|secret|bearer|credential|csrf/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  return value;
};

const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(redact({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), model: SLUG, ...value }), null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1001/${name} (ok: ${String(value.ok)})`);
};

/** The panel's JSON API as a script calls it: the service token and the admin token. */
const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(`/_t3flare/harness/api/${pathname}`, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...scriptHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as any };
  } catch {
    return { status: response.status, json: text.trim() as any };
  }
};

/** One Workspace call through the admin route (`workspace-call`), its answer and the Container's state after. */
const call = async (body: unknown, id = PROJECT) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${id}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...(JSON.parse(text) as { result: any; container: any }) };
  } catch {
    return { status: response.status, result: text.slice(0, 500), container: undefined };
  }
};
const sh = async (script: string) => {
  const answer = await call({ exec: { script, timeoutMs: 180_000 } });
  return { exitCode: answer.result?.exitCode, stdout: String(answer.result?.stdout ?? "").slice(0, 3000), stderr: String(answer.result?.stderr ?? "").slice(0, 1000), running: answer.container?.running };
};
const containerOf = async () => {
  const row = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((each) => each.id === PROJECT);
  return { running: row?.container?.running ?? null, startedAt: row?.container?.startedAt ?? null };
};
const stopContainer = async () => {
  const started = Date.now();
  // Asked again while it runs: a command that was still finishing can hold the first stop off.
  while (Date.now() - started < 240_000) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${PROJECT}`);
    if ((await containerOf()).running === false) return;
    await sleep(5000);
  }
  throw new Error("the Container did not stop");
};

let cookie = "";
let projectId = "";
const root = `/w/${PROJECT}`;
const ready = async () => {
  cookie ||= await pair();
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  projectId ||= (await ensureProject(cookie, PROJECT)).projectId;
};

/** The composer's snapshot of the project for Pi Durable, fresh (past t3's TTL), as the client asks for it. */
const composerSnapshot = async () => {
  const reply = (await wsCall(cookie, "server.refreshProviders", { instanceId: "piDurable", cwd: root, fresh: true }).catch((error: unknown) => ({ error: String(error).slice(0, 400) }))) as any;
  const provider = (reply?.providers ?? []).find((candidate: any) => candidate.instanceId === "piDurable");
  const scoped = (provider?.workspaceSnapshots ?? []).find((snapshot: any) => snapshot.cwd === root) ?? provider?.workspaceSnapshots?.[0];
  return { error: reply?.error ?? null, skills: (scoped?.skills ?? []) as Array<any> };
};

const settle = async (threadId: string, ordinal: number, timeoutMs = 6 * 60_000): Promise<any> => {
  const started = Date.now();
  let current: any;
  while (Date.now() - started < timeoutMs) {
    current = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (current?.runtimeRequests ?? []).filter((r: any) => r.status === "pending")) {
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(current);
    if (runs.some((run: any) => run.ordinal >= ordinal) && runs.every((run) => SETTLED.has(run.status))) return current;
    await sleep(1000);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run) => run.status))}`);
};

const newThread = async (title: string) => {
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: DURABLE, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return { threadId, ordinal: 0 };
};

/** One turn: what t3 kept as the owner's message, the agent's answer, and its tool items as text. */
const turn = async (thread: { threadId: string; ordinal: number }, text: string) => {
  thread.ordinal += 1;
  await sendMessage(cookie, thread.threadId, text, DURABLE);
  const view = await settle(thread.threadId, thread.ordinal);
  const run = runsOf(view).find((candidate: any) => candidate.ordinal === thread.ordinal) as any;
  const items = itemsOf(view).filter((item: any) => item.runId === run?.id);
  const IDS = new Set(["id", "threadId", "runId", "nodeId", "providerThreadId", "providerTurnId", "createdAt", "updatedAt", "startedAt", "completedAt"]);
  return {
    sent: text,
    status: run?.status ?? null,
    typed: items.find((item: any) => item.type === "user_message")?.text ?? null,
    answer: String(items.filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "").slice(0, 800),
    tools: items
      .filter((item: any) => !["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type))
      .map((item: any) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !IDS.has(key)))).slice(0, 1200)),
  };
};

const sha256 = (text: string) => spawnSync("shasum", ["-a", "256"], { input: text, encoding: "utf8" }).stdout.split(" ")[0]!;

// ── The fixture repo's branches ─────────────────────────────────────────────────────────────────────────────────────

const git = (cwd: string, ...args: Array<string>) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout.trim();
};

const SKILL_MD = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** The Environment's fruit-code: PLUM-9, its notes file in the given version. */
const envFiles = (notes: string): Record<string, string> => ({
  "tools/plum/fruit-code/SKILL.md": SKILL_MD("fruit-code", "The fruit code, as the Environment keeps it.", "The fruit code is PLUM-9. The notes are in notes.md beside this file."),
  "tools/plum/fruit-code/notes.md": notes,
  "README.md": "SPI-1148's Environment skills fixture branch; moved by apps/environment/scripts/penvsk.ts.\n",
});

/** A new commit of `branch` holding exactly `files` (an orphan history, pushed with force). */
const pushBranch = (branch: string, files: Record<string, string | { link: string }>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penvsk-"));
  const remote = spawnSync("gh", ["repo", "clone", FIXTURE_REPO, dir, "--", "--depth", "1", "--quiet"], { encoding: "utf8" });
  if (remote.status !== 0) throw new Error(`gh repo clone failed: ${remote.stderr.slice(0, 300)}`);
  git(dir, "checkout", "--orphan", branch);
  git(dir, "rm", "-rf", "--quiet", ".");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    if (typeof content === "string") fs.writeFileSync(path.join(dir, file), content);
    else fs.symlinkSync(content.link, path.join(dir, file));
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t3flare stage", "-c", "user.email=stage@t3flare.invalid", "commit", "--quiet", "-m", `penvsk: ${branch}`);
  git(dir, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`);
  const commit = git(dir, "rev-parse", "HEAD");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`pushed ${branch} at ${commit.slice(0, 7)}`);
  return commit;
};

const refusalFiles = (): Record<string, string | { link: string }> => {
  const files: Record<string, string | { link: string }> = {
    "skills/leaky/SKILL.md": SKILL_MD("leaky", "A skill with a credential-looking file.", "See env.md."),
    "skills/leaky/env.md": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
    "skills/linked/SKILL.md": SKILL_MD("linked", "A skill with a link in it.", "Run run.sh."),
    "skills/linked/run.sh": { link: "../../README.md" },
    "skills/big/SKILL.md": SKILL_MD("big", "A skill over 4 MiB.", "Read the data."),
    "skills/badpath/SKILL.md": SKILL_MD("badpath", "A skill with a path a Workspace refuses.", "See the notes."),
    "skills/badpath/notes\\windows.md": "a backslash in a file name\n",
    "README.md": "SPI-1148's refusals fixture branch; moved by apps/environment/scripts/penvsk.ts.\n",
  };
  for (const part of ["a", "b", "c"]) files[`skills/big/data-${part}.txt`] = `${part}`.repeat(1_500_000);
  for (const many of ["many-a", "many-b"]) {
    files[`skills/${many}/SKILL.md`] = SKILL_MD(many, "A skill of many files.", "Many files.");
    for (let index = 0; index < 300; index++) files[`skills/${many}/f/${index}.md`] = `${many} ${index}\n`;
  }
  return files;
};

const fixture = () => {
  pushBranch(ENV_BRANCH, envFiles("NOTE-A\n"));
  pushBranch(REFUSALS_BRANCH, refusalFiles());
};

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Installs what `source` previews (every folder without a problem, or those `pick` keeps), at the previewed commit. */
const install = async (source: string, pick: (skill: any) => boolean = () => true) => {
  const preview = await harness("POST", "skills/preview", { source });
  if (preview.status !== 200) return { preview, installed: undefined };
  const folders = (preview.json.skills as Array<any>).filter((skill) => skill.problems.length === 0 && skill.unchanged !== true && pick(skill)).map((skill) => skill.path);
  const installed = await harness("POST", "skills/install", { source, commit: preview.json.commit, folders });
  return { preview, installed };
};

const brief = (preview: any) =>
  preview?.json?.skills === undefined
    ? preview
    : { status: preview.status, commit: preview.json.commit, how: preview.json.how, note: preview.json.note, skills: preview.json.skills.map(({ name, path: folder, files, problems, replaces, unchanged }: any) => ({ name, path: folder, files, problems, replaces, unchanged })) };

/** The Repo skills' fixture (SPI-1147's: fruit-code says KIWI-7), written uncommitted into the project. */
const writeRepoFixture = async () => {
  const walk = (dir: string): Array<string> => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  for (const full of walk(REPO_FIXTURE)) await wsCall(cookie, "projects.writeFile", { cwd: root, relativePath: path.relative(REPO_FIXTURE, full), contents: fs.readFileSync(full, "utf8") });
};

const removeAll = async () => {
  for (const skill of (await harness("GET", "skills")).json.skills as Array<any>) await harness("POST", "skills/remove", { name: skill.name });
};

const publicInstall = async () => {
  await ready();
  await removeAll();
  const preview = await harness("POST", "skills/preview", { source: "mattpocock/skills" });
  const chosen = (preview.json.skills as Array<any>).find((skill) => skill.name === "grill-me" && skill.problems.length === 0) ?? (preview.json.skills as Array<any>).find((skill) => skill.problems.length === 0);
  const installed = await harness("POST", "skills/install", { source: "mattpocock/skills", commit: preview.json.commit, folders: [chosen.path] });
  const name = chosen.name as string;
  const row = ((await harness("GET", "skills")).json.skills as Array<any>).find((skill) => skill.name === name);
  const snapshot = await composerSnapshot();
  const entry = snapshot.skills.find((skill: any) => skill.name === name);
  const thread = await newThread("spi-1148: public");
  const mention = await turn(thread, `$${name} Do not follow the skill now. Reply with only the value of the location attribute of the skill block in this message.`);
  const listing = (await call({ skills: "/workspace/repo" })).result;
  const listed = (listing?.skills ?? []).find((skill: any) => skill.name === name);
  const chip = await wsCall(cookie, "projects.readFile", { cwd: root, relativePath: entry?.path ?? "" }).then(
    (answer: any) => ({ ok: true, answer: { relativePath: answer?.relativePath, starts: String(answer?.contents ?? "").slice(0, 80) } }),
    (error: unknown) => ({ ok: false, error: String(error).slice(0, 400) }),
  );
  const location = `${MOUNT}/${name}/SKILL.md`;
  const checks = {
    pinned: installed.status === 200 && row?.commit === preview.json.commit && row?.repo === "mattpocock/skills",
    snapshotAtMount: entry?.path === location && entry?.scope === "user",
    listingAtMount: listed?.filePath === location,
    mentionExpanded: mention.typed === `$${name} Do not follow the skill now. Reply with only the value of the location attribute of the skill block in this message.` && mention.answer.includes(location),
  };
  await writeEvidence("env-install-public.json", {
    ok: Object.values(checks).every(Boolean),
    checks,
    preview: { ...brief(preview), skills: undefined, count: preview.json.skills.length, chosen: { name, path: chosen.path, files: chosen.files, problems: chosen.problems } },
    installed: installed.json,
    row,
    snapshotEntry: entry,
    modelListing: listed,
    mention,
    chipViewInstructions: { note: "t3's chip opens skill.path in its file panel, which reads it with projects.readFile in the project's cwd", ...chip },
  });
};

const privateInstall = async () => {
  await ready();
  await removeAll();
  const commit = pushBranch(ENV_BRANCH, envFiles("NOTE-A\n"));
  const source = `https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`;
  const { preview, installed } = await install(source);
  const row = ((await harness("GET", "skills")).json.skills as Array<any>).find((skill) => skill.name === "fruit-code");
  // The branch moves on; the install stays at the commit it was made at.
  const moved = pushBranch(ENV_BRANCH, envFiles("NOTE-BB-LONGER\n"));
  const after = ((await harness("GET", "skills")).json.skills as Array<any>).find((skill) => skill.name === "fruit-code");
  const view = await harness("GET", "skills/view?name=fruit-code");
  const checks = {
    readPrivately: preview.status === 200 && preview.json.how === "repo",
    outsideAnyRoot: row?.path === "tools/plum/fruit-code",
    pinned: row?.commit === commit && after?.commit === commit && moved !== commit,
    view: String(view.json?.skillMd ?? "").includes("PLUM-9") && (view.json?.files ?? []).some((file: any) => String(file.url).startsWith(`https://github.com/${FIXTURE_REPO}/blob/${commit}/tools/plum/fruit-code/`)),
  };
  await writeEvidence("env-install-private.json", { ok: Object.values(checks).every(Boolean), checks, source, branchCommit: commit, branchMovedTo: moved, preview: brief(preview), installed: installed?.json, row, view: view.json });
};

const precedence = async () => {
  await ready();
  await writeRepoFixture();
  if (((await harness("GET", "skills")).json.skills as Array<any>).every((skill) => skill.name !== "fruit-code")) await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  const take = (await call({ takeSkills: true })).result;
  const discovery = (await call({ skills: "/workspace/repo" })).result;
  const snapshot = await composerSnapshot();
  const thread = await newThread("spi-1148: precedence");
  const answer = await turn(thread, "$fruit-code What is the fruit code? Reply with the code alone.");
  const shadowed = (discovery?.skipped ?? []).find((skip: any) => String(skip.path).endsWith("/.agents/skills/fruit-code/SKILL.md") && String(skip.path).startsWith("/workspace/repo"));
  const checks = {
    answersPlum: answer.answer.includes("PLUM-9") && !answer.answer.includes("KIWI-7"),
    skippedNamesRepo: shadowed !== undefined && String(shadowed.reason).includes("shadowed by /workspace/.agents/skills/fruit-code/SKILL.md"),
    snapshotEnvironment: snapshot.skills.filter((skill: any) => skill.name === "fruit-code").map((skill: any) => skill.scope).join() === "user",
  };
  await writeEvidence("env-precedence.json", { ok: Object.values(checks).every(Boolean), checks, take, discovery: { skills: (discovery?.skills ?? []).map((skill: any) => skill.filePath), skipped: discovery?.skipped }, snapshot: snapshot.skills, turn: answer });
};

const update = async () => {
  await ready();
  if (((await harness("GET", "skills")).json.skills as Array<any>).every((skill) => skill.name !== "fruit-code")) await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  // The Workspace holds the set now, and its Container runs and has read the notes (any cache warm).
  await call({ takeSkills: true });
  const warm = await sh(`cat ${MOUNT}/fruit-code/notes.md; sha256sum ${MOUNT}/fruit-code/notes.md`);
  const edits: Array<Record<string, unknown>> = [];
  const thread = await newThread("spi-1148: update");
  for (const [kind, notes] of [["size-changing", `NOTE-SIZE-${Date.now().toString(36)}-CHANGED-LONGER\n`], ["same-size", ""]] as const) {
    const before = (await harness("GET", "skills/view?name=fruit-code")).json;
    const old = await sh(`cat ${MOUNT}/fruit-code/notes.md`);
    // Same size: the notes' text with each letter swapped for another, the length kept.
    const text = kind === "same-size" ? old.stdout.replace(/[A-Z]/g, (letter) => (letter === "Q" ? "R" : "Q")) : notes;
    const pushed = pushBranch(ENV_BRANCH, envFiles(text));
    const check = await harness("POST", "skills/check", { names: ["fruit-code"] });
    const result = (check.json.results as Array<any>)[0];
    const updated = await harness("POST", "skills/update", { name: "fruit-code", commit: result.commit });
    const running = await containerOf();
    // The wait's shape, on the stage (C1): the take with its looks while the Container runs.
    const take = await call({ takeSkills: true });
    const read = await turn(thread, `Run exactly this command with bash and reply with its output only: sha256sum ${MOUNT}/fruit-code/notes.md && cat ${MOUNT}/fruit-code/notes.md`);
    edits.push({
      kind,
      fromCommit: before.skill.commit,
      pushed,
      check: result,
      update: updated.json,
      containerRunningAtTake: running.running,
      take: take.result,
      turn: read,
      expectedSha256: sha256(text),
      ok: result.status === "update" && result.changed.includes("notes.md") && updated.status === 200 && read.answer.includes(sha256(text)) && take.result?.container?.caughtUp === true,
    });
  }
  await writeEvidence("env-update.json", { ok: edits.every((edit) => edit.ok === true), warm, edits });
};

const noContainer = async () => {
  await ready();
  await removeAll();
  await stopContainer();
  const before = await containerOf();
  await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  const thread = await newThread("spi-1148: no Container");
  const answer = await turn(thread, `Read ${MOUNT}/fruit-code/notes.md with your read tool (no shell command) and reply with its first line only.`);
  const after = await containerOf();
  const notes = (await harness("GET", "skills/view?name=fruit-code")).json;
  const checks = { stoppedBefore: before.running === false, stoppedAfter: after.running === false, readTheSkill: answer.tools.some((tool) => tool.includes("notes.md")) && answer.status === "completed" };
  await writeEvidence("env-no-container.json", { ok: Object.values(checks).every(Boolean), checks, before, after, turn: answer, installedCommit: notes.skill?.commit });
};

const readonly = async () => {
  await ready();
  if (((await harness("GET", "skills")).json.skills as Array<any>).every((skill) => skill.name !== "fruit-code")) await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  const thread = await newThread("spi-1148: read-only");
  const writeTool = await turn(thread, `With your write tool (not bash), write the text x to ${MOUNT}/fruit-code/planted.md. Report the tool's result in one line.`);
  await stopContainer();
  const before = await containerOf();
  const bashFirst = await turn(thread, `Run exactly this one bash command and reply with its output only: echo x > ${MOUNT}/fruit-code/planted.txt; echo "exit=$?"; grep ' ${MOUNT} ' /proc/self/mountinfo`);
  const after = await containerOf();
  const running = await sh(`echo y > ${MOUNT}/fruit-code/also.txt; echo "exit=$?"; ls ${MOUNT}/fruit-code`);
  const workspaceView = await call({ fs: { op: "stat", path: `${MOUNT}/fruit-code/planted.md` } });
  const checks = {
    writeToolRefused: writeTool.tools.some((tool) => /read-only|EROFS|EIO|cannot modify/i.test(tool)) && writeTool.tools.every((tool) => !/"ok":true/.test(tool) || !tool.includes("planted.md")),
    freshFirstCommand: before.running === false && after.running === true,
    // t3 keeps a command's output out of its item (`outputOmitted`); the agent's answer is the output, as asked.
    agentBashRefused: [...bashFirst.tools, bashFirst.answer].some((text) => text.includes("Read-only file system")) && bashFirst.answer.includes("exit=1"),
    runningRefused: running.stdout.includes("exit=2") || running.stdout.includes("exit=1"),
    nothingPlanted: !running.stdout.includes("planted") && !running.stdout.includes("also.txt"),
  };
  await writeEvidence("env-readonly.json", { ok: Object.values(checks).every(Boolean), checks, writeTool, containerBefore: before, bashFirst, containerAfter: after, running, workspaceView: workspaceView.result });
};

const remove = async () => {
  await ready();
  await writeRepoFixture();
  if (((await harness("GET", "skills")).json.skills as Array<any>).every((skill) => skill.name !== "fruit-code")) await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  const thread = await newThread("spi-1148: remove");
  await turn(thread, "Reply with OK.");
  await sh("true");
  const removed = await harness("POST", "skills/remove", { name: "fruit-code" });
  const snapshot = await composerSnapshot();
  const answer = await turn(thread, "$fruit-code What is the fruit code? Reply with the code alone.");
  const mount = await call({ fs: { op: "stat", path: `${MOUNT}/fruit-code/SKILL.md` } });
  const container = await sh(`ls ${MOUNT}/fruit-code 2>&1; echo "exit=$?"`);
  const unknown = await turn(thread, "Reply with exactly the text after the colon, unchanged: $plum-gone");
  const fruit = snapshot.skills.find((skill: any) => skill.name === "fruit-code");
  const checks = {
    removed: removed.status === 200,
    repoBackInSnapshot: fruit?.scope === "project",
    goneFromMount: JSON.stringify(mount.result).includes("ENOENT"),
    goneFromContainer: container.stdout.includes("No such file"),
    repoAnswers: answer.answer.includes("KIWI-7"),
    unknownUntouched: unknown.answer.includes("$plum-gone"),
  };
  await writeEvidence("env-remove.json", { ok: Object.values(checks).every(Boolean), checks, removed: removed.json, snapshot: snapshot.skills, turn: answer, mount: mount.result, container, unknown });
};

const refusals = async () => {
  await ready();
  pushBranch(REFUSALS_BRANCH, refusalFiles());
  const cases: Record<string, unknown> = {};
  cases.notInstalledOwner = await harness("POST", "skills/preview", { source: "octocat/private-skills-nope" });
  cases.notInTheInstallation = await harness("POST", "skills/preview", { source: "ian-pascoe/no-such-private-repo" });
  const preview = await harness("POST", "skills/preview", { source: `https://github.com/${FIXTURE_REPO}/tree/${REFUSALS_BRANCH}` });
  cases.preview = brief(preview);
  const folderOf = (name: string) => (preview.json.skills as Array<any>).find((skill) => skill.name === name)?.path;
  cases.installLeaky = await harness("POST", "skills/install", { source: `https://github.com/${FIXTURE_REPO}/tree/${REFUSALS_BRANCH}`, commit: preview.json.commit, folders: [folderOf("leaky")] });
  cases.installOverBlobCap = await harness("POST", "skills/install", { source: `https://github.com/${FIXTURE_REPO}/tree/${REFUSALS_BRANCH}`, commit: preview.json.commit, folders: [folderOf("many-a"), folderOf("many-b")] });
  const problems = Object.fromEntries((preview.json.skills as Array<any>).map((skill) => [skill.name, skill.problems]));
  const checks = {
    notInstalledOwner: (cases.notInstalledOwner as any).status === 502 && String((cases.notInstalledOwner as any).json).includes("it is private and the GitHub App is not installed on octocat (install it there, on all repositories)."),
    notInTheInstallation: (cases.notInTheInstallation as any).status === 502 && String((cases.notInTheInstallation as any).json).includes("does not include it (install it on all repositories)."),
    credential: JSON.stringify((cases.installLeaky as any).json).includes("env.md: matches"),
    symlink: String(problems.linked).includes("run.sh: a link or a submodule"),
    oversize: String(problems.big).includes("more than the 4194304 a Skill may be"),
    badPath: String(problems.badpath).includes("backslash"),
    blobCap: (cases.installOverBlobCap as any).status === 422 && String((cases.installOverBlobCap as any).json).includes("install at most 500 files at a time"),
    nothingKept: ((await harness("GET", "skills")).json.skills as Array<any>).every((skill) => !["leaky", "linked", "big", "badpath", "many-a", "many-b"].includes(skill.name)),
  };
  await writeEvidence("env-refusals.json", { ok: Object.values(checks).every(Boolean), checks, cases });
};

const browser = (...args: Array<string>) => {
  const result = spawnSync("agent-browser", ["--session", "penvsk", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
};

/** The Skills section with two skills, one disabled, a preview open and one skill's view open. */
const shoot = async () => {
  await ready();
  await removeAll();
  await install(`https://github.com/${FIXTURE_REPO}/tree/${ENV_BRANCH}/tools/plum`);
  await install("mattpocock/skills", (skill) => skill.name === "grill-me");
  await harness("POST", "skills/enable", { name: "grill-me", enabled: false });
  const page = new URL("/_t3flare/harness", HARNESS).toString();
  for (const scheme of ["light", "dark"]) {
    for (const [name, width, height, scale] of [["desktop", 1280, 1100, 1], ["phone", 390, 844, 2]] as const) {
      browser("--headers", JSON.stringify(scriptHeaders), "--color-scheme", scheme, "open", page);
      browser("set", "viewport", String(width), String(height), String(scale));
      browser("set", "media", scheme);
      browser("open", page);
      browser("wait", "--load", "networkidle");
      browser("eval", `(() => { document.querySelector('[data-skill-view="fruit-code"]').click(); const f = document.querySelector('form[data-skill-install]'); f.querySelector('[name=source]').value = 'https://github.com/${FIXTURE_REPO}/tree/${REFUSALS_BRANCH}'; f.requestSubmit(); })()`);
      spawnSync("sleep", ["6"]);
      browser("eval", `document.getElementById('skills').scrollIntoView()`);
      spawnSync("sleep", ["0.5"]);
      const file = path.join(OUT, `skills-${name}-${scheme}.png`);
      browser("screenshot", "--full", file);
      const widthOf = () => Number(/pixelWidth: (\d+)/.exec(spawnSync("sips", ["-g", "pixelWidth", file], { encoding: "utf8" }).stdout)?.[1]);
      if (widthOf() > 1400) spawnSync("sips", ["--resampleWidth", "1400", file], { stdio: "ignore" });
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
      browser("close");
    }
  }
};

const commands: Record<string, () => Promise<void> | void> = { fixture, public: publicInstall, private: privateInstall, precedence, update, nocontainer: noContainer, readonly, remove, refusals, shoot };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: penvsk.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
