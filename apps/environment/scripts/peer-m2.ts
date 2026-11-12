// @effect-diagnostics globalConsole:off globalDate:off
// Step 3, M2's exit on a stage: t3's MCP tools in Sessions, driven as the stock client drives a thread.
//
//   delegate  an approval-required thread lists threads, reads capabilities and delegates a task to a Durable agent child
//             with mode "wait", using its result; the delegate asks (a permission, by tool name), the reads do not
//   restart   an Environment restart, then a new turn: the Session gets t3's fresh credential and its tools work
//   fence     F1 and F3 from inside a linked thread's Session (its own credential carries the link's origin), F13 from
//             an owner's thread; the linked Session offers no `t3_environment_link`
//   leak      no secret in the fixture Workspace's Container or in the Sessions' state (review C8)
//
//   node scripts/stage.ts run step3 peer-m2 [--only delegate,restart,fence,leak]
import { admin, pair, sleep } from "./lib/client.ts";
import { approveAll, createThread, projection, replyOf, say, t3Calls, until } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { ensureCloudFixtureProject } from "./lib/fixtureProject.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const at = process.argv.indexOf("--only");
const only = at < 0 ? undefined : new Set(process.argv[at + 1]!.split(","));
const wants = (row: string) => only === undefined || only.has(row);
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  return ok;
};
const stamp = Date.now().toString(36);
const cookie = await pair();
const fixture = await ensureCloudFixtureProject(cookie);
const threads: Array<string> = [];
const out: Record<string, unknown> = { fixture };
/** A Session's T3 tool results as its committed entries hold them (the text the model saw). */
const sessionResults = async (threadId: string): Promise<Array<{ readonly tool: string; readonly isError: boolean; readonly text: string }>> => {
  const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
  return (state?.entries ?? [])
    .filter((entry: any) => entry.role === "toolResult" && String(entry.toolName).startsWith("mcp__t3-code__"))
    .map((entry: any) => ({
      tool: String(entry.toolName).replace("mcp__t3-code__", ""),
      isError: entry.isError === true,
      text: (entry.content ?? []).map((block: any) => block.text ?? "").join("").slice(0, 400),
    }));
};
const titleOf = (request: any, p: any) => (p?.turnItems ?? []).find((item: any) => item.requestId === request.id)?.title ?? null;

if (wants("delegate") || wants("restart")) {
  const threadId = await createThread(cookie, fixture.projectId, { title: `m2 delegate ${stamp}`, runtimeMode: "approval-required" });
  threads.push(threadId);
  const nonce = `CHILD-${stamp}`;
  await say(
    cookie,
    threadId,
    `Do these steps in order. 1) Call the T3 tool t3_thread_list. 2) Call orchestrator_capabilities. 3) Call delegate_task with mode "wait", target {"providerInstanceId": "piDurable", "model": "anthropic/claude-haiku-5-5"}, and task "Reply with exactly ${nonce} and nothing else. Use no tools." 4) Reply with the child's result verbatim.`,
  );
  const asked: Array<string> = [];
  const { projection: p, answered } = await approveAll(cookie, threadId, 6 * 60_000);
  for (const request of answered) asked.push(`${request.kind}:${titleOf(request, p)}`);
  const calls = t3Calls(p);
  const subagent = (p?.turnItems ?? []).find((item: any) => item.type === "subagent");
  out.delegate = { threadId, runs: p?.runs?.map((r: any) => r.status), asked, calls: calls.map((c: any) => `${c.tool}:${c.status}`), child: subagent?.childThreadId ?? null, childResult: String(subagent?.result ?? "").slice(0, 200), reply: replyOf(p).slice(0, 400) };
  check("delegate: the run completes", p?.runs?.at(-1)?.status === "completed", out.delegate);
  check("delegate: t3_thread_list, orchestrator_capabilities and delegate_task ran", ["t3_thread_list", "orchestrator_capabilities", "delegate_task"].every((tool) => calls.some((c: any) => c.tool === tool && c.status === "completed")), calls);
  check("delegate: only delegate_task asked, as a permission by its tool name", asked.length === 1 && asked[0]!.startsWith("permission:") && asked[0]!.includes("delegate_task"), asked);
  check("delegate: the child's result is the reply", replyOf(p).includes(nonce), out.delegate);
  if (subagent?.childThreadId) threads.push(subagent.childThreadId);

  if (wants("restart")) {
    const before = (await admin("GET", `/_t3flare/agents/session-tools?thread=${threadId}`)).json;
    await admin("POST", "/_t3flare/restart");
    await sleep(5000);
    await say(cookie, threadId, `Call the T3 tool t3_thread_read with threadId "${threadId}" and reply with its title.`);
    await until(cookie, threadId, (q) => (q?.runs ?? []).length >= 2);
    // t3 annotates t3_thread_read as not read-only, so it asks in approval-required.
    const { projection: after } = await approveAll(cookie, threadId, 4 * 60_000);
    const read = t3Calls(after).filter((c: any) => c.tool === "t3_thread_read");
    out.restart = { runs: after?.runs?.map((r: any) => r.status), read, toolsBefore: before?.tools?.length ?? null, reply: replyOf(after).slice(-300) };
    check("restart: after an Environment restart a new turn's T3 tool works", read.length > 0 && read.at(-1).status === "completed" && !/unavailable/i.test(read.at(-1).output), out.restart);
  }
}

