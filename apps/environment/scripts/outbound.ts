// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off globalTimers:off nodeBuiltinImport:off
// SPI-1061: the Outbound link on a stage, against the stand-in (plan §6, §8): a stock t3 in Docker on this machine,
// reachable over the stage's named Cloudflare Tunnel (`T3FLARE_STANDIN=1` on deploy). Gates G1–G4 and checks C1–C7,
// one phase per run; evidence in docs/steps/spi-1061/<phase>.json. Nothing secret is printed or written: bearers,
// pairing codes and the tunnel token stay in memory (and the leak scans compare them by name).
//
//   node scripts/stage.ts run link outbound --phase link        G1, and C1's link through the dialog flow
//   node scripts/stage.ts run link outbound --phase card        G2 / C2: t3_environment_link's card, answered
//   node scripts/stage.ts run link outbound --phase delegate    C1: a Durable agent's delegate_task round trip; C3
//   node scripts/stage.ts run link outbound --phase long        G3 / C4: a long task across a hold, a deploy (--deploy),
//                                                               an idle reset and a stopped connector (10 min)
//   node scripts/stage.ts run link outbound --phase many        G4: eight Remote tasks waiting, then a model call
//   node scripts/stage.ts run link outbound --phase leak        C5 and C6: forced transport errors; the leak scan
//   node scripts/stage.ts run link outbound --phase revoke      C7: the session revoked on the stand-in; Unlink
//   node scripts/stage.ts run link outbound --phase stop        removes the stand-in's container
//
// `--fresh` starts a new stand-in container (and forgets the state of earlier phases).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { type AuthMcpClientAccess, mcpClientScopes } from "@t3tools/contracts";

import { admin, base, createProjectAndThread, dispatch, itemsOf, pair, runsOf, sleep, updateSettings, uuid, wsCall } from "./lib/client.ts";
import { MODEL, pendingOf, projection, replyOf, say, settled, t3Calls, until } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";
import { findSession } from "./lib/peerAcceptance.ts";
import { Standin, STANDIN_MODEL } from "./lib/standin.ts";
import { tailing } from "./lib/tail.ts";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};
const phase = arg("phase", "link");
const stage = base.hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
const evidenceDir = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1061");
const stateFile = path.join(import.meta.dirname, "../.alchemy", `outbound-${stage}.state.json`);
const stamp = Date.now().toString(36);
const started = Date.now();
const log = (what: string, detail: unknown = "") =>
  console.log(`[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - started) / 1000)}s] ${what} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`);
const failures: Array<string> = [];
const out: Record<string, unknown> = { phase, stage };
const check = (name: string, ok: boolean, detail?: unknown) => {
  log(`${ok ? "PASS" : "FAIL"} ${name}`);
  out.checks = [...((out.checks as Array<unknown>) ?? []), { name, ok, ...(detail === undefined ? {} : { detail }) }];
  if (!ok) failures.push(name);
  return ok;
};

interface State {
  readonly standinId?: string;
  readonly standinLabel?: string;
  readonly standinProjectId?: string | undefined;
  readonly cloudProjectId?: string;
}
let state: State = fs.existsSync(stateFile) && !process.argv.includes("--fresh") ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as State) : {};
const saveState = (next: Partial<State>) => {
  state = { ...state, ...next };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
};

