// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off globalTimers:off
// The acceptance test's Peer link part (step 3, `scripts/acceptance.ts --peer`): the harness plays the laptop
// (`lib/peer.ts`, t3's `PeerLinks.signIn` and `PeerMcpClient` in TypeScript) against the stage, and proves the link
// contract and the link fence at the MCP level (plan section 5.3):
//
//   - a link with a plain pairing code; the cap a code's scopes put on the access a link may take (review C5);
//   - a forwarded `t3_thread_launch` on the Durable agent, followed in 50 s waits, its last reply read back;
//   - F5: a link at auto-accept-edits caps a full-access caller: the cloud thread's `bash` waits for approval, and a
//     50 s wait on it times out as a wait (workerd holds it);
//   - F7: `t3_pending_request respond` through the link cannot answer the child's approval; the owner's answer can;
//   - F6: `T3-Mode-Limit: approval-required/plan` runs the thread in plan: `write` is refused, `bash` asks;
//   - F1, F2: an auto-accept-edits link may not change the owner's threads, projects, settings or schedules;
//   - F4: a worktree launch through the link provisions and skips the project's setup script (`skipped-for-link`);
//   - F12: the same F1 calls through a full-access link are allowed (t3's documented exception);
//   - F10: Linked environments off answers 403, and on again the link works;
//   - F9: revoking the link's client in the cloud answers 401.
// F11 (the bootstrap token at `/oauth/mcp/decision`) runs in `acceptance.ts` around the Pairing window.
import { base, dispatch, mutateProject, projectionOf, runsOf, SETTLED, sleep, threadWindow, updateSettings, uuid, wsCall, wsFirst } from "./client.ts";
import { ensureCloudFixtureProject } from "./fixtureProject.ts";
import { decide, McpClient, mintPairingCode, registerPeerClient, signIn, type ToolAnswer, WAIT_CHUNK_MS } from "./peer.ts";

