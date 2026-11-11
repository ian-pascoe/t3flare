// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// Step 3, M3's exit on a stage: the Durable agent asks (`ask_user`), and linked work's pushes ask every time (D1).
//
//   question       an owner's thread asks; the owner answers through the client protocol (a choice); the reply uses it
//   question-mcp   a linked thread asks; the link's MCP client answers with `t3_pending_request respond`
//   restart        a Session restart while the question waits; the answer given after it arrives
//   env-restart    an Environment restart while the question waits (review C2): what t3 and the Session do
//   push           D1 on the fixture: a linked thread's `git push origin HEAD:main` asks every time (also after an
//                  earlier "accept for session"); a decline leaves the remote main unchanged; an approval pushes once;
//                  a second push asks again; a fetch needs no approval. The remote main is restored afterwards.
//
//   bun scripts/stage.ts run step3 peer-m3 [--only question,push,…]
import { spawnSync } from "node:child_process";

import { admin, dispatch, pair, sleep, uuid } from "./lib/client.ts";
import { createThread, MODEL, pendingOf, projection, replyOf, say, settled, until } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { ensureCloudFixtureProject, FIXTURE } from "./lib/fixtureProject.ts";
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
const out: Record<string, unknown> = {};

const questionOf = (p: any) => pendingOf(p).find((request: any) => request.kind === "user_input");
const questionItem = (p: any, request: any) => (p?.turnItems ?? []).find((item: any) => item.type === "user_input_request" && item.requestId === request.id);
const answerAsOwner = (threadId: string, request: any, value: string) =>
  dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, answers: { [questionItem(lastSeen.get(threadId), request)?.questions?.[0]?.id ?? ""]: value } });
const lastSeen = new Map<string, any>();
const waitQuestion = async (threadId: string) => {
  const p = await until(cookie, threadId, (q) => questionOf(q) !== undefined || settled(q));
  lastSeen.set(threadId, p);
  return { p, request: questionOf(p) };
};
const ASK = (nonce: string) =>
  `Use the ask_user tool to ask me exactly this question: "Which color for ${nonce}?" with options ["red", "blue"]. Then reply with only the color I chose and the word ${nonce}.`;

if (wants("question")) {
  const threadId = await createThread(cookie, fixture.projectId, { title: `m3 question ${stamp}` });
  await say(cookie, threadId, ASK(`q-${stamp}`));
  const { p, request } = await waitQuestion(threadId);
  const item = request === undefined ? undefined : questionItem(p, request);
  out.question = { threadId, request: request === undefined ? null : { kind: request.kind, capability: request.responseCapability?.type }, item: item?.questions ?? null };
  if (check("question: the thread's question is a user_input request with its choices", item?.questions?.[0]?.options?.length === 2, out.question)) {
    await answerAsOwner(threadId, request, "blue");
    const done = await until(cookie, threadId, settled);
    (out.question as Record<string, unknown>).reply = replyOf(done).slice(-200);
    check("question: the answer reaches the agent", /blue/i.test(replyOf(done)) && done?.runs?.at(-1)?.status === "completed", out.question);
  }
}

if (wants("question-mcp")) {
  const link = await signIn((await mintPairingCode(cookie, { label: `m3 ${stamp}` })).code, "auto-accept-edits", { clientName: `m3 link ${stamp}` });
  const mcp = new McpClient(link.token, { modeLimit: "auto-accept-edits/default" });
  const launched = await mcp.call("t3_thread_launch", { projectId: fixture.projectId, title: `m3 linked question ${stamp}`, modelSelection: MODEL, clientRequestId: `m3-q-${stamp}`, message: ASK(`m-${stamp}`) });
  const threadId: string | undefined = launched.json?.threadId;
  if (check("question-mcp: launch", threadId !== undefined, launched.text.slice(0, 300))) {
    const { request } = await waitQuestion(threadId!);
    const listed = await mcp.call("t3_pending_request", { action: "list", threadId });
    const questionId = questionItem(lastSeen.get(threadId!), request)?.questions?.[0]?.id;
    const responded = await mcp.call("t3_pending_request", { action: "respond", threadId, requestId: request?.id, answers: { [questionId]: "red" } });
    const done = await until(cookie, threadId!, settled);
    out.questionMcp = { listed: listed.text.slice(0, 300), responded: { isError: responded.isError, text: responded.text.slice(0, 300) }, reply: replyOf(done).slice(-200) };
    check("question-mcp: the link's MCP client answers the question with t3_pending_request", !responded.isError && /red/i.test(replyOf(done)), out.questionMcp);
  }
}

if (wants("restart")) {
  const threadId = await createThread(cookie, fixture.projectId, { title: `m3 question restart ${stamp}` });
  await say(cookie, threadId, ASK(`r-${stamp}`));
  const { request } = await waitQuestion(threadId);
  if (check("restart: the question waits", request !== undefined)) {
    const before = (await admin("GET", `/_t3flare/agents/session-diagnostics?thread=${threadId}`)).json;
    for (let n = 0; n < 2; n++) {
      await admin("POST", `/_t3flare/agents/session-restart?thread=${threadId}`);
      await sleep(4000);
    }
    const after = (await admin("GET", `/_t3flare/agents/session-diagnostics?thread=${threadId}`)).json;
    const still = questionOf(await projection(cookie, threadId));
    await answerAsOwner(threadId, request, "blue");
    const done = await until(cookie, threadId, settled);
    out.restart = { constructedBefore: before?.constructed ?? null, constructedAfter: after?.constructed ?? null, stillPending: still?.id === request.id, reply: replyOf(done).slice(-200), runs: done?.runs?.map((r: any) => r.status) };
    check("restart: after Session restarts the same question still waits and its answer arrives", still?.id === request.id && /blue/i.test(replyOf(done)), out.restart);
  }
}