const standin = new Standin({ stage, localPort: 47941 });
if (phase === "stop") {
  standin.stop();
  fs.rmSync(stateFile, { force: true });
  log("stand-in removed");
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Both sides.
const cookie = await pair();
await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
await wsCall(cookie, "server.updateSettings", {
  patch: {},
  providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
});
const cloud = (await (await fetch(new URL("/.well-known/t3/environment", base))).json()) as { environmentId: string; label: string };
out.cloud = { environmentId: cloud.environmentId, label: cloud.label };

const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", standin.name], { encoding: "utf8" }).stdout.trim() === "true";
if (!running || state.standinId === undefined || process.argv.includes("--fresh")) {
  log("starting the stand-in");
  const described = await standin.start();
  saveState({ standinId: described.environmentId, standinLabel: described.label, standinProjectId: undefined });
}
const sCookie = await standin.pair();
const sc = standin.client;
await sc.updateSettings(sCookie, { linkedEnvironmentsEnabled: true });
await sc.wsCall(sCookie, "server.updateSettings", {
  patch: {},
  providerInstanceMutation: { operation: "upsert", instanceId: "pi", instance: { driver: "pi", enabled: true, config: { binaryPath: "/usr/local/bin/pi" } } },
});
if (state.standinProjectId === undefined) {
  const projectId = uuid();
  await sc.mutateProject(sCookie, { type: "project.create", commandId: uuid(), projectId, title: "scratch", workspaceRoot: "/work/scratch", createWorkspaceRootIfMissing: true });
  saveState({ standinProjectId: projectId });
}
const sId = state.standinId!;
const sLabel = state.standinLabel!;
out.standin = { environmentId: sId, label: sLabel, route: standin.publicUrl.origin, version: standin.version };
await standin.awaitRoute("up", 180_000);

/** The cloud's links (t3's own list). */
const links = async () => ((await wsCall(cookie, "peerLinks.list", {})) as { links: Array<any> }).links;
const linkToStandin = async () => (await links()).find((link) => link.environmentId === sId);

/** A one-time pairing code minted on the stand-in for `access`, as the stock Link dialog mints it (peerPairingCode.ts). */
const mintOnStandin = async (access: AuthMcpClientAccess) =>
  (await mintPairingCode(sCookie, { label: "T3 Code link", scopes: [...mcpClientScopes(access)] }, standin.local)).code;

/** The stock Link dialog's flow: a code minted there, then `peerLinks.link` here with the machine it picked. */
const dialogLink = async (access: AuthMcpClientAccess) => {
  const pairingCode = await mintOnStandin(access);
  const at = Date.now();
  const answer = await wsCall(cookie, "peerLinks.link", {
    url: standin.publicUrl.origin,
    pairingCode,
    access,
    expectedEnvironmentId: sId,
    expectedLabel: sLabel,
  }).then(
    (value) => ({ ok: true as const, value: value as any, error: undefined as any }),
    (error: unknown) => ({ ok: false as const, value: undefined as any, error: JSON.parse(JSON.stringify(error ?? null)) as any }),
  );
  return { answer, ms: Date.now() - at, pairingCode };
};

const ensureLinked = async (access: AuthMcpClientAccess = "approval-required") => {
  const existing = await linkToStandin();
  if (existing !== undefined && existing.status === "reachable") return existing;
  if (existing !== undefined) await wsCall(cookie, "peerLinks.unlink", { environmentId: sId });
  const { answer } = await dialogLink(access);
  if (!answer.ok) throw new Error(`could not link: ${JSON.stringify(answer.error).slice(0, 400)}`);
  return answer.value;
};

/** An MCP client of the cloud's `/mcp` (an Inbound link at full access, which may use this Environment's links). */
const cloudMcp = async () => {
  const link = await signIn((await mintPairingCode(cookie, { label: `outbound harness ${stamp}` })).code, "full-access", { clientName: `outbound harness ${stamp}` });
  return new McpClient(link.token, { modeLimit: "full-access/default" });
};

/** The Durable agent's thread, at full access, on a plain project here. */
const cloudThread = async (title: string) => {
  if (state.cloudProjectId === undefined) {
    const made = await createProjectAndThread(cookie, { title: "link scratch", workspaceRoot: "/w/link-scratch" });
    saveState({ cloudProjectId: made.projectId });
  }
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId: state.cloudProjectId,
    title,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

const remoteTask = (p: any) => itemsOf(p).find((item: any) => item.type === "subagent" && item.remoteChild !== undefined);
const health = async () => (await admin("GET", "/_t3flare/health")).json;
const delegateArgs = (task: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    task,
    title: `outbound ${stamp}`,
    target: { environmentId: sId, projectId: state.standinProjectId, providerInstanceId: STANDIN_MODEL.instanceId, model: STANDIN_MODEL.model },
    mode: "async",
    ...extra,
  });
/** The stand-in's thread for a Remote task, as its owner's client reads it there. */
const standinThread = async (threadId: string) => sc.projectionOf(await sc.threadWindow(sCookie, threadId));
/** Approves, as the stand-in's owner, every request pending on its thread `threadId` (its agent's bash). */
const approveOnStandin = async (threadId: string) => {
  const p = await standinThread(threadId).catch(() => undefined);
  for (const request of pendingOf(p)) {
    await sc.dispatch(sCookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" });
  }
  return pendingOf(p).length;
};

const finish = (): never => {
  out.ok = failures.length === 0;
  out.failures = failures;
  out.seconds = Math.round((Date.now() - started) / 1000);
  writeEvidence(path.join(evidenceDir, `${phase}.json`), out);
  process.exit(failures.length === 0 ? 0 : 1);
};

// ---------------------------------------------------------------------------------------------------------------------
if (phase === "link") {
  // G1. The Route: the descriptor over the tunnel, and t3's own auth as the only thing in front.
  const descriptor = await standin.descriptor("public");
  check("G1: the stand-in's descriptor answers at the Route (https, no Access)", descriptor.environmentId === sId, { environmentId: descriptor.environmentId });
  const unauthenticated = await fetch(new URL("/mcp", standin.publicUrl), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check("G1: /mcp without a bearer is 401 at the Route", unauthenticated.status === 401, { status: unauthenticated.status });
  // An outside MCP client over the Route: t3's sign-in issues for the public hostname, so `Host` and `X-Forwarded-Proto`
  // pass through the tunnel as t3 needs; and a tool's answer comes back (JSON or SSE).
  const direct = await signIn(await mintOnStandin("read-only"), "read-only", { at: standin.publicUrl, peerLink: false, clientName: `route probe ${stamp}` });
  const listed = await new McpClient(direct.token, { at: standin.publicUrl }).request("tools/call", { name: "t3_project_list", arguments: {} });
  out.routeAnswer = { status: listed.status, contentType: listed.contentType };
  check("G1: a sign-in and a tool call over the Route (issuer from Host and X-Forwarded-Proto)", listed.status === 200 && JSON.stringify(listed.message ?? "").includes("scratch"), out.routeAnswer);

  // The stock Link dialog: a code minted on the stand-in, then `peerLinks.link` here. Unlinked first, so this is a link.
  if ((await linkToStandin()) !== undefined) await wsCall(cookie, "peerLinks.unlink", { environmentId: sId });
  const linked = await dialogLink("approval-required");
  out.link = {
    ok: linked.answer.ok,
    ms: linked.ms,
    value: linked.answer.ok
      ? { environmentId: linked.answer.value.environmentId, label: linked.answer.value.label, access: linked.answer.value.access, urls: linked.answer.value.urls, expiresAt: linked.answer.value.expiresAt }
      : linked.answer.error,
  };
  check("C1/G1: the stock dialog's link to the stand-in is made, at the access picked (Supervised)", linked.answer.ok && linked.answer.value.environmentId === sId && linked.answer.value.access === "approval-required", out.link);
  const listedLink = await linkToStandin();
  check("G1: t3's list shows it reachable", listedLink?.status === "reachable", listedLink === undefined ? null : { status: listedLink.status, urls: listedLink.urls, lastError: listedLink.lastError });
  const access = await sc.wsFirst(sCookie, "subscribeAuthAccess", {});
  check("the stand-in's Sharing & access lists the link's session", findSession(access, `T3 Code · ${cloud.label}`) !== undefined);

  // Forwarded calls, through the cloud's own client (PeerMcpClient), and a 50 s wait piece.
  const mcp = await cloudMcp();
  const forwardedList = await mcp.call("t3_project_list", { environmentId: sId });
  check("G1: a forwarded call answers (t3_project_list there)", !forwardedList.isError && forwardedList.text.includes("scratch"), forwardedList.text.slice(0, 300));
  const launched = await mcp.call("t3_thread_launch", {
    environmentId: sId,
    projectId: state.standinProjectId,
    title: `wait piece ${stamp}`,
    message: "Run the bash command `echo waited` and reply with its output.",
    modelSelection: STANDIN_MODEL,
    clientRequestId: `wait-${stamp}`,
  });
  const waitThread = launched.json?.threadId as string | undefined;
  check("G1: a forwarded launch starts a thread on the stand-in", !launched.isError && waitThread !== undefined, launched.text.slice(0, 300));
  if (waitThread !== undefined) {
    // Its bash asks there (the link is Supervised), so the run waits; a 50 s wait then holds and times out as a wait.
    const at = Date.now();
    let asked = 0;
    while (Date.now() - at < 180_000 && asked === 0) {
      asked = pendingOf(await standinThread(waitThread).catch(() => undefined)).length;
      if (asked === 0) await sleep(2000);
    }
    check("the stand-in's agent asks there for its bash (the link's Supervised access)", asked > 0);
    const waitAt = Date.now();
    const held = await mcp.call("t3_thread_wait", { environmentId: sId, threadId: waitThread, timeoutMs: 50_000 });
    out.waitPiece = { ms: Date.now() - waitAt, timedOut: held.json?.timedOut ?? null, isError: held.isError, text: held.isError ? held.text.slice(0, 300) : undefined };
    check("G1: a 50 s wait piece survives the Route and times out as a wait", held.json?.timedOut === true && Date.now() - waitAt >= 45_000, out.waitPiece);
    await approveOnStandin(waitThread);
    const done = await mcp.call("t3_thread_wait", { environmentId: sId, threadId: waitThread, timeoutMs: 50_000 });
    const read = await mcp.call("t3_thread_read", { environmentId: sId, threadId: waitThread });
    check("approved there, the thread completes and reads back here", read.text.includes("waited"), { wait: done.json?.status, read: read.text.slice(0, 200) });
  }

  // The laptop asleep: the connector stopped, the Route answers 530, t3 lists it unreachable and a call fails plainly.
  standin.connectorStop();
  const down = await standin.awaitRoute("down");
  const asleep = await linkToStandin();
  const failed = await mcp.call("t3_project_list", { environmentId: sId });
  const afterFail = await linkToStandin();
  out.asleep = { route: down, listed: asleep?.status, call: failed.text.slice(0, 300), lastError: afterFail?.lastError ?? null };
  check("G1: a stopped connector reads as unreachable (530 at the Route)", down.status === 530 && asleep?.status === "unreachable" && failed.isError, out.asleep);
  standin.connectorStart();
  out.awake = await standin.awaitRoute("up");
  check("the connector back, t3 lists it reachable again", (await linkToStandin())?.status === "reachable");
  finish();
}

if (phase === "card") {
  // G2 / C2: with nothing linked, the agent asks with t3_environment_link; the owner answers t3's card.
  if ((await linkToStandin()) !== undefined) await wsCall(cookie, "peerLinks.unlink", { environmentId: sId });
  const threadId = await cloudThread(`card ${stamp}`);
  out.threadId = threadId;
  await say(
    cookie,
    threadId,
    `I want you to work on my laptop "${sLabel}", which is not linked yet. Call the T3 tool t3_environment_link (if it is deferred, load it with tool_search first) once with {"hint": "${sLabel}", "reason": "To run a task on your laptop."}, then reply WAITING and stop. When you hear the outcome, reply exactly LINK-OUTCOME followed by the outcome in a few words.`,
  );
  const asked = await until(cookie, threadId, (p) => itemsOf(p).some((item: any) => item.type === "link_request") && settled(p), 240_000);
  const card = itemsOf(asked).find((item: any) => item.type === "link_request");
  const tools = (await admin("GET", `/_t3flare/agents/session-tools?thread=${threadId}`)).json;
  const offered = { link: tools?.tools?.includes("t3_environment_link") ?? null, unlink: tools?.tools?.includes("t3_environment_unlink") ?? null, left: tools?.left };
  out.offered = offered;
  check("C2: the Durable agent is offered t3_environment_link and t3_environment_unlink", offered.link === true && offered.unlink === true, offered);
  out.card = card === undefined ? null : { id: card.id, linkStatus: card.linkStatus, hint: card.hint, reason: card.reason };
  if (!check("G2/C2: t3's link card is raised in the agent's thread", card !== undefined && card.linkStatus === "pending", { card: out.card, calls: t3Calls(asked) })) finish();
  const pairingCode = await mintOnStandin("approval-required");
  await wsCall(cookie, "peerLinks.answerRequest", {
    threadId,
    turnItemId: card.id,
    answer: { type: "link", environmentId: sId, label: sLabel, urls: [standin.publicUrl.origin], access: "approval-required", pairingCode },
  });
  const woke = await until(
    cookie,
    threadId,
    (p) => itemsOf(p).find((each: any) => each.id === card.id)?.linkStatus !== "pending" && runsOf(p).length >= 2 && settled(p),
    300_000,
  );
  const answered = itemsOf(woke).find((item: any) => item.id === card.id);
  out.answered = { linkStatus: answered?.linkStatus, linkedEnvironmentId: answered?.linkedEnvironmentId, linkedAccess: answered?.linkedAccess, failure: answered?.failure, runs: runsOf(woke).map((run) => run.status), reply: replyOf(woke).slice(-300) };
  check("G2/C2: the owner's answer makes the link", answered?.linkStatus === "linked" && answered?.linkedEnvironmentId === sId, out.answered);
  check("G2/C2: the agent is woken with the outcome", runsOf(woke).length >= 2 && /LINK-OUTCOME/.test(replyOf(woke)), out.answered);
  const transcript = JSON.stringify(await projection(cookie, threadId));
  check("C2: the pairing code is in no transcript", !transcript.includes(pairingCode), { bytes: transcript.length });
  check("the link is t3's, listed reachable", (await linkToStandin())?.status === "reachable");
  finish();
}

if (phase === "delegate") {
  // C1: the Durable agent runs delegate_task on the stand-in; the thread there is marked "From" the stage.
  await ensureLinked();
  const nonce = `N-${stamp}`;
  const threadId = await cloudThread(`delegate ${stamp}`);
  out.threadId = threadId;
  await say(
    cookie,
    threadId,
    `Call the T3 tool delegate_task (if it is deferred, load it with tool_search first) exactly once with these arguments: ${delegateArgs(`Reply with exactly ${nonce} and nothing else. Use no tools.`)}. Then reply DELEGATED and stop. When the task's result arrives, reply exactly RESULT followed by the task's reply.`,
  );
  const done = await until(cookie, threadId, (p) => remoteTask(p)?.status === "completed" && runsOf(p).length >= 2 && settled(p), 360_000);
  const task = remoteTask(done);
  out.task = task === undefined ? null : { status: task.status, remoteChild: task.remoteChild, result: JSON.stringify(task.result ?? null).slice(0, 300) };
  out.runs = runsOf(done).map((run) => run.status);
  out.reply = replyOf(done).slice(-300);
  out.calls = t3Calls(done);
  if (check("C1: a Remote task is recorded with the stand-in as its machine", task?.remoteChild?.environmentId === sId, out.task)) {
    const there = await standinThread(task.remoteChild.threadId);
    out.there = { delegatedFrom: there?.thread?.delegatedFrom ?? null, linkOrigin: there?.thread?.linkOrigin ?? null, runtimeMode: there?.thread?.runtimeMode, reply: replyOf(there).slice(-200) };
    check("C1: the thread runs on the stand-in marked From the stage", there?.thread?.delegatedFrom?.environmentId === cloud.environmentId, out.there);
    check("C1: it runs under the link's access there (Supervised)", there?.thread?.runtimeMode === "approval-required", out.there);
    check("C1: its last reply completes the task here", task.status === "completed" && JSON.stringify(task).includes(nonce), out.task);
    check("C1: the parent wakes with it", runsOf(done).length >= 2 && replyOf(done).includes(nonce), { runs: out.runs, reply: out.reply });
  }
  // C3: what t3_environment_links answers names only tools the agent is offered.
  const tools = (await admin("GET", `/_t3flare/agents/session-tools?thread=${threadId}`)).json;
  const linksAnswer = await (await cloudMcp()).call("t3_environment_links", {});
  const named = [...new Set([...linksAnswer.text.matchAll(/\bt3_[a-z_]+\b/g)].map((m) => m[0]))];
  out.c3 = { offered: tools?.tools?.length, left: tools?.left, linksNames: named };
  check("C3: t3_environment_links names only tools the agent is offered", named.every((name) => tools?.tools?.includes(name)), out.c3);
  finish();
}

if (phase === "long") {
  // G3 / C4: a long Remote task while the Environment idles out, a deploy lands (`--deploy`), and the connector is
  // stopped for ten minutes. Nothing here reads the cloud's threads until the end: a client's request is activity.
  await ensureLinked();
  const minutes = Number(arg("sleep", "15"));
  const nonce = `L-${stamp}`;
  const threadId = await cloudThread(`long ${stamp}`);
  out.threadId = threadId;
  await say(
    cookie,
    threadId,
    `Call the T3 tool delegate_task (if it is deferred, load it with tool_search first) exactly once with these arguments: ${delegateArgs(`Run the bash command \`sleep ${minutes * 60}; echo ${nonce}\` once, with no timeout, and reply with exactly its output.`)}. Then reply DELEGATED and stop. When the task's result arrives, reply exactly RESULT followed by the task's reply.`,
  );
  const delegated = await until(cookie, threadId, (p) => remoteTask(p) !== undefined && settled(p), 240_000);
  const there = remoteTask(delegated)?.remoteChild?.threadId as string | undefined;
  if (!check("C4: the long task is delegated", there !== undefined, t3Calls(delegated))) finish();
  // Its bash asks there (Supervised): the owner approves on the laptop.
  for (let i = 0; i < 90 && (await approveOnStandin(there!)) === 0; i++) await sleep(2000);
  const timeline: Array<Record<string, any>> = [];
  const sample = async (note: string) => {
    const h = await health();
    const entry = { t: Math.round((Date.now() - started) / 1000), note, runtime: h?.runtime, alarm: h?.alarm, remoteRetry: h?.remoteRetry ?? null, openWork: h?.openWork, constructedAt: h?.object?.constructedAt };
    timeline.push(entry);
    log(note, { runtime: entry.runtime, alarm: entry.alarm, retry: entry.remoteRetry, work: entry.openWork });
    return entry;
  };
  const watch = async (seconds: number, note: string, stopWhen?: (entry: Record<string, any>) => boolean) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const entry = await sample(note);
      if (stopWhen?.(entry)) return entry;
      await sleep(20_000);
    }
    return timeline.at(-1)!;
  };
  // 1. The laptop answers: the Environment stays up past the idle delay, holding for the task, with an alarm standing.
  const held = await watch(180, "answering: held?");
  check("C4/G3: an open Remote task whose machine answers holds the Environment up past the idle delay, an alarm standing", held.runtime === "running" && held.openWork?.remoteTasksAnswering >= 1 && held.alarm !== null, held);
  // 2. A deploy lands while it is held: the standing alarm brings t3 back with no client, and its follower resumes.
  if (process.argv.includes("--deploy")) {
    const before = held.constructedAt;
    log("deploying");
    const deployed = spawnSync(process.execPath, [path.join(import.meta.dirname, "stage.ts"), "deploy", stage], { stdio: "inherit", env: { ...process.env, T3FLARE_STANDIN: "1" } });
    check("the deploy succeeds", deployed.status === 0);
    const back = await watch(480, "after deploy", (entry) => entry.constructedAt !== before && entry.runtime === "running");
    check("C4: after a deploy, the standing alarm boots t3 again with no client", back.constructedAt !== before && back.runtime === "running", back);
    const following = await watch(120, "after deploy: answering?", (entry) => entry.openWork?.remoteTasksAnswering >= 1);
    check("C4: after the deploy, the follower reaches the stand-in again", following.openWork?.remoteTasksAnswering >= 1, following);
  }
  // 3. The laptop asleep for ten minutes: the hold lapses, the Environment resets, the alarm retries at 5 then 15 minutes.
  standin.connectorStop();
  out.down = await standin.awaitRoute("down");
  await watch(600, "connector stopped");
  standin.connectorStart();
  out.up = await standin.awaitRoute("up");
  const retries = [...new Map(timeline.filter((entry) => entry.remoteRetry !== null).map((entry) => [JSON.stringify(entry.remoteRetry), entry.remoteRetry])).values()];
  out.retries = retries.map((retry: any) => ({ attempt: retry.attempt, at: new Date(retry.at).toISOString() }));
  check("C4: with the connector stopped, the hold lapsed and the Environment reset", timeline.some((entry) => entry.note === "connector stopped" && entry.runtime === "stopped"), { samples: timeline.length });
  check("C4: the retry backs off 5 then 15 minutes, its state in DO storage across resets", retries.length >= 2 && retries[0].attempt === 0 && retries[1].attempt === 1 && retries[1].at - retries[0].at >= 14 * 60_000, out.retries);
  // 4. Back: the next retry boots t3, the follower reaches the stand-in and completes the task.
  const finished = await watch(32 * 60, "waiting for the task", (entry) => entry.runtime === "running" && entry.openWork?.remoteTasksAnswering === 0 && entry.openWork?.remoteTasksUnanswered === 0);
  out.timeline = timeline;
  const done = await until(cookie, threadId, (p) => remoteTask(p)?.status === "completed" && settled(p) && runsOf(p).length >= 2, 600_000);
  const task = remoteTask(done);
  out.task = task === undefined ? null : { status: task.status, result: JSON.stringify(task.result ?? null).slice(0, 300) };
  out.reply = replyOf(done).slice(-300);
  check("C4: the task completes after the outage", task?.status === "completed" && JSON.stringify(task).includes(nonce), { task: out.task, finished });
  check("C4: the parent wakes with its result", replyOf(done).includes(nonce), out.reply);
  // Read the thread above (a client's request), so the next reset is at least the idle delay away; it clears the retry.
  const after = await watch(180, "after the task", (entry) => entry.remoteRetry === null);
  check("the retry state is gone by the next reset once nothing remote is open", after.remoteRetry === null, after);
  finish();
}

if (phase === "many") {
  // G4: several Remote tasks at once, each follower holding a 50 s wait piece (their bash waits for approval there),
  // then a model call. Cloudflare allows six outgoing connections at once per invocation.
  await ensureLinked();
  const count = Number(arg("count", "8"));
  const threadId = await cloudThread(`many ${stamp}`);
  const tasks = Array.from({ length: count }, (_, i) => delegateArgs(`Run the bash command \`echo many-${i}\` and reply with its output.`, { title: `many ${i} ${stamp}`, clientRequestId: `many-${i}-${stamp}` }));
  await say(cookie, threadId, `Call the T3 tool delegate_task (if it is deferred, load it with tool_search first) ${count} times, once with each of these argument objects:\n${tasks.join("\n")}\nThen reply DELEGATED and stop. Do not reply again until all ${count} results have arrived; then reply ALL-DONE.`);
  const delegated = await until(cookie, threadId, (p) => itemsOf(p).filter((item: any) => item.type === "subagent" && item.remoteChild !== undefined).length >= count && settled(p), 600_000);
  const remote = itemsOf(delegated).filter((item: any) => item.type === "subagent" && item.remoteChild !== undefined);
  out.delegated = remote.length;
  check(`G4: ${count} Remote tasks are open at once`, remote.length >= count, { delegated: remote.length, calls: t3Calls(delegated).length });
  await sleep(60_000);
  const probe = await cloudThread(`many probe ${stamp}`);
  const at = Date.now();
  await say(cookie, probe, "Reply with exactly PONG and nothing else. Use no tools.");
  const answered = await until(cookie, probe, (p) => settled(p), 240_000);
  out.modelCall = { ms: Date.now() - at, runs: runsOf(answered).map((run) => run.status), reply: replyOf(answered).slice(0, 50) };
  check(`G4: with ${remote.length} Remote tasks waiting, a model call still goes through`, /PONG/.test(replyOf(answered)), out.modelCall);
  const ids = remote.map((item: any) => item.remoteChild.threadId as string);
  const releaseAt = Date.now();
  let statuses: Array<string> = [];
  while (Date.now() - releaseAt < 600_000) {
    for (const id of ids) await approveOnStandin(id);
    statuses = itemsOf(await projection(cookie, threadId)).filter((item: any) => item.type === "subagent" && item.remoteChild !== undefined).map((item: any) => item.status);
    if (statuses.length >= count && statuses.every((s) => s === "completed")) break;
    await sleep(10_000);
  }
  out.statuses = statuses;
  out.releaseMs = Date.now() - releaseAt;
  check(`G4: all ${count} complete once approved there`, statuses.length >= count && statuses.every((s) => s === "completed"), statuses);
  out.publish = "not measured: a stage has no T3 Connect link (step 3+ links prod only)";
  finish();
}

