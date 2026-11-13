// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1148's stage evidence (stage `penvsk`): Environment skills. Run through the stage's `run`, which sets the stage's
// service token and admin token (never printed):
//
//   node scripts/stage.ts run penvsk penvsk probe     M0: R1 (GitHub), the read-only mount on both sides, set sizes (env-probe.json)
//
// Evidence goes to docs/steps/spi-1001/.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, pair } from "./lib/client.ts";

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

const [command] = process.argv.slice(2);
if (command === "probe") await probe();
else {
  console.error("usage: node scripts/stage.ts run penvsk penvsk probe");
  process.exit(2);
}
