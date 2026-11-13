// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off
// The parity batch's stage harness (docs/steps/parity-batch.md): G7 (the PR review guide), G4 (scratch threads), G12
// (task webhooks and the PR watch's wake), and the W† rows of docs/parity.md, each through t3's own client protocol as
// the web client sends it. Evidence goes to docs/steps/parity-batch/<part>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run pbatch pbatch <part> [args]
//   parts: guide [pr] | scratch | webhook | schedule | prwatch-start [pr] | prwatch-check | threads | queue | keys | mcp | devices | notify
import * as fs from "node:fs";
import * as path from "node:path";

import { enable as enableCli, ensureProject } from "./lib/cliTurn.ts";
import { admin, base, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall, wsFirst } from "./lib/client.ts";
import { findSession } from "./lib/peerAcceptance.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/parity-batch");
const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const PROJECT = "pbatch-fixture";
const DURABLE = { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5", options: [] };
const CODEX = { instanceId: "codex", model: "gpt-6-luna", options: [] };
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

const SECRET_KEYS = /token|authorization|cookie|secret|handle|bearer|credential|csrf|code_verifier/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  // A hook URL carries its token: keep its shape only.
  return typeof value === "string" ? value.replace(/(\/api\/hooks\/[^/\s"]+\/)[A-Za-z0-9_-]{8,}/g, "$1[token]") : value;
};

const writeEvidence = (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), `${JSON.stringify(redact({ at: new Date().toISOString(), host: base.host, ...value }), null, 1)}\n`);
  console.log(`${name}: ${value.ok === true ? "PASS" : "FAIL"} -> docs/steps/parity-batch/${name}.json`);
  if (value.ok !== true) process.exitCode = 1;
};

const [part, ...args] = process.argv.slice(2);
const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
// The Durable agent provider, enabled as the owner does in Settings (p1100's `enableAgent`).
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });

