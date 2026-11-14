// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// SPI-1186's stage evidence (stage `pgitobj`): t3's own commit action in a Workspace's Container, with its commit draft's
// temporary index, object directory and alternates bridged. Run through the stage's `run` (its service token and admin
// token, never printed):
//
//   node scripts/stage.ts run pgitobj pgitobj commit    t3 commits picked files, with a message and with a drafted one (commit.json)
//   … cleanup                                           the bridged folders are gone once the drafts end (cleanup.json)
//   … stopped                                           a primed Workspace, its Container stopped: the draft's reads start nothing (stopped.json)
//   … fresh                                             a new clone, watched once, its Container stopped: the commit works, leftovers swept (fresh.json)
//
// Evidence goes to docs/steps/spi-1186/, each file naming the deployed commit.
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, pair, sleep, wsCall } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { committed, t3Commit, workspaceGit } from "./lib/t3Commit.ts";

const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1186");
const WORKSPACE = "pgitobj";
const TMP = "/workspace/.t3flare/tmp";

const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;
const evidence = async (name: string, value: Record<string, unknown>) =>
  writeEvidence(path.join(OUT, name), { host: new URL(process.env.T3_URL ?? "").host, commit: await deployedCommit(), ...value });

const call = async (id: string, body: unknown) => (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, body)).json;
const containerOf = async (id: string) => (await call(id, { reclaimReason: true }))?.container as { running: boolean; startedAt: number | null } | undefined;
/** A file written to the Workspace's files: never starts its Container. */
const writeFile = (id: string, file: string, text: string) => call(id, { fs: { op: "write", path: `/workspace/repo/${file}`, data: text } });
/** The bridge's folders in the Workspace's harness tmp/, from its files (never starts its Container). */
const bridgedFolders = async (id: string) =>
  (((await call(id, { fs: { op: "readdir", path: TMP } }))?.result?.ok ?? []) as Array<{ name: string }>).map((entry) => entry.name).filter((name) => /^(index|objects)-[0-9a-f]{24}$/.test(name));
const trace = async (clear = false) => (await admin("GET", `/_t3flare/agents/router-trace${clear ? "?clear=1" : ""}`)).json as { entries: Array<any>; gitBridges: Array<unknown> };

const stop = async (id: string) => {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
    if ((await containerOf(id))?.running !== true) return true;
    await sleep(3_000);
  }
  return false;
};

/** The repo back at origin/main, clean (the Workspace's git, starting its Container). */
const reset = (id: string) => workspaceGit(id, ["reset", "-q", "--hard", "origin/main"]).then(() => workspaceGit(id, ["clean", "-fdq"]));

/**
 * The router trace's git commands in `cwd`, as the evidence keeps them, in the order they started: the trace appends an
 * entry when its command ends, so a long one (t3's upstream fetch) is listed after the reads that ran while it did.
 */
const gitIn = (entries: Array<any>, cwd: string) =>
  entries
    .filter((entry) => entry.command === "git" && entry.cwd === cwd)
    .toSorted((left, right) => left.at - right.at)
    .map((entry) => ({ at: entry.at, ms: entry.ms, argv: entry.argv.join(" "), route: entry.route, exitCode: entry.exitCode, detail: entry.detail ?? null }));

const DRAFT_READS = ["rev-parse --git-path index --git-path objects", "count-objects -v"];

let cookie = "";