if (phase === "leak") {
  // C6: forced transport errors at sign-in and on a call, with Workers Logs tailed; then C5, the leak scan.
  await ensureLinked();
  const codes: Array<string> = [];
  const { result, text, workers } = await tailing([`t3flare-environment-${stage}`, `t3flare-agents-${stage}`], async () => {
    // At sign-in: the descriptor and the decision answer; the token exchange's connection is cut.
    await wsCall(cookie, "peerLinks.unlink", { environmentId: sId });
    standin.fault("signin");
    const signin = await dialogLink("approval-required");
    codes.push(signin.pairingCode);
    standin.fault("none");
    // Linked again; then on a call: the forwarded `/mcp` request's connection is cut.
    const relinked = await dialogLink("approval-required");
    codes.push(relinked.pairingCode);
    const mcp = await cloudMcp();
    standin.fault("call");
    const call = await mcp.call("t3_project_list", { environmentId: sId });
    standin.fault("none");
    const row = (await admin("POST", "/_t3flare/sql", { sql: "SELECT last_error FROM peer_environment_links WHERE environment_id = ?", params: [sId] })).json;
    return { signin: signin.answer, relinked: relinked.answer.ok, call: { isError: call.isError, text: call.text.slice(0, 400) }, lastError: row };
  });
  out.signin = result.signin.ok ? "linked (no fault seen)" : result.signin.error;
  out.call = result.call;
  out.lastError = result.lastError;
  out.workers = workers;
  const replies = JSON.stringify(result);
  check("C6: a cut sign-in fails with t3's reason and no cause in the WS reply", !result.signin.ok && result.signin.error?.cause === undefined && typeof result.signin.error?.reason === "string", out.signin);
  check("C6: a cut call fails plainly; last_error is recorded", result.call.isError && result.relinked, { call: result.call, lastError: result.lastError });
  const leak = (await admin("POST", "/_t3flare/check/connect-leak", { text: `${replies}\n${text}` })).json;
  const codesSeen = codes.filter((code) => text.includes(code) || replies.includes(code));
  out.c6 = { checked: leak?.checked, leaked: leak?.leaked, logBytes: text.length, pairingCodesSeen: codesSeen.length };
  check(
    "C6: no bearer in the WS reply, last_error or Workers Logs",
    Array.isArray(leak?.leaked) && leak.leaked.length === 0 && (leak.checked as Array<string>).some((name) => name.startsWith("peer-link:")),
    out.c6,
  );
  check("C6: no pairing code in the WS reply, last_error or Workers Logs", codesSeen.length === 0, out.c6);

  // C5: the leak scan after C1–C4, the bearer as a canary: the named Sessions, a Workspace's Container, snapshots.
  const threads = arg("threads", "").split(",").filter(Boolean);
  const scan = (await admin("POST", "/_t3flare/check/peer-leak", { workspace: arg("workspace", "link-scratch"), threads, extra: [{ name: "standin-tunnel-token", value: standin.tunnelToken }] })).json;
  out.c5 = { checked: scan?.checked, container: scan?.container, sessions: scan?.sessions, credentialsFound: scan?.credentialsFound, leaked: scan?.leaked };
  check("C5: the bearer is among the canaries", (scan?.checked ?? []).some((name: string) => name.startsWith("peer-link:")), scan?.checked);
  check("C5: no secret in any Session, the Workspace's Container or a snapshot", scan?.leaked === 0, out.c5);
  finish();
}