const projection = async (threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
const settle = async (threadId: string, ordinal: number, timeoutMs = 8 * 60_000): Promise<any> => {
  const started = Date.now();
  let current: any;
  while (Date.now() - started < timeoutMs) {
    current = await projection(threadId);
    for (const request of (current?.runtimeRequests ?? []).filter((r: any) => r.status === "pending")) {
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(current);
    if (runs.some((run: any) => run.ordinal >= ordinal) && runs.every((run) => SETTLED.has(run.status))) return current;
    await sleep(1500);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run: any) => run.status))}`);
};
const lastAnswer = (view: any) => String(itemsOf(view).filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "");
const shell = async (): Promise<any> => wsFirst(cookie, "orchestration.subscribeShell", {});
const findIn = (value: unknown, pred: (record: any) => boolean): any => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIn(item, pred);
      if (found !== undefined) return found;
    }
  } else if (value !== null && typeof value === "object") {
    if (pred(value)) return value;
    for (const child of Object.values(value)) {
      const found = findIn(child, pred);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};
const threadInShell = async (threadId: string) => findIn(await shell(), (record) => record.id === threadId && typeof record.projectId === "string");
const health = async () => (await admin("GET", "/_t3flare/health")).json;
const routerTrace = async () => ((await admin("GET", "/_t3flare/agents/router-trace")).json as any)?.entries;
const launch = (projectId: string, model: unknown, text: string, workspaceStrategy: unknown = { type: "root" }) => {
  const threadId = uuid();
  return wsCall(cookie, "orchestration.launchThread", {
    commandId: uuid(),
    creationSource: "web",
    threadId,
    projectId,
    title: `pbatch ${part}`,
    generateTitle: false,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy,
    initialMessage: { messageId: uuid(), text, attachments: [] },
  }).then(() => threadId);
};
const readFile = async (cwd: string, relativePath: string): Promise<string | null> => {
  const read = (await wsCall(cookie, "projects.readFile", { cwd, relativePath, allowMissing: true }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  return read?.exists === false ? null : typeof read?.contents === "string" ? read.contents.trim() : `error: ${read?.error}`;
};

switch (part) {
  // G7: the review guide of an open fixture PR, written by Codex from a scratch checkout in the project's Container.
  case "guide": {
    const number = Number(args[0] ?? "4");
    const model = { ...CODEX, model: args[1] ?? CODEX.model };
    const { projectId, root } = await ensureProject(cookie, PROJECT);
    await enableCli(cookie, "codex", "codex");
    await wsCall(cookie, "server.updateSettings", { patch: { reviewGuidesEnabled: true, reviewGuideModelSelection: model } });
    await admin("GET", "/_t3flare/agents/router-trace?clear=1").catch(() => undefined);
    const ref = { projectId, repository: FIXTURE, number };
    const started = Date.now();
    const generated = await wsCall(cookie, "pullRequests.generateReviewGuide", ref).catch((error: unknown) => ({ error: String(error).slice(0, 800) }));
    let result: any = generated;
    while (Date.now() - started < 20 * 60_000) {
      result = await wsCall(cookie, "pullRequests.reviewGuide", ref).catch((error: unknown) => ({ error: String(error).slice(0, 800) }));
      if (result?.error !== undefined || result?.guide != null || result?.run?._tag === "Failed") break;
      await sleep(10_000);
    }
    const trace = (await routerTrace()) as Array<any>;
    const scratch = Array.isArray(trace) ? trace.filter((entry) => entry.route === "scratch" || entry.command === "codex" || String(entry.argv).includes("worktree")) : trace;
    const guide = result?.guide ?? null;
    writeEvidence("guide", {
      ok: guide !== null && Array.isArray(scratch) && scratch.some((entry) => String(entry.argv).includes("--detach")),
      project: root,
      pullRequest: `${FIXTURE}#${number}`,
      model,
      ms: Date.now() - started,
      generated,
      run: result?.run ?? null,
      error: result?.error ?? null,
      guide: guide === null ? null : JSON.stringify(guide).slice(0, 6000),
      guideBytes: guide === null ? 0 : JSON.stringify(guide).length,
      trace: scratch,
    });
    break;
  }

  // G4: the No project folder is a Workspace; a Durable and a Codex scratch thread write in their own folders; one becomes a project.
  case "scratch": {
    const ensured = (await wsCall(cookie, "projects.ensureScratch", {})) as any;
    const projectId = ensured.projectId;
    const project = findIn(await shell(), (record) => record.id === projectId && typeof record.workspaceRoot === "string");
    const config = (await wsCall(cookie, "server.getConfig", {}).catch(() => undefined)) as any;
    await enableCli(cookie, "codex", "codex");
    const results: Record<string, any> = {};
    for (const [agent, model] of [["durable", DURABLE], ["codex", CODEX]] as const) {
      const word = `scratch-${agent}-ok`;
      const threadId = await launch(projectId, model, `Create a file named hello.txt in the current working directory containing exactly \`${word}\`. Then run \`pwd\` and reply with its output only.`);
      const view = await settle(threadId, 1, 10 * 60_000).catch((error: unknown) => ({ error: String(error) }));
      const thread = await threadInShell(threadId);
      const folder: string | null = thread?.worktreePath ?? (view as any)?.thread?.worktreePath ?? null;
      const contents = folder === null ? null : await readFile(folder, "hello.txt");
      results[agent] = { threadId, folder, contents, ok: folder !== null && folder.startsWith("/w/t3-scratch/") && contents === word, answer: lastAnswer(view).slice(0, 300), runs: runsOf(view).map((r: any) => r.status) };
    }
    // "Turn into project" (ScratchThreadPromotion), on the Durable thread.
    const promoted = (await wsCall(cookie, "projects.createFromThread", { threadId: results.durable.threadId }).catch((error: unknown) => ({ error: String(error).slice(0, 500) }))) as any;
    const newProject = promoted?.projectId === undefined ? undefined : findIn(await shell(), (record) => record.id === promoted.projectId && typeof record.workspaceRoot === "string");
    const movedThread = await threadInShell(results.durable.threadId);
    const workspaces = (await admin("GET", "/_t3flare/agents/workspaces")).json;
    writeEvidence("scratch", {
      ok:
        project?.workspaceRoot === "/w/t3-scratch" &&
        results.durable.ok &&
        results.codex.ok &&
        newProject?.workspaceRoot === results.durable.folder &&
        movedThread?.projectId === promoted.projectId &&
        config?.capabilities?.threadProjectFromScratch !== false,
      scratchProject: { id: projectId, workspaceRoot: project?.workspaceRoot, title: project?.title },
      scratchWorkspaceRoot: config?.scratchWorkspaceRoot ?? null,
      results,
      promotion: { promoted, workspaceRoot: newProject?.workspaceRoot ?? null, threadProject: movedThread?.projectId ?? null },
      workspace: findIn(workspaces, (record) => record.id === "t3-scratch") ?? null,
    });
    break;
  }

  // G12: a webhook task's URL is on the public t3 host, and a POST to it runs the task.
  case "webhook": {
    const { projectId } = await ensureProject(cookie, PROJECT);
    const saved = (await wsCall(cookie, "scheduledTasks.upsert", {
      title: "pbatch webhook",
      prompt: "Reply with the single word HOOKED.",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: DURABLE,
      runtimeMode: "full-access",
      interactionMode: "default",
    })) as any;
    const task = saved?.task ?? findIn(saved, (record) => typeof record.id === "string" && "schedule" in record);
    const url: string | null = task?.webhook?.url ?? null;
    const posted = url === null ? null : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "pbatch" }) });
    const postAnswer = posted === null ? null : { status: posted.status, body: (await posted.text()).slice(0, 300) };
    let after: any;
    const started = Date.now();
    while (Date.now() - started < 5 * 60_000) {
      const list = (await wsFirst(cookie, "scheduledTasks.subscribe", {})) as any;
      after = (list?.tasks ?? []).find((t: any) => t.id === task?.id);
      if (after?.runCount > 0 && after?.lastRunStatus !== "running") break;
      await sleep(5000);
    }
    const deliveries = task?.id === undefined ? null : await wsCall(cookie, "scheduledTasks.listWebhookDeliveries", { id: task.id }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
    const threadId = after?.threadId ?? null;
    const view = threadId === null ? undefined : await settle(threadId, 1, 5 * 60_000).catch(() => undefined);
    await wsCall(cookie, "scheduledTasks.delete", { id: task?.id }).catch(() => undefined);
    writeEvidence("webhook", {
      ok: url !== null && url.startsWith(`https://${base.host}/api/hooks/`) && postAnswer !== null && postAnswer.status < 300 && after?.runCount > 0 && after?.lastRunStatus === "succeeded",
      url,
      path: task?.webhook?.path ?? null,
      post: postAnswer,
      task: after ?? task,
      deliveries,
      answer: view === undefined ? null : lastAnswer(view).slice(0, 200),
    });
    break;
  }

  // W†: a scheduled task fires through the alarm. A once-task due in 3 minutes, the Environment forced to reset, the
  // alarm boots it at the task's time and t3 runs the task.
  case "schedule": {
    const { projectId } = await ensureProject(cookie, PROJECT);
    const runAt = new Date(Date.now() + 3 * 60_000);
    const saved = (await wsCall(cookie, "scheduledTasks.upsert", {
      title: "pbatch alarm",
      prompt: "Reply with the single word ALARMED.",
      enabled: true,
      schedule: { type: "once", runAt: runAt.toISOString().replace("Z", "+00:00") },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: DURABLE,
      runtimeMode: "full-access",
      interactionMode: "default",
    })) as any;
    const task = saved?.task ?? findIn(saved, (record) => typeof record.id === "string" && "schedule" in record);
    const timeline: Array<any> = [];
    const snap = async (label: string) => {
      const h = await health();
      timeline.push({ label, at: new Date().toISOString(), runtime: h.runtime, alarm: h.alarm, lastBoot: h.lastBoot, constructedAt: h.object?.constructedAt, nextDue: h.nextDue });
    };
    await sleep(65_000);
    const idle = (await admin("POST", "/_t3flare/idle-check")).json;
    timeline.push({ label: "idle-check", verdict: { reset: idle?.reset, why: idle?.why, alarm: idle?.alarm } });
    await sleep(3000);
    await snap("after reset");
    while (Date.now() < runAt.getTime() + 4 * 60_000) {
      const h = await health();
      if (h.runtime === "running" && h.lastBoot?.trigger === "alarm") break;
      await sleep(15_000);
    }
    await snap("after alarm");
    let after: any;
    for (let i = 0; i < 24; i++) {
      const list = (await wsFirst(cookie, "scheduledTasks.subscribe", {})) as any;
      after = (list?.tasks ?? []).find((t: any) => t.id === task?.id);
      if (after?.runCount > 0) break;
      await sleep(5000);
    }
    writeEvidence("schedule", {
      ok: timeline.some((entry) => entry.verdict?.reset === true) && timeline.at(-1)?.lastBoot?.trigger === "alarm" && after?.runCount > 0,
      runAt: runAt.toISOString(),
      timeline,
      task: after ?? task,
    });
    await wsCall(cookie, "scheduledTasks.delete", { id: task?.id }).catch(() => undefined);
    break;
  }

  // G12: PR watch. A thread watches an open fixture PR; the forced reset leaves a PR-watch wake 10 minutes out.
  case "prwatch-start": {
    const number = Number(args[0] ?? "4");
    const { projectId } = await ensureProject(cookie, PROJECT);
    const threadId = uuid();
    await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: "pbatch prwatch", modelSelection: DURABLE, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
    const watched = await dispatch(cookie, {
      type: "thread.pull-request.watch",
      commandId: uuid(),
      threadId,
      host: "github.com",
      repository: FIXTURE,
      number,
      watching: true,
      link: { url: `https://github.com/${FIXTURE}/pull/${number}`, source: "manual" },
    }).then(() => "ok", (error: unknown) => String(error).slice(0, 500));
    await sleep(65_000);
    const before = await health();
    const idle = (await admin("POST", "/_t3flare/idle-check")).json;
    await sleep(3000);
    const after = await health();
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, "prwatch-state.json"), JSON.stringify({ threadId, number, resetAt: new Date().toISOString() }));
    writeEvidence("prwatch-start", {
      ok: watched === "ok" && idle?.reset === true && typeof after.prWatch?.wake === "string" && after.alarm === after.prWatch.wake,
      threadId,
      watched,
      watchedBefore: before.prWatch,
      idle: { reset: idle?.reset, why: idle?.why, alarm: idle?.alarm, sources: idle?.due?.sources },
      after: { runtime: after.runtime, alarm: after.alarm, prWatch: after.prWatch },
    });
    break;
  }

  // G12: after the wake, t3 was booted by the alarm (with no client) and the reactor read the PR.
  case "prwatch-check": {
    const state = JSON.parse(fs.readFileSync(path.join(EVIDENCE, "prwatch-state.json"), "utf8"));
    // The admin health read neither boots t3 nor counts as activity; it is read before any client call.
    const h = await health();
    const thread = await threadInShell(state.threadId);
    const link = (thread?.pullRequests ?? []).find((pr: any) => pr.number === state.number);
    writeEvidence("prwatch-check", {
      ok: h.lastBoot?.trigger === "alarm" && Date.parse(h.lastBoot?.at ?? h.lastBoot?.startedAt ?? "0") > Date.parse(state.resetAt) && link?.watch !== undefined,
      resetAt: state.resetAt,
      health: { runtime: h.runtime, alarm: h.alarm, lastBoot: h.lastBoot, prWatch: h.prWatch, nextDue: h.nextDue },
      link: link === undefined ? null : { watch: link.watch, snapshot: link.snapshot },
    });
    break;
  }

  // W†: delete, pin, snooze and tags on a thread, read back from t3's shell.
  case "threads": {
    const { projectId } = await ensureProject(cookie, PROJECT);
    const threadId = uuid();
    await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: "pbatch threads", modelSelection: DURABLE, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
    const step = async (command: Record<string, unknown>) =>
      dispatch(cookie, { commandId: uuid(), threadId, ...command }).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: String(error).slice(0, 300) }));
    const view = (thread: any) => thread === undefined ? null : { pinnedAt: thread.pinnedAt ?? thread.pin ?? null, tags: thread.tags ?? null, snoozedUntil: thread.snoozedUntil ?? null, deletedAt: thread.deletedAt ?? null };
    const steps: Record<string, any> = {};
    steps.pin = { ...(await step({ type: "thread.pin" })), thread: view(await threadInShell(threadId)) };
    steps.tag = { ...(await step({ type: "thread.tag.set", tag: "pbatch", tagged: true })), thread: view(await threadInShell(threadId)) };
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    steps.snooze = { ...(await step({ type: "thread.snooze", snoozedUntil: until })), thread: view(await threadInShell(threadId)) };
    steps.unsnooze = { ...(await step({ type: "thread.unsnooze", reason: "user" })), thread: view(await threadInShell(threadId)) };
    steps.untag = { ...(await step({ type: "thread.tag.set", tag: "pbatch", tagged: false })), thread: view(await threadInShell(threadId)) };
    steps.unpin = { ...(await step({ type: "thread.unpin" })), thread: view(await threadInShell(threadId)) };
    steps.delete = { ...(await step({ type: "thread.delete" })), thread: view(await threadInShell(threadId)) };
    const ok =
      Object.values(steps).every((s) => s.ok) &&
      steps.pin.thread?.pinnedAt != null &&
      JSON.stringify(steps.tag.thread?.tags ?? []).includes("pbatch") &&
      steps.snooze.thread?.snoozedUntil != null &&
      steps.unsnooze.thread?.snoozedUntil == null &&
      !JSON.stringify(steps.untag.thread?.tags ?? []).includes("pbatch") &&
      steps.unpin.thread?.pinnedAt == null &&
      (steps.delete.thread === null || steps.delete.thread?.deletedAt != null);
    writeEvidence("threads", { ok, threadId, steps });
    break;
  }

  // W†: queued messages. A second message queued after an active run starts when the first ends; a queue paused by a
  // stop resumes with `queue.resume`.
  case "queue": {
    const { projectId } = await ensureProject(cookie, PROJECT);
    const threadId = await launch(projectId, DURABLE, "Run the shell command `sleep 20 && echo first-done`, then reply with its output only.");
    await sleep(4000);
    await sendMessage(cookie, threadId, "Reply with the single word SECOND.", DURABLE, { dispatchMode: { type: "queue_after_active" } });
    const queuedSeen = runsOf(await projection(threadId)).map((r: any) => ({ ordinal: r.ordinal, status: r.status }));
    const first = await settle(threadId, 2, 6 * 60_000).catch((error: unknown) => ({ error: String(error) }));
    const answers1 = itemsOf(first).filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "").slice(0, 120));
    // Stop with a queued message behind the active run: t3 pauses the queue; queue.resume starts it.
    await sendMessage(cookie, threadId, "Run the shell command `sleep 30`, then reply DONE.", DURABLE);
    await sleep(5000);
    await sendMessage(cookie, threadId, "Reply with the single word THIRD.", DURABLE, { dispatchMode: { type: "queue_after_active" } });
    await sleep(1500);
    await dispatch(cookie, { type: "thread.stop", commandId: uuid(), threadId });
    await sleep(8000);
    const paused = await projection(threadId);
    const pausedRuns = runsOf(paused).map((r: any) => ({ ordinal: r.ordinal, status: r.status }));
    const resumed = await dispatch(cookie, { type: "queue.resume", commandId: uuid(), threadId }).then(() => "ok", (error: unknown) => String(error).slice(0, 300));
    const last = await settle(threadId, 4, 5 * 60_000).catch((error: unknown) => ({ error: String(error) }));
    const answers = itemsOf(last).filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "").slice(0, 120));
    writeEvidence("queue", {
      ok: answers1.some((a: string) => a.includes("SECOND")) && answers.some((a: string) => a.includes("THIRD")),
      threadId,
      queuedSeen,
      answersAfterQueue: answers1,
      pausedRuns,
      queueState: paused?.thread?.queue ?? paused?.queue ?? null,
      resumed,
      runs: runsOf(last).map((r: any) => ({ ordinal: r.ordinal, status: r.status })),
      answers,
    });
    break;
  }

  // W†: keybindings saved on the server (t3's keybindings file in the State directory), read back, removed.
  case "keys": {
    const rule = { key: "mod+alt+9", command: "modelPicker.jump.1" };
    const upserted = (await wsCall(cookie, "server.upsertKeybinding", rule).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
    const config = (await wsCall(cookie, "server.getConfig", {})) as any;
    const has = (value: unknown) => JSON.stringify(value ?? null).includes('"mod+alt+9"') || JSON.stringify(value ?? null).includes("modelPicker.jump.1\",\"shortcut");
    const inConfig = findIn(config?.keybindings, (record) => record.command === rule.command && JSON.stringify(record).includes("9"));
    // After a restart in place, the file is still there.
    await admin("POST", "/_t3flare/restart");
    await sleep(5000);
    const reread = (await wsCall(cookie, "server.getConfig", {})) as any;
    const survived = findIn(reread?.keybindings, (record) => record.command === rule.command && JSON.stringify(record).includes("9"));
    const removed = (await wsCall(cookie, "server.removeKeybinding", rule).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
    const gone = findIn(removed?.keybindings, (record) => record.command === rule.command && JSON.stringify(record).includes("9"));
    writeEvidence("keys", {
      ok: upserted?.error === undefined && inConfig !== undefined && survived !== undefined && gone === undefined,
      rule,
      upsertIssues: upserted?.issues ?? upserted?.error,
      inConfig,
      survivedRestart: survived,
      removed: removed?.error ?? (gone === undefined ? "gone" : gone),
      sawAnywhere: has(config),
    });
    break;
  }

  // W†: /mcp for an outside agent. An app registers (not a Peer link), the owner approves with a pairing code bound to
  // a level, the app exchanges its code for a bearer and lists and calls t3's tools; revoking its session ends access.
  case "mcp": {
    const discovery = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", base)).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const server = await fetch(new URL("/.well-known/oauth-authorization-server", base)).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const unauthenticated = await fetch(new URL("/mcp", base), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    const { code } = await mintPairingCode(cookie, { access: "approval-required", label: "pbatch outside agent" });
    const signed = await signIn(code, "approval-required", { peerLink: false, clientName: "pbatch outside agent" });
    const mcp = new McpClient(signed.token);
    const init = await mcp.initialize();
    const tools = await mcp.listTools();
    const call = await mcp.request("tools/call", { name: "t3_project_list", arguments: {} });
    const access = (await wsFirst(cookie, "subscribeAuthAccess", {})) as any;
    const session = findSession(access, "pbatch outside agent");
    const revoked = session === undefined ? null : await fetch(new URL("/api/auth/clients/revoke", base), { method: "POST", headers: { cookie, origin: base.origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.sessionId }) });
    const after = await mcp.raw({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
    writeEvidence("mcp", {
      ok: discovery.status === 200 && unauthenticated.status === 401 && init.status === 200 && tools.length > 0 && call.status === 200 && call.message?.error === undefined && revoked?.status === 200 && after.status === 401,
      discovery,
      authorizationServer: { status: server.status, issuer: server.json?.issuer, endpoints: [server.json?.authorization_endpoint, server.json?.token_endpoint, server.json?.registration_endpoint] },
      unauthenticated: unauthenticated.status,
      scope: signed.scope,
      initialize: init.status,
      tools: tools.map((t) => t.name),
      call: { status: call.status, isError: call.message?.result?.isError ?? null, text: String(call.message?.result?.content?.[0]?.text ?? call.message?.error?.message ?? "").slice(0, 400) },
      listedSession: session === undefined ? null : { label: session.label ?? session.clientName ?? null, method: session.method ?? null },
      revoke: revoked?.status ?? null,
      afterRevoke: after.status,
    });
    break;
  }

  // W†: a second device pairs by a pairing link minted by the first, both sessions are listed, the first revokes the
  // second, whose next request is refused.
  case "devices": {
    const { code } = await mintPairingCode(cookie, { label: "pbatch second device" });
    const paired = await fetch(new URL("/api/auth/browser-session", base), { method: "POST", headers: { "content-type": "application/json", origin: base.origin }, body: JSON.stringify({ credential: code }) });
    const second = paired.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const secondSession = await fetch(new URL("/api/auth/session", base), { headers: { cookie: second } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const access = (await wsFirst(cookie, "subscribeAuthAccess", {})) as any;
    const sessions = findIn(access, (record) => Array.isArray(record.clientSessions)) ?? access;
    const listed = findSession(access, "pbatch second device");
    const secondWs = await wsCall(second, "server.getConfig", {}).then(() => "ok", (error: unknown) => String(error).slice(0, 200));
    const revoked = listed === undefined ? null : await fetch(new URL("/api/auth/clients/revoke", base), { method: "POST", headers: { cookie, origin: base.origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: listed.sessionId }) });
    const afterRevoke = await fetch(new URL("/api/auth/session", base), { headers: { cookie: second } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const firstStill = await fetch(new URL("/api/auth/session", base), { headers: { cookie } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    writeEvidence("devices", {
      ok: paired.status === 200 && secondSession.json?.authenticated === true && secondWs === "ok" && listed !== undefined && revoked?.status === 200 && afterRevoke.json?.authenticated !== true && firstStill.json?.authenticated === true,
      pairStatus: paired.status,
      secondAuthenticated: secondSession.json?.authenticated,
      secondWs,
      listed: listed === undefined ? null : { label: listed.label ?? null, method: listed.method ?? listed.sessionMethod ?? null },
      sessionCount: Array.isArray(sessions?.clientSessions) ? sessions.clientSessions.length : null,
      revoke: revoked?.status ?? null,
      secondAfterRevoke: afterRevoke.json?.authenticated ?? afterRevoke.status,
      firstStillAuthenticated: firstStill.json?.authenticated,
    });
    break;
  }

  // W† (client-side): what browser notifications need from the Environment. The web client is served over HTTPS (a
  // secure context, required by the Notification API), its notification sounds load, and a finished run reaches the
  // client's shell stream as the state change the client notifies on.
  case "notify": {
    // The deployed web build is this checkout's dist/web (stage.ts deploys it); its sounds are fetched from the host.
    const index = await fetch(new URL("/", base)).then(async (r) => ({ status: r.status, text: await r.text() }));
    const assetsDir = path.resolve(import.meta.dirname, "../dist/web/assets");
    const names = fs.readdirSync(assetsDir);
    const all = names.filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(assetsDir, name), "utf8")).join("\n");
    const assets = names.filter((name) => /^notification-(completion|input)-.*\.mp3$/.test(name)).map((name) => `/assets/${name}`);
    const fetched = await Promise.all(assets.map((asset) => fetch(new URL(asset, base)).then((r) => ({ asset, status: r.status, type: r.headers.get("content-type") }))));
    const { projectId } = await ensureProject(cookie, PROJECT);
    const threadId = await launch(projectId, DURABLE, "Reply with the single word DING.");
    const view = await settle(threadId, 1, 4 * 60_000).catch((error: unknown) => ({ error: String(error) }));
    const thread = await threadInShell(threadId);
    writeEvidence("notify", {
      ok: base.protocol === "https:" && index.status === 200 && fetched.length > 0 && fetched.every((f) => f.status === 200) && all.includes("requestPermission") && runsOf(view).some((r: any) => r.status === "completed"),
      secureContext: base.protocol === "https:",
      notificationApiInBundle: all.includes("Notification.requestPermission") || all.includes("requestPermission"),
      sounds: fetched,
      run: runsOf(view).map((r: any) => r.status),
      shellThread: thread === undefined ? null : { latestRunStatus: thread.latestRun?.status ?? thread.status ?? null, keys: Object.keys(thread).slice(0, 40) },
    });
    break;
  }

  default:
    console.error("usage: pbatch <guide|scratch|webhook|schedule|prwatch-start|prwatch-check|threads|queue|keys|mcp|devices|notify> [args]");
    process.exitCode = 2;
}
process.exit();