const commit = async () => {
  cookie ||= await pair();
  const { root } = await ensureProject(cookie, WORKSPACE);
  await reset(WORKSPACE);
  const stamp = Date.now().toString(36);
  await writeFile(WORKSPACE, "picked.txt", `picked ${stamp}\n`);
  await writeFile(WORKSPACE, "left.txt", `left ${stamp}\n`);
  await trace(true);
  // With a message: t3's draft reads the staged summary only; its commit stages the picked file over stdin.
  const subject = `pgitobj: t3's commit action ${stamp}`;
  const withMessage = await t3Commit(cookie, { id: WORKSPACE, cwd: root, filePaths: ["picked.txt"], message: subject });
  const draftTrace = gitIn((await trace(true)).entries, root);
  const status = await workspaceGit(WORKSPACE, ["status", "--porcelain"]);
  // With no message: t3 drafts one from the staged patch (its text generation) as well.
  await writeFile(WORKSPACE, "drafted.txt", `drafted ${stamp}\n`);
  const drafted = await t3Commit(cookie, { id: WORKSPACE, cwd: root, filePaths: ["drafted.txt"] });
  const draftedTrace = gitIn((await trace(true)).entries, root);
  const cases = [
    {
      name: "with a message: the picked file alone is committed",
      report: withMessage,
      leftUncommitted: status.stdout.split("\n").filter(Boolean),
      ok: committed(withMessage, ["picked.txt"], subject) && !withMessage.head!.files.includes("left.txt") && status.stdout.includes("left.txt"),
    },
    { name: "with a drafted message (the staged patch read through the draft)", report: drafted, ok: committed(drafted, ["drafted.txt"]) },
  ];
  await evidence("commit.json", { root, cases, trace: { withMessage: draftTrace, drafted: draftedTrace }, ok: cases.every((entry) => entry.ok) });
  await reset(WORKSPACE);
};

const cleanup = async () => {
  cookie ||= await pair();
  const { root } = await ensureProject(cookie, WORKSPACE);
  await reset(WORKSPACE);
  const before = await bridgedFolders(WORKSPACE);
  const rounds: Array<Record<string, unknown>> = [];
  for (let round = 0; round < 3; round++) {
    await writeFile(WORKSPACE, `round-${round}.txt`, `${round}\n`);
    // Watched while the draft runs: its bridges, and its folders in the Workspace's files.
    const seen = { liveBridges: new Set<string>(), folders: new Set<string>() };
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const [live, folders] = await Promise.all([trace().then((answer) => answer.gitBridges as Array<{ bridged: string }>), bridgedFolders(WORKSPACE)]);
        for (const entry of live) seen.liveBridges.add(entry.bridged);
        for (const folder of folders) seen.folders.add(folder);
      }
    })();
    const done = await t3Commit(cookie, { id: WORKSPACE, cwd: root, filePaths: [`round-${round}.txt`], message: `pgitobj: cleanup round ${round}` });
    watching = false;
    await watch;
    // t3's status poll runs git, which reaps the drafts t3 has ended.
    await wsCall(cookie, "vcs.refreshStatus", { cwd: root }).catch(() => undefined);
    await sleep(2_000);
    rounds.push({ committed: committed(done, [`round-${round}.txt`]), duringDraft: { liveBridges: [...seen.liveBridges], folders: [...seen.folders] }, liveBridges: (await trace()).gitBridges, bridgedFolders: await bridgedFolders(WORKSPACE) });
  }
  // The Container's copy of the harness tmp/ (the Workspace's files are the truth; the Container's is synced).
  const inContainer = await call(WORKSPACE, { exec: { script: `ls -1 ${TMP} 2>/dev/null | grep -E '^(index|objects)-' || true`, timeoutMs: 60_000 } });
  const after = await bridgedFolders(WORKSPACE);
  await evidence("cleanup.json", {
    before,
    rounds,
    after,
    inContainer: String(inContainer?.result?.stdout ?? "").split("\n").filter(Boolean),
    ok: rounds.every((round) => round.committed === true && (round.duringDraft as { folders: Array<string> }).folders.length > 0 && (round.liveBridges as Array<unknown>).length === 0 && (round.bridgedFolders as Array<string>).length === 0) && after.length === 0,
  });
  await reset(WORKSPACE);
};

/**
 * t3's commit with the Container stopped: which command ran in the Container first (by start time: what started it, as
 * no passive read may), and that the draft's two first reads did not run there.
 */
