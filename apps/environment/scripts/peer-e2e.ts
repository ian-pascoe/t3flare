// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalRandom:off
// Step 3, M4: delegation end to end with two servers on this machine, no owner (plan section 6, M4). A stock t3 from npm
// at `--version` is the laptop, its Pi agent on the model proxy; it links to the stage at auto-accept-edits and its agent
// hands a task to the cloud's Durable agent with `delegate_task`. The harness answers the cloud child's question from the
// laptop side (an outside MCP client of the laptop, `t3_pending_request` forwarded over the link) and approves its
// `bash` as the owner on the cloud. Variants (`--variant`):
//
//   main             the task asks, runs bash, replies with a nonce; the laptop task completes with it and the parent wakes
//   cancel           the laptop agent cancels the task (`task_cancel`) while its `sleep` runs: the cloud run stops, the
//                    sleep is killed
//   laptop-restart   the laptop server is stopped and started again while the cloud question waits; the task completes
//   cloud-restart    the cloud Environment restarts while the child's `bash` runs; the task completes (ADR-0004)
//   question-restart the cloud Environment restarts while the child's question waits (review C2); the task completes
//                    with the answer, not the cut run's reply
//   revoked          the link is revoked in the cloud mid-task: the laptop task fails naming it
//
//   node scripts/stage.ts run step3 peer-e2e --variant main [--version 0.1.9-nightly.20261111.4515] [--out m4-e2e-pinned.json]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { admin, base, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sleep, updateSettings, uuid, wsCall, wsFirst } from "./lib/client.ts";
import { pendingOf, projection as cloudProjection } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { ensureCloudFixtureProject, FIXTURE } from "./lib/fixtureProject.ts";
import { Laptop } from "./lib/laptop.ts";
import { LAPTOP_MODEL, laptopPiEnvironment, piInstanceMutation } from "./lib/laptopAgent.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};
const variant = arg("variant", "main");
const version = arg("version", "0.1.9-nightly.20261111.4515");
const outFile = arg("out", `m4-${variant}.json`);
const stamp = Date.now().toString(36);
const nonce = `N-${stamp}`;
const failures: Array<string> = [];
const out: Record<string, unknown> = { variant, version, nonce };
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  return ok;
};
const log = (what: string, detail: unknown = "") => console.log(`[${new Date().toISOString().slice(11, 19)}] ${what} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`);

// The task the cloud child gets, per variant.
const TASKS: Record<string, string> = {
  main: `First use the ask_user tool to ask the question "Proceed with ${nonce}?" with options ["yes", "no"]. If the answer is yes, run the bash command \`echo ${nonce}-$(wc -l < README.md | tr -d ' ')\` and reply with exactly its output; otherwise reply STOPPED.`,
  cancel: `Run the bash command \`sleep 600 && echo ${nonce}\` and reply with its output.`,
  "cloud-restart": `Run the bash command \`sleep 25 && echo ${nonce}\` once, and reply with exactly its output. If it was cut short, check and run it again.`,
};
const task = TASKS[variant] ?? TASKS.main!;

// ---------------------------------------------------------------------------------------------------------------------
// The cloud.
const cookie = await pair();
await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
await wsCall(cookie, "server.updateSettings", {
  patch: {},
  providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
});
const fixture = await ensureCloudFixtureProject(cookie);
const cloudId = ((await (await fetch(new URL("/.well-known/t3/environment", base))).json()) as { environmentId: string }).environmentId;

// The laptop.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-laptop-"));
const laptop = new Laptop({ version, port: 47920 + Math.floor(Math.random() * 50), dir, env: laptopPiEnvironment(dir) });
const lp = laptop.client;
let laptopCookie = "";
const laptopThread = uuid();
let app: McpClient | undefined;
let linkLabel = "";

const laptopProjection = async () => projectionOf(await lp.threadWindow(laptopCookie, laptopThread));
const taskItem = (p: any) => itemsOf(p).find((item: any) => item.type === "subagent" && item.remoteChild !== undefined);