const MODEL = { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5" };

export interface PeerReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

/** A refusal t3's link fence answers: `capability_denied`, naming the link. */
const denied = (answer: ToolAnswer) => answer.isError && /capability_denied|linked environment|link/i.test(answer.text);

export const peerAcceptance = async (cookie: string, options: { readonly only?: ReadonlySet<string> } = {}): Promise<PeerReport> => {
  const failures: Array<string> = [];
  const report: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
    return ok;
  };
  const wants = (row: string) => options.only === undefined || options.only.has(row);
  const stamp = Date.now().toString(36);

  await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
  await wsCall(cookie, "server.updateSettings", {
    patch: {},
    providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
  });
  const fixture = await ensureCloudFixtureProject(cookie);
  report.fixture = fixture;

  // The link, with a plain pairing code (t3 refuses an access-bound code for a link, McpOAuth.approve).
  const clientName = `t3flare acceptance ${stamp}`;
  const link = await signIn((await mintPairingCode(cookie, { label: `acceptance ${stamp}` })).code, "auto-accept-edits", { clientName });
  report.link = { scope: link.scope };
  check("an auto-accept-edits link holds orchestration read and operate only", link.scope === "orchestration:read orchestration:operate", link.scope);
  const mcp = new McpClient(link.token, { modeLimit: "full-access/default" });

  // The cap (review C5): a plain code minted with read and operate only cannot sign a full-access link, and is not spent.
  if (wants("cap")) {
    const capped = (await mintPairingCode(cookie, { label: `capped ${stamp}`, scopes: ["orchestration:read", "orchestration:operate"] })).code;
    const registered = await registerPeerClient(`capped ${stamp}`);
    const clientId = (registered.body as { client_id: string }).client_id;
    const full = await decide(clientId, capped, "full-access");
    const edits = await decide(clientId, capped, "auto-accept-edits");
    report.cap = { fullAccess: full.answer, autoAcceptEdits: edits.answer.status };
    check("a code without settings and source-control scopes cannot link at full access", full.answer.status === 400 && /cannot grant this access/.test(JSON.stringify(full.answer.body)), full.answer);
    check("the same code, unspent, links at auto-accept-edits", edits.answer.status === 200, edits.answer);
  }

  /** Launches a thread on the stage through the link. */
  const launch = (title: string, message: string, extra: Record<string, unknown> = {}) =>
    mcp.call("t3_thread_launch", { projectId: fixture.projectId, title: `${title} ${stamp}`, message, modelSelection: MODEL, clientRequestId: `${title}-${stamp}`, ...extra });
  const threadOf = (answer: ToolAnswer): string | undefined => answer.json?.threadId;
  /** The cloud thread's projection, as the owner's client reads it. */
  const cloud = async (threadId: string) => projectionOf(await threadWindow(cookie, threadId));
  const until = async (threadId: string, done: (projection: any) => boolean, timeoutMs = 180_000) => {
    const started = Date.now();
    let projection: any;
    while (Date.now() - started < timeoutMs) {
      projection = await cloud(threadId).catch(() => undefined);
      if (projection !== undefined && done(projection)) return projection;
      await sleep(1500);
    }
    return projection;
  };
  const pending = (projection: any) => (projection?.runtimeRequests ?? []).filter((request: any) => request.status === "pending");
  const stop = (threadId: string) => mcp.call("t3_thread_interrupt", { threadId, stop: true, clientRequestId: `stop-${threadId}` });
  const threadMeta = (projection: any) => projection?.thread ?? {};

  // A forwarded launch, followed in 50 s waits, its last reply read back.
  if (wants("launch")) {
    const nonce = `pong-${stamp}`;
    const launched = await launch("forwarded", `Reply with exactly ${nonce} and nothing else. Use no tools.`, {
      delegatedFrom: { environmentId: "00000000-0000-4000-8000-000000000001", threadId: `laptop-${stamp}`, title: "laptop parent" },
    });
    const threadId = threadOf(launched);
    report.launch = { isError: launched.isError, threadId: threadId ?? null, text: launched.isError ? launched.text.slice(0, 400) : undefined };
    if (check("a forwarded launch starts a thread", !launched.isError && threadId !== undefined, launched.text.slice(0, 400))) {
      const { answer, pieces } = await mcp.waitThread({ threadId }, 5 * 60_000);
      const read = await mcp.call("t3_thread_read", { threadId });
      const projection = await cloud(threadId!);
      const meta = threadMeta(projection);
      report.launchResult = {
        status: answer.json?.status,
        pieces,
        reply: read.text.includes(nonce),
        runtimeMode: meta.runtimeMode,
        interactionMode: meta.interactionMode,
        linkOrigin: meta.linkOrigin ?? null,
        delegatedFrom: meta.delegatedFrom ?? null,
      };
      check("the run completes", answer.json?.status === "completed", answer.text.slice(0, 300));
      check("the reply reads back through the link", read.text.includes(nonce), read.text.slice(0, 300));
      check("the cloud thread carries the link's origin", meta.linkOrigin?.access === "auto-accept-edits", meta.linkOrigin);
      check("the cloud thread runs at the link's access (capping a full-access caller)", meta.runtimeMode === "auto-accept-edits", meta.runtimeMode);
    }
  }

  // F5 and F7: the link's cap holds in the Session; a 50 s wait holds; the link cannot approve, the owner can.
  if (wants("F5")) {
    const launched = await launch("f5", `Run the bash command \`echo f5-${stamp}\` and reply with its output.`);
    const threadId = threadOf(launched);
    if (check("F5 launch", threadId !== undefined, launched.text.slice(0, 300))) {
      const projection = await until(threadId!, (p) => pending(p).length > 0 || runsOf(p).some((run) => SETTLED.has(run.status)));
      const request = pending(projection)[0];
      report.F5 = { runtimeMode: threadMeta(projection).runtimeMode, request: request === undefined ? null : { kind: request.kind, type: request.type } };
      check("F5: the cloud thread's bash waits for approval", request !== undefined, report.F5);
      if (request !== undefined) {
        const started = Date.now();
        const held = await mcp.call("t3_thread_wait", { threadId, timeoutMs: WAIT_CHUNK_MS });
        report.waitHold = { ms: Date.now() - started, timedOut: held.json?.timedOut ?? null, status: held.json?.status ?? null };
        check("a 50 s wait on a waiting run holds in workerd and times out as a wait", held.json?.timedOut === true && Date.now() - started >= 45_000, report.waitHold);
        // F7: the link cannot answer an approval; the owner's answer through the cloud client runs the call.
        const respond = await mcp.call("t3_pending_request", { action: "respond", threadId, requestId: request.id, answers: { decision: "accept" } });
        const afterLink = await cloud(threadId!);
        report.F7 = { link: { isError: respond.isError, text: respond.text.slice(0, 300) }, stillPending: pending(afterLink).some((r: any) => r.id === request.id) };
        check("F7: t3_pending_request through the link cannot answer the approval", respond.isError && pending(afterLink).some((r: any) => r.id === request.id), report.F7);
        await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" });
        const done = await until(threadId!, (p) => runsOf(p).length > 0 && runsOf(p).every((run) => SETTLED.has(run.status)));
        const read = await mcp.call("t3_thread_read", { threadId });
        (report.F7 as Record<string, unknown>).owner = { runs: runsOf(done).map((run) => run.status), output: read.text.includes(`f5-${stamp}`) };
        check("F7: the owner's approval runs the bash", read.text.includes(`f5-${stamp}`), report.F7);
      }
    }
  }

  // F6: the link narrows the launch to plan.
  if (wants("F6")) {
    mcp.modeLimit = "approval-required/plan";
    const launched = await launch(
      "f6",
      "First use the write tool to create the file plan-check.txt containing `x`. Then run the bash command `ls`. Then reply DONE.",
    );
    mcp.modeLimit = "full-access/default";
    const threadId = threadOf(launched);
    if (check("F6 launch", threadId !== undefined, launched.text.slice(0, 300))) {
      const projection = await until(threadId!, (p) => pending(p).length > 0 || runsOf(p).some((run) => SETTLED.has(run.status)));
      const items = projection?.turnItems ?? [];
      const write = items.find((item: any) => item.type === "file_change");
      const request = pending(projection)[0];
      report.F6 = {
        runtimeMode: threadMeta(projection).runtimeMode,
        interactionMode: threadMeta(projection).interactionMode,
        write: write === undefined ? null : { status: write.status, output: String(write.output ?? write.error ?? "").slice(0, 200) },
        request: request === undefined ? null : { kind: request.kind },
        runs: runsOf(projection).map((run: any) => run.status),
        items: items.map((item: any) => ({ type: item.type, status: item.status ?? null, text: String(item.text ?? item.input ?? item.title ?? "").slice(0, 160) })),
      };
      check("F6: the thread runs in plan", threadMeta(projection).interactionMode === "plan", report.F6);
      check("F6: write is refused in plan", write === undefined || write.status !== "completed", report.F6);
      check("F6: bash asks in plan", request !== undefined, report.F6);
      await stop(threadId!);
    }
  }

  // F1 and F2: the fence, through an auto-accept-edits link.
  const owner = { projectId: uuid(), threadId: uuid() };
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId: owner.projectId, title: `owner ${stamp}`, workspaceRoot: `/w/owner-${stamp}`, createWorkspaceRootIfMissing: true });
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId: owner.threadId,
    projectId: owner.projectId,
    title: `owner thread ${stamp}`,
    modelSelection: MODEL,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const fenceCalls = (client: McpClient) => ({
    send: () => client.call("t3_thread_send", { threadId: owner.threadId, message: "hello from the link", clientRequestId: `send-${uuid()}` }),
    interrupt: () => client.call("t3_thread_interrupt", { threadId: owner.threadId, clientRequestId: `interrupt-${uuid()}` }),
    rename: () => client.call("t3_thread_update", { threadId: owner.threadId, action: "rename", title: `renamed ${stamp}`, clientRequestId: `rename-${uuid()}` }),
  });
  if (wants("F1")) {
    const calls = fenceCalls(mcp);
    const send = await calls.send();
    const interrupt = await calls.interrupt();
    const rename = await calls.rename();
    report.F1 = { send: send.text.slice(0, 200), interrupt: interrupt.text.slice(0, 200), rename: rename.text.slice(0, 200) };
    check("F1: the link may not send to, interrupt or rename the owner's thread", denied(send) && denied(interrupt) && denied(rename), report.F1);
  }
  if (wants("F2")) {
    const create = await mcp.call("t3_project_create", { title: `link project ${stamp}`, workspaceRoot: `/w/link-${stamp}`, createWorkspaceRootIfMissing: true });
    const clone = await mcp.call("t3_project_clone", { destinationPath: `/w/link-clone-${stamp}`, remoteUrl: "https://github.com/ian-pascoe/t3flare-fixture.git" });
    const prefs = await mcp.call("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true });
    const schedule = await mcp.call("schedule_task", { projectId: fixture.projectId, title: `link schedule ${stamp}`, prompt: "hi", schedule: { type: "interval", everyMs: 3_600_000 } });
    report.F2 = { create: create.text.slice(0, 200), clone: clone.text.slice(0, 200), prefs: prefs.text.slice(0, 200), schedule: schedule.text.slice(0, 200) };
    check("F2: the link may not create or clone projects, change preferences or schedule tasks", denied(create) && denied(clone) && denied(prefs) && denied(schedule), report.F2);
  }

  // F4: a worktree launch through the link skips the project's setup script.
  if (wants("F4")) {
    await wsCall(cookie, "server.updateSettings", {
      patch: {
        projectSettingsOverrides: {
          [fixture.projectId]: { defaultProjectScripts: [{ id: "setup", name: "Setup", command: "echo setup-ran > setup.txt", icon: "configure", runOnWorktreeCreate: true }] },
        },
      },
    });
    const launched = await launch("f4", "Reply with OK. Use no tools.", { workspaceStrategy: { type: "worktree", baseRef: "main", branch: `link-${stamp}` } });
    const threadId = threadOf(launched);
    if (check("F4 launch", threadId !== undefined, launched.text.slice(0, 300))) {
      let setup: any;
      const started = Date.now();
      while (Date.now() - started < 4 * 60_000) {
        setup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined);
        const stage = setup?.stages?.find((s: any) => s.id === "setup-script");
        if (stage !== undefined && stage.status !== "pending" && stage.status !== "running") break;
        if (setup?.phase === "failed") break;
        await sleep(2000);
      }
      const stages = (setup?.stages ?? []).map((s: any) => `${s.id}:${s.status}`);
      report.F4 = { stages, worktreePath: setup?.worktreePath ?? null, phase: setup?.phase ?? null };
      check("F4: the worktree is provisioned and the setup script skipped for the link", setup?.worktreePath != null && stages.some((s: string) => /setup-script:skipped/.test(s)), report.F4);
      await stop(threadId!);
    }
  }

  // F12: a full-access link is not fenced (t3's documented exception).
  if (wants("F12")) {
    const full = await signIn((await mintPairingCode(cookie, { label: `full ${stamp}` })).code, "full-access", { clientName: `full ${stamp}` });
    const calls = fenceCalls(new McpClient(full.token, { modeLimit: "full-access/default" }));
    const rename = await calls.rename();
    const interrupt = await calls.interrupt();
    report.F12 = { scope: full.scope, rename: rename.text.slice(0, 200), interrupt: interrupt.text.slice(0, 200) };
    check("F12: a full-access link may rename and interrupt the owner's thread", !rename.isError && !interrupt.isError, report.F12);
  }

  // F10: Linked environments off answers 403; on again, the link works.
  if (wants("F10")) {
    await updateSettings(cookie, { linkedEnvironmentsEnabled: false });
    const off = await mcp.raw({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} });
    await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
    const on = await mcp.call("t3_project_list", {});
    report.F10 = { off: off.status, on: on.http };
    check("F10: Linked environments off answers 403, on again works", off.status === 403 && !on.isError, report.F10);
  }

  // F9: revoke the link's client session in the cloud: 401.
  if (wants("F9")) {
    const access = (await wsFirst(cookie, "subscribeAuthAccess", {})) as any;
    const session = findSession(access, clientName);
    report.F9 = { found: session !== undefined, accessKeys: session === undefined ? Object.keys(access ?? {}) : undefined };
    if (check("F9: the link's client is listed in Sharing & access", session !== undefined, report.F9)) {
      const revoked = await fetch(new URL("/api/auth/clients/revoke", base), {
        method: "POST",
        headers: { cookie, origin: base.origin, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      const after = await mcp.raw({ jsonrpc: "2.0", id: 901, method: "tools/list", params: {} });
      (report.F9 as Record<string, unknown>).revoke = revoked.status;
      (report.F9 as Record<string, unknown>).after = after.status;
      check("F9: after revocation the link's next call is 401", revoked.status === 200 && after.status === 401, report.F9);
    }
  }

  return { ok: failures.length === 0, failures, ...report };
};

/** The client session labelled `label` in the access snapshot, wherever the snapshot nests it. */
const findSession = (value: unknown, label: string): any => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSession(item, label);
      if (found !== undefined) return found;
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId === "string" && JSON.stringify(record).includes(label)) return record;
    for (const child of Object.values(record)) {
      const found = findSession(child, label);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * F11 (review C5): the bootstrap token spent as a pairing code at `/oauth/mcp/decision`. Disarmed, the Environment DO
 * refuses it before t3 sees it (L2, `{"error":"pairing is not armed"}`); armed (so the DO lets it through), t3 alone
 * refuses it as not a one-time pairing code, and the grant is not spent.
 */
export const bootstrapAtDecision = async (bootstrapToken: string, armed: boolean): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> => {
  const registered = await registerPeerClient(`f11 ${Date.now().toString(36)}`);
  const clientId = (registered.body as { client_id?: string }).client_id;
  if (clientId === undefined) return { ok: false, status: registered.status, body: registered.body };
  const { answer } = await decide(clientId, bootstrapToken, "full-access");
  const ok = armed
    ? answer.status === 400 && JSON.stringify(answer.body).includes("not a one-time pairing code")
    : answer.status === 401 && (answer.body as { error?: string }).error === "pairing is not armed";
  return { ok, status: answer.status, body: answer.body };
};