if (phase === "revoke") {
  // C7: the session revoked on the stand-in: t3's own answers here, and an open task fails with that reason.
  await ensureLinked();
  const threadId = await cloudThread(`revoke ${stamp}`);
  await say(
    cookie,
    threadId,
    `Call the T3 tool delegate_task (if it is deferred, load it with tool_search first) exactly once with these arguments: ${delegateArgs("Run the bash command `sleep 600; echo late` and reply with its output.")}. Then reply DELEGATED and stop. When the task's outcome arrives, reply exactly OUTCOME followed by it in a few words.`,
  );
  const delegated = await until(cookie, threadId, (p) => remoteTask(p) !== undefined && settled(p), 240_000);
  check("C7: a task is open on the stand-in", remoteTask(delegated) !== undefined);
  const session = findSession(await sc.wsFirst(sCookie, "subscribeAuthAccess", {}), `T3 Code · ${cloud.label}`);
  const revoked = await fetch(new URL("/api/auth/clients/revoke", standin.local), {
    method: "POST",
    headers: { cookie: sCookie, origin: standin.local.origin, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session?.sessionId }),
  });
  check("the owner revokes the link's session in the stand-in's Sharing & access", session !== undefined && revoked.status === 200, { found: session !== undefined, status: revoked.status });
  const mcp = await cloudMcp();
  const call = await mcp.call("t3_project_list", { environmentId: sId });
  out.call = call.text.slice(0, 300);
  check("C7: a tool call names it (t3's own answer)", call.isError && /no longer accepts this link|revoked/i.test(call.text), out.call);
  const failed = await until(cookie, threadId, (p) => remoteTask(p)?.status === "failed" && settled(p), 15 * 60_000);
  const task = remoteTask(failed);
  out.task = task === undefined ? null : { status: task.status, result: JSON.stringify(task.result ?? null).slice(0, 300) };
  out.reply = replyOf(failed).slice(-300);
  check("C7: the open task fails with that reason", task?.status === "failed" && /no longer accepts this link|revoked/i.test(JSON.stringify(task)), out.task);
  // Unlink here (t3's own), and the next call answers t3's "not linked".
  await wsCall(cookie, "peerLinks.unlink", { environmentId: sId });
  const unlinked = await mcp.call("t3_project_list", { environmentId: sId });
  out.unlinked = unlinked.text.slice(0, 300);
  check("C7: after Unlink, t3's own answer names the missing link", unlinked.isError && /not linked/i.test(unlinked.text), out.unlinked);
  finish();
}

console.error(`unknown phase ${phase}`);
process.exit(2);
