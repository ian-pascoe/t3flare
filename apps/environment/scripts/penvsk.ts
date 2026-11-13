// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1148's stage evidence (stage `penvsk`): Environment skills. Run through the stage's `run`, which sets the stage's
// service token and admin token (never printed):
//
//   node scripts/stage.ts run penvsk penvsk probe     M0: R1 (GitHub), the read-only mount on both sides, set sizes (env-probe.json)
//   node scripts/stage.ts run penvsk penvsk sync      M0 (review): a running Container's copy after each set change, with
//                                                    and without the bind, by sha256, polled until it matches (env-sync.json)
//
// Evidence goes to docs/steps/spi-1001/.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, pair } from "./lib/client.ts";
import { probeSkillSet } from "../src/host/envSkillsProbe.ts";

const T3 = process.env.T3_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1001");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const WORKSPACE = "penvsk-mount";
const MOUNT = "/workspace/.agents/skills";

/** The deployed build's commit (the Worker's `/_t3flare/health`), so each evidence file names the code it ran against. */
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }, null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1001/${name}`);
};

const callOn = async (id: string, body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${id}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) } as { status: number; ms?: number; result: any; container: any };
  } catch {
    return { status: response.status, result: text.slice(0, 500), container: undefined };
  }
};
const call = (body: unknown) => callOn(WORKSPACE, body);
const sh = async (script: string) => {
  const answer = await call({ exec: { script, timeoutMs: 180_000 } });
  return { exitCode: answer.result?.exitCode, stdout: String(answer.result?.stdout ?? "").slice(0, 3000), stderr: String(answer.result?.stderr ?? "").slice(0, 1000), running: answer.container?.running };
};
const fsOp = async (op: unknown) => (await call({ fs: op })).result;
const setOf = async (mib: number) => (await admin("POST", `/_t3flare/probe/env-skills?part=set&id=${WORKSPACE}&mib=${mib}`)).json;

const probe = async () => {
  const github = (await admin("POST", "/_t3flare/probe/env-skills?part=github")).json;
  // The mint for an owner the App is not installed on (the refusal's case).
  const uninstalled = (await admin("POST", "/_t3flare/probe/env-skills?part=github&privateOutside=octocat/Hello-World")).json?.privateOutsideMint;
  const cookie = await pair();
  await ensureProject(cookie, WORKSPACE);
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
  const mount: Record<string, unknown> = {};
  mount.emptyStat = await fsOp({ op: "stat", path: MOUNT });
  mount.small = await setOf(0.01);
  mount.read = await fsOp({ op: "read", path: `${MOUNT}/probe-utf8/SKILL.md` });
  mount.doWrite = await fsOp({ op: "write", path: `${MOUNT}/probe-utf8/new.md`, data: "x" });
  mount.doWriteNewSkill = await fsOp({ op: "write", path: `${MOUNT}/mine/SKILL.md`, data: "x" });
  mount.doRemove = await fsOp({ op: "remove", path: `${MOUNT}/probe-utf8`, options: { recursive: true, force: true } });
  mount.doRemoveParent = await fsOp({ op: "remove", path: "/workspace/.agents", options: { recursive: true, force: true } });
  mount.doRename = await fsOp({ op: "rename", path: `${MOUNT}/probe-utf8`, to: "/workspace/moved" });
  mount.doMkdir = await fsOp({ op: "mkdir", path: `${MOUNT}/made`, recursive: true });
  mount.stateBefore = (await call({ fs: { op: "stat", path: MOUNT } })).container;
  // The Container's side: the files after a sync, a write there, and what the Workspace kept of it.
  mount.containerView = await sh(`id; ls -la ${MOUNT} ${MOUNT}/probe-utf8; cat ${MOUNT}/probe-utf8/SKILL.md; grep -E ' /workspace' /proc/self/mountinfo`);
  mount.containerWrite = await sh(`echo planted > ${MOUNT}/probe-utf8/planted.txt; echo "exit=$?"; ls ${MOUNT}/probe-utf8`);
  mount.containerWriteNewDir = await sh(`mkdir -p ${MOUNT}/agent-made && echo hi > ${MOUNT}/agent-made/SKILL.md; echo "exit=$?"`);
  mount.containerRemove = await sh(`rm -rf ${MOUNT}/probe-0; echo "exit=$?"; ls ${MOUNT}`);
  mount.afterContainerWriteInWorkspace = {
    planted: await fsOp({ op: "stat", path: `${MOUNT}/probe-utf8/planted.txt` }),
    agentMade: await fsOp({ op: "stat", path: `${MOUNT}/agent-made/SKILL.md` }),
    removedSkill: await fsOp({ op: "stat", path: `${MOUNT}/probe-0/SKILL.md` }),
  };
  mount.containerAfterSync = await sh(`ls -la ${MOUNT} ${MOUNT}/probe-utf8`);
  // A read-only bind mount over the directory, as cloudpid's bootstrap makes one.
  mount.bindReadOnly = await sh(`mount --bind ${MOUNT} ${MOUNT} && mount -o remount,bind,ro ${MOUNT}; echo "mount=$?"; echo again > ${MOUNT}/probe-utf8/again.txt; echo "write=$?"; grep -E ' /workspace' /proc/self/mountinfo`);
  mount.bindPersists = await sh(`grep -E ' /workspace' /proc/self/mountinfo; echo z > ${MOUNT}/probe-utf8/z.txt; echo "write=$?"`);
  // A new set while the Container runs with the bind mount: does it see the new files?
  mount.changeWhileRunning = await setOf(0.02);
  mount.containerSeesChange = await sh(`ls ${MOUNT}; ls ${MOUNT}/probe-1 2>&1 | head; wc -c ${MOUNT}/probe-0/data.txt; ls ${MOUNT}/probe-utf8 ${MOUNT}/agent-made`);
  const sizes: Record<string, unknown> = {};
  for (const mib of [8, 16, 24]) {
    sizes[`${mib}MiB`] = await setOf(mib);
    if (mib === 8) sizes.containerAfter8 = await sh(`du -sb ${MOUNT}; ls ${MOUNT} | wc -l`);
  }
  sizes.reset = await setOf(0);
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
  await writeEvidence("env-probe.json", { workspace: WORKSPACE, github: { ...github, uninstalledOwnerMint: uninstalled }, mount, sizes });
};

/** The bind as the build would run it before a launch's first command: idempotent, one attempt at a time (flock). */
const LOCK = [
  `D=${MOUNT}`,
  `if ! grep -qs " $D " /proc/self/mountinfo; then`,
  `  exec 9>/tmp/t3flare-skills.lock; flock 9`,
  `  grep -qs " $D " /proc/self/mountinfo || { mkdir -p "$D" && mount --bind "$D" "$D" && mount -o remount,bind,ro "$D"; }`,
  `  exec 9>&-`,
  `fi`,
].join("\n");

const sha256 = async (text: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
const expectedOf = async (mib: number) => {
  const set = mib === 0 ? { files: {} } : await probeSkillSet(mib);
  const out: Record<string, string> = {};
  for (const [file, text] of Object.entries(set.files)) out[file] = await sha256(text);
  return out;
};
const LIST = `cd ${MOUNT} 2>/dev/null && find . -type f | sed 's|^./||' | sort | while read -r f; do printf '%s %s\\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done`;
const containerFiles = async () => {
  const answer = await sh(LIST);
  return Object.fromEntries(
    answer.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ...rest] = line.split(" ");
        return [rest.join(" "), hash];
      }),
  ) as Record<string, string>;
};
const compare = (want: Record<string, string>, got: Record<string, string>) => {
  const stale = Object.keys(want).filter((file) => got[file] !== undefined && got[file] !== want[file]);
  const missing = Object.keys(want).filter((file) => got[file] === undefined);
  const extra = Object.keys(got).filter((file) => want[file] === undefined);
  return { match: stale.length + missing.length + extra.length === 0, stale, missing, extra };
};
/** Polls the running Container's copy every 2 s for up to `limitMs`, until it matches `mib`'s set. */
const pollUntil = async (mib: number, limitMs = 90_000) => {
  const want = await expectedOf(mib);
  const started = Date.now();
  const seen: Array<unknown> = [];
  for (;;) {
    const got = await containerFiles();
    const verdict = compare(want, got);
    seen.push({ afterMs: Date.now() - started, ...verdict, stale: verdict.stale.slice(0, 5), missing: verdict.missing.slice(0, 5), extra: verdict.extra.slice(0, 5) });
    if (verdict.match) return { matched: true, afterMs: Date.now() - started, polls: seen.length, seen: seen.slice(-3) };
    if (Date.now() - started > limitMs) return { matched: false, afterMs: Date.now() - started, polls: seen.length, seen: seen.slice(-3) };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};
/** Takes `mib`'s set while the Container runs (each file read first, so any cache is warm), then polls. */
const change = async (mib: number) => {
  await sh(`cat ${MOUNT}/*/* > /dev/null 2>&1; true`);
  const taken = await setOf(mib);
  return { mib, taken: taken?.answer?.taken, hash: taken?.hash, poll: await pollUntil(mib) };
};

const sync = async () => {
  const cookie = await pair();
  await ensureProject(cookie, WORKSPACE);
  const modes: Record<string, unknown> = {};
  for (const bind of [false, true]) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
    await setOf(0.02);
    const first = await sh(bind ? `${LOCK}\necho "lock=$?"; grep -c ' ${MOUNT} ' /proc/self/mountinfo` : "true");
    const fresh = await pollUntil(0.02, 30_000);
    const steps = [];
    // In place (sizes change), grown to 8 MiB (new files, one path in both), shrunk (files removed), emptied.
    for (const mib of [0.03, 8, 0.01, 0]) steps.push(await change(mib));
    const writeRefused = bind ? await sh(`echo x > ${MOUNT}/x 2>&1; echo "write=$?"`) : undefined;
    // A fresh Container after the changes gets the Workspace's files.
    await setOf(0.03);
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
    const restarted = await sh(bind ? `${LOCK}` : "true");
    const afterRestart = await pollUntil(0.03, 30_000);
    modes[bind ? "bind" : "noBind"] = { first, fresh, steps, writeRefused, restarted: restarted.exitCode, afterRestart };
  }
  // Two first commands at once on a fresh Container: one bind.
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
  const both = await Promise.all([sh(`${LOCK}\necho "rc=$?"`), sh(`${LOCK}\necho "rc=$?"`)]);
  const binds = await sh(`grep -c ' ${MOUNT} ' /proc/self/mountinfo; command -v flock`);
  await setOf(0);
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
  await writeEvidence("env-sync.json", { workspace: WORKSPACE, note: "sha256 of every file under the mount in the running Container, polled every 2 s, against the set the Workspace took", modes, concurrentFirstCommands: { answers: both, binds } });
};

const [command] = process.argv.slice(2);
if (command === "probe") await probe();
else if (command === "sync") await sync();
else {
  console.error("usage: node scripts/stage.ts run penvsk penvsk probe");
  process.exit(2);
}