const commitWhileStopped = async (id: string, root: string, primed: boolean) => {
  // A routed action primes the allow-listed reads while the Container runs, as an agent's work would. A fresh clone has
  // had none of its own, but t3's status refresh below runs an upstream fetch (an action), which primes them too.
  if (primed) {
    await reset(id);
    await sleep(5_000);
  }
  // A client watching the project while its Container runs (after the clone): t3's status reads get real answers, as
  // they would in use; those are passive, so they prime nothing.
  const watched = await containerOf(id);
  await wsCall(cookie, "vcs.refreshStatus", { cwd: root }).catch(() => undefined);
  const stopped = await stop(id);
  const stamp = Date.now().toString(36);
  await writeFile(id, "while-stopped.txt", `${stamp}\n`);
  await trace(true);
  // t3's status poll first: passive, the Container stays stopped.
  await wsCall(cookie, "vcs.refreshStatus", { cwd: root }).catch(() => undefined);
  const afterPoll = await containerOf(id);
  const done = await t3Commit(cookie, { id, cwd: root, filePaths: ["while-stopped.txt"], message: `pgitobj: committed while stopped ${stamp}` });
  const commands = gitIn((await trace(true)).entries, root);
  const draftReads = commands.filter((entry) => DRAFT_READS.includes(entry.argv));
  const firstInContainer = commands.find((entry) => entry.route === "container") ?? null;
  return {
    runningWhenWatched: watched?.running ?? null,
    stopped,
    afterPoll,
    report: done,
    draftReads,
    firstInContainer,
    commands,
    ok: stopped && afterPoll?.running === false && committed(done, ["while-stopped.txt"]) && firstInContainer !== null && String(firstInContainer.detail).startsWith("action"),
  };
};

const stoppedCase = async () => {
  cookie ||= await pair();
  const { root } = await ensureProject(cookie, WORKSPACE);
  const result = await commitWhileStopped(WORKSPACE, root, true);
  // Primed: neither of the draft's first reads ran in the Container; an action started it (checked in the result).
  const ok = result.ok && result.draftReads.length === 2 && result.draftReads.every((entry) => entry.route !== "container" && !String(entry.detail).includes("started the Container"));
  await evidence("stopped.json", { root, ...result, ok });
  await reset(WORKSPACE);
};

const fresh = async () => {
  cookie ||= await pair();
  const id = `pgitobj-${Date.now().toString(36)}`;
  const { root } = await ensureProject(cookie, id);
  // Leftovers as an earlier isolate would leave them (the bridge's map is in memory), beside a file of the Workspace's.
  const planted = ["index-000000000000000000000000/index", "objects-111111111111111111111111/info/t3flare-draft", "keep.bundle"];
  for (const file of planted) {
    const target = `${TMP}/${file}`;
    await call(id, { fs: { op: "mkdir", path: target.slice(0, target.lastIndexOf("/")), recursive: true } });
    await call(id, { fs: { op: "write", path: target, data: "x" } });
  }
  const before = (((await call(id, { fs: { op: "readdir", path: TMP } }))?.result?.ok ?? []) as Array<{ name: string }>).map((entry) => entry.name);
  const result = await commitWhileStopped(id, root, false);
  const after = (((await call(id, { fs: { op: "readdir", path: TMP } }))?.result?.ok ?? []) as Array<{ name: string }>).map((entry) => entry.name);
  const sweep = { before, after, ok: after.includes("keep.bundle") && !after.some((name) => /^(index|objects)-/.test(name)) };
  // Its draft reads have answers by now (the refresh's fetch primed them), so the allow-list path does not run here: it
  // runs in apps/agents/test/gitDirReads.test.ts only.
  await evidence("fresh.json", { root, ...result, sweep, ok: result.ok && sweep.ok });
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${id}`);
};

const commands: Record<string, () => Promise<void>> = { commit, cleanup, stopped: stoppedCase, fresh };
const name = process.argv[2] ?? "";
const run = commands[name];
if (run === undefined) {
  console.error(`usage: pgitobj ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
await run();
process.exit(0);