if (wants("env-restart")) {
  const threadId = await createThread(cookie, fixture.projectId, { title: `m3 question env restart ${stamp}` });
  await say(cookie, threadId, ASK(`e-${stamp}`));
  const { request } = await waitQuestion(threadId);
  if (check("env-restart: the question waits", request !== undefined)) {
    await admin("POST", "/_t3flare/restart");
    await sleep(8000);
    const p = await until(cookie, threadId, (q) => q?.runtimeRequests?.some((r: any) => r.id === request.id && r.responseCapability?.type !== "live"), 60_000);
    const same = p?.runtimeRequests?.find((r: any) => r.id === request.id);
    const pending = pendingOf(p).map((r: any) => ({ id: r.id === request.id ? "same" : "new", kind: r.kind, capability: r.responseCapability?.type }));
    out.envRestart = { original: same === undefined ? null : { status: same.status, capability: same.responseCapability }, pending, runs: p?.runs?.map((r: any) => r.status) };
    // Answer whatever question is pending now, and see where the answer goes.
    const now = questionOf(p);
    if (now !== undefined) {
      lastSeen.set(threadId, p);
      await answerAsOwner(threadId, now, "blue");
    }
    const done = await until(cookie, threadId, (q) => settled(q) && pendingOf(q).length === 0, 240_000);
    (out.envRestart as Record<string, unknown>).after = { runs: done?.runs?.map((r: any) => r.status), reply: replyOf(done).slice(-300), pending: pendingOf(done).length };
    check("env-restart: the question survives an Environment restart and its answer reaches the agent", /blue/i.test(replyOf(done)), out.envRestart);
  }
}

if (wants("push")) {
  const remoteMain = () => spawnSync("git", ["ls-remote", `https://github.com/${FIXTURE}.git`, "refs/heads/main"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).stdout.split(/\s/)[0] ?? "";
  // gh's credentials for this machine's own git (the owner's), never the stage's.
  const ghGit = (args: Array<string>) => spawnSync("gh", ["api", ...args], { encoding: "utf8" });
  const originalMain = remoteMain();
  out.push = { originalMain };
  const link = await signIn((await mintPairingCode(cookie, { label: `m3 push ${stamp}` })).code, "auto-accept-edits", { clientName: `m3 push link ${stamp}` });
  const mcp = new McpClient(link.token, { modeLimit: "auto-accept-edits/default" });
  const file = `linked-${stamp}.txt`;
  const launched = await mcp.call("t3_thread_launch", {
    projectId: fixture.projectId,
    title: `m3 linked push ${stamp}`,
    modelSelection: MODEL,
    clientRequestId: `m3-push-${stamp}`,
    message: [
      "Run each of these bash commands one at a time, in order, exactly as written, and report each one's exit code:",
      "1. `git fetch origin main`",
      `2. \`git checkout -B linked-${stamp} origin/main && echo x > ${file} && git add ${file} && git commit -m "linked work ${stamp}"\``,
      "3. `git push origin HEAD:main`",
      "4. `git push origin HEAD:main`",
      "5. `git push origin HEAD:main`",
      "Do not retry a command that failed. Then reply DONE.",
    ].join("\n"),
  });
  const threadId: string | undefined = launched.json?.threadId;
  const answers: Array<{ title: string; decision: string; mainAfter?: string }> = [];
  if (check("push: launch", threadId !== undefined, launched.text.slice(0, 300))) {
    // The commands ask (auto-accept-edits): accept the first for the session; then the pushes: decline, accept, accept.
    const pushDecisions = ["decline", "acceptForSession", "accept"];
    const started = Date.now();
    const seen = new Set<string>();
    let p: any;
    while (Date.now() - started < 10 * 60_000) {
      p = await projection(cookie, threadId!).catch(() => p);
      for (const request of pendingOf(p).filter((r: any) => !seen.has(r.id))) {
        seen.add(request.id);
        const title = (p?.turnItems ?? []).find((item: any) => item.requestId === request.id)?.title ?? "";
        const isPush = title === "Allow git push?";
        const decision = isPush ? (pushDecisions.shift() ?? "accept") : "acceptForSession";
        await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision });
        await sleep(isPush ? 8000 : 0);
        answers.push({ title, decision, ...(isPush ? { mainAfter: remoteMain() } : {}) });
      }
      if (p !== undefined && settled(p) && pendingOf(p).length === 0) break;
      await sleep(1500);
    }
    const pushes = answers.filter((a) => a.title === "Allow git push?");
    const finalMain = remoteMain();
    out.push = { ...(out.push as object), answers, finalMain, reply: replyOf(p).slice(-500) };
    check("push: each of the three pushes asked on its own (also after accept-for-session on commands and on a push), and the fetch did not", pushes.length === 3, answers);
    check("push: the declined push left the remote main unchanged", pushes[0]?.mainAfter === originalMain, answers);
    check("push: the approved push pushed once", pushes[1] !== undefined && pushes[1].mainAfter !== originalMain, answers);
    // Restore the fixture's main (the owner's gh, this machine).
    if (finalMain !== originalMain) {
      const restored = ghGit(["-X", "PATCH", `repos/${FIXTURE}/git/refs/heads/main`, "-f", `sha=${originalMain}`, "-F", "force=true"]);
      (out.push as Record<string, unknown>).restored = { status: restored.status, main: remoteMain() };
      check("push: the fixture's main is restored", remoteMain() === originalMain, out.push);
    }
  }
}

const report = { ...out, failures, ok: failures.length === 0 };
writeEvidence(at < 0 ? "m3-stage.json" : `m3-${[...only!].join("-")}.json`, report);
console.log(JSON.stringify(report, null, 1).slice(0, 9000));
process.exit(report.ok ? 0 : 1);