if (wants("fence")) {
  const owner = await createThread(cookie, fixture.projectId, { title: `m2 owner target ${stamp}`, runtimeMode: "approval-required" });
  const link = await signIn((await mintPairingCode(cookie, { label: `m2 ${stamp}` })).code, "auto-accept-edits", { clientName: `m2 link ${stamp}` });
  const mcp = new McpClient(link.token, { modeLimit: "full-access/default" });
  const launched = await mcp.call("t3_thread_launch", {
    projectId: fixture.projectId,
    title: `m2 linked ${stamp}`,
    modelSelection: { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5" },
    clientRequestId: `m2-linked-${stamp}`,
    message: `Use T3 tools, one call each, and report each tool's answer or error verbatim: 1) t3_thread_update with threadId "${owner}", action "rename", title "renamed by link". 2) t3_thread_send with threadId "${owner}" and message "hello from linked work". 3) t3_project_list with environmentId "00000000-0000-4000-8000-0000000000aa". 4) t3_environment_links.`,
  });
  const linked: string | undefined = launched.json?.threadId;
  if (check("fence: launch through the link", linked !== undefined, launched.text.slice(0, 300))) {
    threads.push(linked!);
    const { projection: p } = await approveAll(cookie, linked!, 6 * 60_000);
    const calls = t3Calls(p);
    const results = await sessionResults(linked!);
    const outputOf = (tool: string) => results.filter((r) => r.tool === tool).map((r) => r.text).join(" ");
    const tools = (await admin("GET", `/_t3flare/agents/session-tools?thread=${linked}`)).json;
    out.fenceLinked = { calls, results, tools: { count: tools?.tools?.length, environmentLink: tools?.tools?.includes("t3_environment_link") ?? null, left: tools?.left } };
    check("F1 (Session): the linked thread's agent may not rename the owner's thread", /capability_denied|linked environment/.test(outputOf("t3_thread_update")), outputOf("t3_thread_update"));
    check("F1 (Session): the linked thread's agent may not send to the owner's thread", /capability_denied|linked environment/.test(outputOf("t3_thread_send")), outputOf("t3_thread_send"));
    check("F3: the linked thread's agent may not use this Environment's links", /capability_denied|link/i.test(outputOf("t3_project_list")), outputOf("t3_project_list"));
    check("F3: the linked Session offers no t3_environment_link", tools?.tools?.includes("t3_environment_link") === false, out.fenceLinked);
    const ownerAfter = await projection(cookie, owner);
    check("F1 (Session): the owner's thread kept its title and got no message", ownerAfter?.thread?.title === `m2 owner target ${stamp}` && (ownerAfter?.runs ?? []).length === 0, ownerAfter?.thread?.title);
  }
  // F13: the owner's own thread (no link origin) does the same through its Session tools.
  const target = await createThread(cookie, fixture.projectId, { title: `m2 f13 target ${stamp}`, runtimeMode: "approval-required" });
  const own = await createThread(cookie, fixture.projectId, { title: `m2 f13 ${stamp}`, runtimeMode: "full-access" });
  threads.push(own);
  await say(cookie, own, `Use T3 tools and report each answer verbatim: 1) t3_thread_update with threadId "${target}", action "rename", title "renamed by owner". 2) t3_project_create with title "f13 ${stamp}", workspaceRoot "/w/f13-${stamp}" and createWorkspaceRootIfMissing true.`);
  const { projection: q } = await approveAll(cookie, own, 4 * 60_000);
  const calls = t3Calls(q);
  const ownResults = await sessionResults(own);
  out.F13 = { calls, results: ownResults };
  const targetAfter = await projection(cookie, target);
  check("F13: the owner's thread may rename another of the owner's threads", targetAfter?.thread?.title === "renamed by owner", { title: targetAfter?.thread?.title, calls });
  check("F13: the owner's full-access thread may create a project", ownResults.some((r) => r.tool === "t3_project_create" && !r.isError), ownResults);
  if (wants("leak")) {
    const leak = (await admin("POST", "/_t3flare/check/peer-leak", { workspace: "step3-fixture", threads, extra: [{ name: "link-token", value: link.token }] })).json;
    out.leak = leak;
    check("leak: no secret in the Container or the Sessions' state", leak?.leaked === 0 && leak?.credentialsFound > 0, leak);
  }
}

if (only?.has("leak") === true && !wants("fence")) {
  const leak = (await admin("POST", "/_t3flare/check/peer-leak", { workspace: "step3-fixture", threads })).json;
  out.leak = leak;
}

const report = { ...out, failures, ok: failures.length === 0 };
writeEvidence(at < 0 ? "m2-stage.json" : `m2-${[...only!].join("-")}.json`, report);
console.log(JSON.stringify(report, null, 1).slice(0, 9000));
process.exit(report.ok ? 0 : 1);