try {
  const descriptor = await laptop.start();
  out.laptop = { environmentId: descriptor.environmentId, serverVersion: descriptor.serverVersion };
  laptopCookie = await laptop.pair();
  await lp.wsCall(laptopCookie, "server.updateSettings", { patch: { linkedEnvironmentsEnabled: true }, providerInstanceMutation: piInstanceMutation() });
  const clone = path.join(dir, "fixture");
  const cloned = spawnSync("gh", ["repo", "clone", FIXTURE, clone, "--", "--depth", "1"], { encoding: "utf8" });
  if (!check("the fixture clones on the laptop", cloned.status === 0, cloned.stderr.slice(-300))) throw new Error("no clone");
  const laptopProject = uuid();
  await lp.mutateProject(laptopCookie, { type: "project.create", commandId: uuid(), projectId: laptopProject, title: "fixture", workspaceRoot: clone, createWorkspaceRootIfMissing: false });

  // The link (stock CLI), and the laptop's outside MCP client (the harness's hands on the laptop side).
  const code = (await mintPairingCode(cookie, { label: `e2e ${stamp}` })).code;
  const linked = laptop.cli(["environment", "link", base.origin, "--pairing-code", code, "--access", "auto-accept-edits"], { allowFailure: true });
  check("t3 environment link", linked.status === 0, linked.stderr.slice(-400));
  linkLabel = /Linked (.+?) \(/.exec(linked.stdout)?.[1] ?? "t3flare";
  const appCode = (await mintPairingCode(laptopCookie, { access: "full-access", label: "harness" }, laptop.url)).code;
  const appToken = (await signIn(appCode, "full-access", { at: laptop.url, peerLink: false })).token;
  app = new McpClient(appToken, { at: laptop.url });

  // The laptop thread asks its agent to delegate.
  await lp.dispatch(laptopCookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId: laptopThread,
    projectId: laptopProject,
    title: `e2e ${variant} ${stamp}`,
    modelSelection: LAPTOP_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  await lp.sendMessage(
    laptopCookie,
    laptopThread,
    [
      `Delegate one task to the linked cloud environment "${linkLabel}" (environmentId ${cloudId}).`,
      `Call orchestrator_capabilities with that environmentId first, then delegate_task with mode "async", isolation unset, and target {"environmentId": "${cloudId}", "providerInstanceId": "piDurable", "model": "anthropic/claude-haiku-5-5"}.`,
      `The task, verbatim: ${JSON.stringify(task)}`,
      "Do not do the task yourself. After delegating, end your turn. When the task's result arrives, reply with the result verbatim.",
    ].join("\n"),
    LAPTOP_MODEL as never,
  );
  log("laptop thread", laptopThread);

  // The remote task appears on the laptop.
  let remote: any;
  for (let tries = 0; tries < 120 && remote === undefined; tries++) {
    const p = await laptopProjection().catch(() => undefined);
    remote = taskItem(p)?.remoteChild;
    if (remote === undefined && p !== undefined && runsOf(p).every((run) => SETTLED.has(run.status)) && runsOf(p).length > 0 && tries > 10) break;
    if (remote === undefined) await sleep(2000);
  }
  out.remoteChild = remote ?? null;
  if (!check("the laptop task has a remoteChild in the cloud", remote?.environmentId === cloudId && typeof remote?.threadId === "string", remote)) throw new Error("no remote task");
  const cloudThread: string = remote.threadId;
  log("cloud thread", cloudThread);

  /** Answers the cloud question from the laptop side: t3_pending_request over the link, as the parent agent could. */
  const answerFromLaptop = async (value: string) => {
    const listed = await app!.call("t3_pending_request", { action: "list", environmentId: cloudId, threadId: cloudThread });
    const requestId: string | undefined = listed.json?.requestIds?.[0];
    const read = requestId === undefined ? undefined : await app!.call("t3_pending_request", { action: "read", environmentId: cloudId, threadId: cloudThread, requestId });
    const questionId: string | undefined = read?.json?.questions?.[0]?.id ?? read?.json?.request?.questions?.[0]?.id;
    const responded = await app!.call("t3_pending_request", { action: "respond", environmentId: cloudId, threadId: cloudThread, requestId, answers: { [questionId ?? ""]: value } });
    return { requestId: requestId ?? null, questionId: questionId ?? null, read: read?.text.slice(0, 300) ?? null, responded: { isError: responded.isError, text: responded.text.slice(0, 200) } };
  };
  const cloudQuestion = (p: any) => pendingOf(p).find((r: any) => r.kind === "user_input");
  const cloudApproval = (p: any) => pendingOf(p).find((r: any) => r.kind !== "user_input");
  const untilCloud = async (done: (p: any) => boolean, timeoutMs = 240_000) => {
    const started = Date.now();
    let p: any;
    while (Date.now() - started < timeoutMs) {
      p = await cloudProjection(cookie, cloudThread).catch(() => p);
      if (p !== undefined && done(p)) return p;
      await sleep(1500);
    }
    return p;
  };
  /** Approves the cloud child's bash as the owner, on the cloud. */
  const approveCloud = async () => {
    const p = await untilCloud((q) => cloudApproval(q) !== undefined || runsOf(q).some((run) => SETTLED.has(run.status) && run.status !== "cancelled"));
    const request = cloudApproval(p);
    if (request !== undefined) await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId: cloudThread, requestId: request.id, decision: "accept" });
    return request;
  };

  const events: Array<unknown> = [];
  if (variant === "main" || variant === "laptop-restart" || variant === "question-restart") {
    const p = await untilCloud((q) => cloudQuestion(q) !== undefined || runsOf(q).some((run) => SETTLED.has(run.status)));
    check("the cloud child asks", cloudQuestion(p) !== undefined, runsOf(p).map((r) => r.status));
    if (variant === "laptop-restart") {
      await laptop.stop();
      events.push("laptop stopped");
      await sleep(10_000);
      await laptop.start();
      laptopCookie = await laptop.pair();
      app = new McpClient(appToken, { at: laptop.url });
      events.push("laptop started again");
    }
    if (variant === "question-restart") {
      await admin("POST", "/_t3flare/restart");
      events.push("cloud Environment restarted while the question waited");
      await sleep(8000);
      await untilCloud((q) => cloudQuestion(q) !== undefined && cloudQuestion(q).responseCapability?.type === "live", 180_000);
    }
    events.push({ answer: await answerFromLaptop("yes") });
    events.push({ approved: (await approveCloud())?.kind ?? null });
  } else if (variant === "cancel") {
    events.push({ approved: (await approveCloud())?.kind ?? null });
    await untilCloud((q) => itemsOf(q).some((item: any) => item.type === "command_execution" && item.status === "running"), 120_000);
    await sleep(3000);
    await lp.sendMessage(laptopCookie, laptopThread, "Cancel the delegated task now with task_cancel, then reply CANCELLED.", LAPTOP_MODEL as never);
    events.push("asked the laptop agent to task_cancel");
  } else if (variant === "cloud-restart") {
    events.push({ approved: (await approveCloud())?.kind ?? null });
    await untilCloud((q) => itemsOf(q).some((item: any) => item.type === "command_execution" && item.status === "running"), 120_000);
    await sleep(5000);
    await admin("POST", "/_t3flare/restart");
    events.push("cloud Environment restarted while bash ran");
    // The continuation may run the command again, which asks again.
    for (let n = 0; n < 3; n++) {
      const request = await approveCloud();
      if (request === undefined) break;
      events.push({ approvedAgain: request.kind });
    }
  } else if (variant === "revoked") {
    await untilCloud((q) => cloudQuestion(q) !== undefined, 180_000);
    const access = (await wsFirst(cookie, "subscribeAuthAccess", {})) as any;
    const session = JSON.stringify(access).match(/"sessionId":"([^"]+)"[^{}]*"label":"[^"]*Ian[^"]*"/);
    const sessions: Array<any> = [];
    const walk = (value: any) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        if (typeof value.sessionId === "string" && /peer|link|laptop|macbook/i.test(JSON.stringify(value))) sessions.push(value);
        Object.values(value).forEach(walk);
      }
    };
    walk(access);
    const target = sessions.find((s) => (s.client?.label ?? s.label ?? "").length > 0) ?? (session ? { sessionId: session[1] } : undefined);
    const revoked = target === undefined ? { status: 0 } : await fetch(new URL("/api/auth/clients/revoke", base), { method: "POST", headers: { cookie, origin: base.origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: target.sessionId }) });
    events.push({ revoked: revoked.status, label: target?.client?.label ?? target?.label ?? null });
  }
  out.events = events;

  // The laptop task settles; the parent wakes with the result.
  const started = Date.now();
  let lpProj: any;
  let item: any;
  while (Date.now() - started < 12 * 60_000) {
    lpProj = await laptopProjection().catch(() => lpProj);
    item = taskItem(lpProj);
    const runs = runsOf(lpProj);
    if (item?.result != null && runs.length >= 2 && runs.every((run) => SETTLED.has(run.status))) break;
    await sleep(3000);
  }
  const replies = itemsOf(lpProj).filter((i: any) => i.type === "assistant_message").map((i: any) => String(i.text ?? ""));
  out.laptopTask = { status: item?.status ?? null, result: String(item?.result ?? "").slice(0, 400), remoteChild: item?.remoteChild ?? null, runs: runsOf(lpProj).map((r) => r.status), lastReply: replies.at(-1)?.slice(0, 300) ?? null };
  const cloudFinal = await cloudProjection(cookie, cloudThread);
  out.cloudThread = {
    threadId: cloudThread,
    runs: runsOf(cloudFinal).map((r: any) => ({ status: r.status, continuation: r.restartContinuationOfRunId !== undefined })),
    linkOrigin: cloudFinal?.thread?.linkOrigin ?? null,
    delegatedFrom: cloudFinal?.thread?.delegatedFrom ?? null,
    runtimeMode: cloudFinal?.thread?.runtimeMode ?? null,
    commands: itemsOf(cloudFinal).filter((i: any) => i.type === "command_execution").map((i: any) => ({ input: String(i.input).slice(0, 80), status: i.status, exitCode: i.exitCode ?? null })),
  };
  check("the cloud thread carries the link's origin and the laptop thread it came from", cloudFinal?.thread?.linkOrigin?.access === "auto-accept-edits" && cloudFinal?.thread?.delegatedFrom?.threadId === laptopThread, out.cloudThread);
  if (variant === "cancel") {
    check("cancel: the laptop task ends cancelled", ["cancelled", "interrupted"].includes(item?.status), out.laptopTask);
    check("cancel: the cloud run stopped", runsOf(cloudFinal).every((run: any) => SETTLED.has(run.status)) && runsOf(cloudFinal).some((run: any) => run.status !== "completed"), out.cloudThread);
    const probe = (await admin("POST", `/_t3flare/agents/workspace-call?id=${fixture.workspaceRoot.slice(3)}`, { exec: { script: "ps -eo args | grep -c '[s]leep 600' || true" } })).json;
    out.sleepsLeft = String(probe?.result?.stdout ?? "").trim();
    check("cancel: the cloud child's sleep was killed", out.sleepsLeft === "0", out.sleepsLeft);
  } else if (variant === "revoked") {
    check("revoked: the laptop task fails naming the revocation", item?.status === "failed" && /revok|no longer accepts|link it again/i.test(String(item?.result)), out.laptopTask);
  } else {
    check("the laptop task completes with the cloud child's result", item?.status === "completed" && String(item?.result).includes(nonce), out.laptopTask);
    check("the laptop parent wakes with the result", replies.some((text) => text.includes(nonce)) && runsOf(lpProj).length >= 2, out.laptopTask);
  }
  if (variant === "main" && process.argv.includes("--leak")) {
    const leak = (await admin("POST", "/_t3flare/check/peer-leak", { workspace: fixture.workspaceRoot.slice(3), threads: [cloudThread], extra: [] })).json;
    out.leak = leak;
    check("F8: no secret in the Container or the Session's state after a delegated task", leak?.leaked === 0 && leak?.credentialsFound >= 0, leak);
  }
} catch (error) {
  failures.push(`threw: ${String(error).slice(0, 600)}`);
} finally {
  await laptop.stop();
  out.laptopLog = laptop.logFile;
  out.failures = failures;
  out.ok = failures.length === 0;
  writeEvidence(outFile, out);
  console.log(JSON.stringify(out, null, 1).slice(0, 8000));
}
process.exit(failures.length === 0 ? 0 : 1);
