// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4a's stage evidence (plan §8 M1–M5), through the admin routes and t3's own client protocol.
//
//   bun scripts/stage.ts run step4a cli4a channel [--workspace <id>]          M1: the probe through t3's spawner
//   bun scripts/stage.ts run step4a cli4a restart [--workspace <id>]          M1: Environment restart, Workspace DO abort
//   bun scripts/stage.ts run step4a cli4a turn --cli codex|pi [--model <slug>] [--mode approval-required|full-access]
//        [--plan] [--workspace <id>] [--prompt <text>] [--thread <id>] [--out <file>]
//                                                                             M3/M4: a CLI turn from t3's client protocol
//   bun scripts/stage.ts run step4a cli4a two                                  M5: a Codex and a Pi turn at once, two Workspaces
//   bun scripts/stage.ts run step4a cli4a resume --cli codex|pi                M5: a turn, the Container stopped, a turn that resumes
//   bun scripts/stage.ts run step4a cli4a restart-turn --cli codex|pi          SPI-1043: the Environment restarts mid-turn
//   bun scripts/stage.ts run step4a cli4a idle --cli codex|pi                  SPI-1043: an idle session with no client
import * as path from "node:path";

import { admin, itemsOf, pair, projectionOf, runsOf, sleep, threadWindow } from "./lib/client.ts";
import { writeEvidence as writeAt } from "./lib/evidence.ts";
import { cliTurn, enable } from "./lib/cliTurn.ts";

const [scenario = "channel", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const flag = (name: string) => args.includes(`--${name}`);
const evidence = (name: string, value: unknown) => writeAt(path.resolve(import.meta.dirname, "../../../docs/steps/step-4a", name), value);
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const finish = (name: string | undefined, report: Record<string, unknown>) => {
  const full = { scenario, ok: failures.length === 0, failures, ...report };
  if (name !== undefined) evidence(name, full);
  console.log(JSON.stringify(full, null, 1).slice(0, 6000));
  process.exit(failures.length === 0 ? 0 : 1);
};
const processCheck = async (body: Record<string, unknown>) => (await admin("POST", "/_t3flare/agents/process-check", body)).json;
const processState = async (workspace: string) => (await admin("GET", `/_t3flare/agents/process-state?id=${encodeURIComponent(workspace)}`)).json;

const workspaceArg = (fallback: string) => arg("workspace") ?? fallback;

switch (scenario) {
  case "channel": {
    const workspace = workspaceArg("step3-fixture");
    const report = await processCheck({ op: "check", workspace, roundTrips: Number(arg("round-trips") ?? 200) });
    check("200 round trips", report?.roundTrips?.n === Number(arg("round-trips") ?? 200), report?.roundTrips);
    check("4 MiB in and out", report?.in4MiB?.ok === true && report?.out4MiB?.ok === true, { in: report?.in4MiB, out: report?.out4MiB });
    check("stderr apart", report?.stderrLines >= 1, report?.stderrLines);
    check("the kill took the TERM-ignoring child", report?.markerProcessesAfterKill === 0, report?.markerProcessesAfterKill);
    finish(arg("out") ?? "m1-channel.json", { workspace, report });
    break;
  }
  case "restart": {
    const workspace = workspaceArg("step3-fixture");
    // 1. The Environment restarts with a process held: the next start in that Workspace kills the old epoch's process.
    const held = await processCheck({ op: "hold", workspace });
    const before = await processCheck({ op: "count", workspace, marker: held.key });
    const stateBefore = await processState(workspace);
    await admin("POST", "/_t3flare/restart");
    await sleep(3000);
    const after = await processCheck({ op: "check", workspace, roundTrips: 5 });
    const oldAfter = await processCheck({ op: "count", workspace, marker: held.key });
    check("the held process ran before the restart", before.count >= 1, before);
    check("the old epoch's process is gone after the next start", oldAfter.count === 0, oldAfter);
    check("the new start works", after?.roundTrips?.n === 5, after?.roundTrips);
    // 2. The Workspace DO aborts with a process held: the handle ends (unknown epoch) and the process goes with the object.
    const held2 = await processCheck({ op: "hold", workspace });
    const stateHeld = await processState(workspace);
    await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { probeProcess: { op: "abort" } });
    const abortedAt = Date.now();
    let channelAfterAbort = await processState(workspace);
    while (channelAfterAbort?.channel?.live !== 0 && Date.now() - abortedAt < 150_000) {
      await sleep(5000);
      channelAfterAbort = await processState(workspace);
    }
    const handleEndedMs = Date.now() - abortedAt;
    const held2After = await processCheck({ op: "count", workspace, marker: held2.key });
    check("the aborted Workspace's process is gone", held2After.count === 0, held2After);
    check("the Environment's handle ended (heartbeat or push answered unknown)", channelAfterAbort?.channel?.live === 0, channelAfterAbort?.channel);
    await processCheck({ op: "release", workspace });
    finish(arg("out") ?? "m1-restart.json", { workspace, environmentRestart: { held, before, stateBefore, after: after?.roundTrips, oldAfter }, workspaceAbort: { held: held2, stateHeld, channelAfterAbort, handleEndedMs, held2After } });
    break;
  }
  case "turn": {
    const cookie = await pair();
    const cli = arg("cli") ?? "codex";
    await enable(cookie, cli, cli);
    const result = await cliTurn(cookie, {
      cli,
      workspace: workspaceArg(`cli-${cli}`),
      ...(arg("model") === undefined ? {} : { model: arg("model")! }),
      mode: arg("mode") ?? "approval-required",
      plan: flag("plan"),
      prompt: arg("prompt") ?? "In src/greeting.txt add a new last line `Hello from the CLI.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed.",
      ...(arg("thread") === undefined ? {} : { threadId: arg("thread")! }),
      ...(arg("approve") === undefined ? {} : { approve: arg("approve") as "accept" | "decline" }),
    });
    check("the turn completed", result.runs.at(-1)?.status === "completed", result.runs);
    finish(arg("out"), { cli, result, processes: await processState(workspaceArg(`cli-${cli}`)) });
    break;
  }
  case "resume": {
    // M5: a turn, the Container stopped (its lease gone), a turn that resumes the same native thread (not a handoff).
    const cookie = await pair();
    const cli = arg("cli") ?? "codex";
    const workspace = workspaceArg(`cli-${cli}`);
    await enable(cookie, cli, cli);
    await admin("GET", "/_t3flare/agents/router-trace?clear=1");
    const first = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "Remember the code word HERON-52 for later. Reply with ok only." });
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
    let container: any = null;
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      container = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces?.find((ws: any) => ws.id === workspace)?.container ?? null;
      if (container?.running === false) break;
    }
    const budget = (await admin("GET", "/_t3flare/agents/budget")).json;
    check("the Container stopped and its lease went", container?.running === false && container?.leased === false, { container, budget });
    const second = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
    check("turn 2 completed", second.runs.at(-1)?.status === "completed", second.runs);
    const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
    check("the same native thread", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(second)), { first: native(first), second: native(second) });
    const trace = ((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>;
    const protocol = trace.filter((entry: any) => entry.route === "protocol" || entry.route === "process");
    const resumed = protocol.filter((entry: any) => entry.route === "protocol" && (entry.detail ?? "").includes(String(native(first)[0])) && !String(entry.detail).startsWith("failed"));
    check("the protocol log shows the CLI resumed that native thread", resumed.length >= 1, protocol);
    check("a new process for turn 2 (the first went with its Container)", protocol.filter((entry: any) => entry.route === "process").length >= 2, protocol);
    check("no context handoff", !JSON.stringify(second.items).includes("handoff"), second.items);
    finish(arg("out") ?? `m5-resume-${cli}.json`, { cli, workspace, first, container, budget, second, protocol });
    break;
  }
  case "two": {
    // M5: a Codex turn and a Pi turn at once in two Workspaces (each runs a 60 s command); the budget read mid-turn.
    const cookie = await pair();
    await enable(cookie, "codex", "codex");
    await enable(cookie, "pi", "pi");
    const prompt = "Run the shell command `sleep 60 && echo slept` and then reply with the single word done.";
    const started = Date.now();
    const turns = Promise.all([
      cliTurn(cookie, { cli: "codex", workspace: "cli-codex", mode: "full-access", plan: false, prompt }),
      cliTurn(cookie, { cli: "pi", workspace: "cli-pi", mode: "full-access", plan: false, prompt }),
    ]);
    await sleep(45_000);
    const budget = (await admin("GET", "/_t3flare/agents/budget")).json;
    const states = { codex: await processState("cli-codex"), pi: await processState("cli-pi") };
    const [codex, pi] = await turns;
    check("both turns completed", codex.runs.at(-1)?.status === "completed" && pi.runs.at(-1)?.status === "completed", { codex: codex.runs, pi: pi.runs });
    const leases = JSON.stringify(budget);
    check("both Workspaces held a lease at once", (budget?.leases ?? []).length >= 2, budget);
    check("both processes were in a turn at once", JSON.stringify(states.codex).includes('"inTurn":true') && JSON.stringify(states.pi).includes('"inTurn":true'), states);
    finish(arg("out") ?? "m5-two-at-once.json", { ms: Date.now() - started, budget, leases, states, codex, pi });
    break;
  }
  case "f1": {
    // Review F1 (P12): two Codex threads in two Workspaces each get a process in their own Workspace's Container; t3
    // never attaches the second thread to the first one's app-server.
    const cookie = await pair();
    await enable(cookie, "codex", "codex");
    const prompt = "Run `pwd` in the shell and reply with its output only.";
    const [a, b] = await Promise.all([
      cliTurn(cookie, { cli: "codex", workspace: "cli-codex", mode: "full-access", plan: false, prompt }),
      cliTurn(cookie, { cli: "codex", workspace: "cli-pi", mode: "full-access", plan: false, prompt }),
    ]);
    const states = { "cli-codex": await processState("cli-codex"), "cli-pi": await processState("cli-pi") };
    const threadsIn = (state: any) => (state?.workspace?.processes ?? []).map((p: any) => p.thread);
    check("both turns completed", a.runs.at(-1)?.status === "completed" && b.runs.at(-1)?.status === "completed", { a: a.runs, b: b.runs });
    check("each answered from its own Workspace", a.text.includes("/w/cli-codex") && b.text.includes("/w/cli-pi"), { a: a.text, b: b.text });
    check("each thread's process lives in its own Workspace", threadsIn(states["cli-codex"]).includes(a.threadId) && threadsIn(states["cli-pi"]).includes(b.threadId) && !threadsIn(states["cli-codex"]).includes(b.threadId), states);
    check("two provider sessions", a.providerSessions[0]?.id !== b.providerSessions[0]?.id, { a: a.providerSessions, b: b.providerSessions });
    finish(arg("out") ?? "m5-f1-two-codex.json", { a, b, states });
    break;
  }
  case "restart-turn": {
    // SPI-1043: the Environment restarts (as a deploy or an eviction does) while a CLI turn runs. ADR-0004: a restart
    // ends running turns. Proved here: the turn settles with a reason (never a silent hang), the old process goes, and
    // the next turn on the thread continues the CLI's own native thread.
    const cookie = await pair();
    const cli = arg("cli") ?? "codex";
    const workspace = workspaceArg(`cli-${cli}`);
    await enable(cookie, cli, cli);
    const first = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "Remember the code word OSPREY-17 for later. Reply with ok only." });
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    const long = cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "Run the shell command `sleep 120 && echo slept` and then reply with the single word done.", threadId: first.threadId });
    const inTurnKey = async () => ((await processState(workspace))?.workspace?.processes ?? []).find((p: any) => p.thread === first.threadId && p.inTurn === true)?.key as string | undefined;
    let key: string | undefined;
    for (let i = 0; i < 40 && key === undefined; i++) {
      await sleep(3000);
      key = await inTurnKey();
    }
    check("the CLI was in its turn before the restart", key !== undefined);
    await sleep(10_000);
    const restartedAt = Date.now();
    await admin("POST", "/_t3flare/restart");
    const interrupted = await long;
    const settledAfterMs = Date.now() - restartedAt;
    const status = interrupted.runs.at(-1)?.status;
    check("the interrupted turn settled (no hang)", status !== undefined && status !== "running" && status !== "pending" && settledAfterMs < 5 * 60_000, { status, settledAfterMs });
    check("the interrupted turn did not finish its command", status !== "completed" || !interrupted.text.includes("done"), interrupted.runs);
    let oldProcess: unknown = "unchecked";
    const goneBy = Date.now();
    for (;;) {
      const state = await processState(workspace);
      oldProcess = (state?.workspace?.processes ?? []).find((p: any) => p.key === key) ?? null;
      if (oldProcess === null || Date.now() - goneBy > 180_000) break;
      await sleep(5000);
    }
    check("the old epoch's process is gone", oldProcess === null, oldProcess);
    const oldProcessGoneMs = Date.now() - restartedAt;
    const third = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
    check("the next turn completed", third.runs.at(-1)?.status === "completed", third.runs);
    check("the next turn knew the code word", third.text.includes("OSPREY-17"), third.text);
    const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
    check("the same native thread (continuation, not a handoff)", JSON.stringify(native(first)) === JSON.stringify(native(third)), { first: native(first), third: native(third) });
    // t3's own answer to the restart (ADR-0004): the interrupted run is cancelled, and a restart continuation run
    // (`restartContinuationOfRunId`) resumes the CLI's thread and tells it the turn was interrupted.
    const projection = projectionOf(await threadWindow(cookie, first.threadId));
    const runs = runsOf(projection).map((run: any) => ({ ordinal: run.ordinal, status: run.status, restartContinuationOfRunId: run.restartContinuationOfRunId ?? null, startedAt: run.startedAt, completedAt: run.completedAt }));
    const continuation = runs.find((run) => run.restartContinuationOfRunId !== null);
    check("t3 started a restart continuation of the interrupted run", continuation !== undefined && continuation.status === "completed", runs);
    const continuationItems = itemsOf(projection)
      .filter((item: any) => continuation !== undefined && String(item.runId).endsWith(`:ordinal:${continuation.ordinal}`))
      .map((item: any) => ({ type: item.type, status: item.status, text: String(item.text ?? item.input ?? "").slice(0, 200) }));
    finish(arg("out") ?? `spi1043-restart-${cli}.json`, { cli, workspace, key, first, interrupted, settledAfterMs, oldProcessGoneMs, runs, continuationItems, third });
    break;
  }
  case "idle": {
    // SPI-1043: a CLI session nobody is connected to. The Environment resets when idle (no client), its reads (the
    // processes' heartbeat) stop, the Workspace kills the process at the lapse and stops the Container; the next turn
    // resumes the native thread.
    const cookie = await pair();
    const cli = arg("cli") ?? "codex";
    const workspace = workspaceArg(`cli-${cli}`);
    await enable(cookie, cli, cli);
    const first = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "Remember the code word PLOVER-88 for later. Reply with ok only." });
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    const endedAt = Date.now();
    const timeline: Array<Record<string, unknown>> = [];
    let processGoneMs: number | null = null;
    let releasedMs: number | null = null;
    while (Date.now() - endedAt < 15 * 60_000) {
      await sleep(15_000);
      const state = await processState(workspace);
      const container = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces?.find((ws: any) => ws.id === workspace)?.container ?? null;
      const mine = (state?.workspace?.processes ?? []).filter((p: any) => p.thread === first.threadId);
      timeline.push({ s: Math.round((Date.now() - endedAt) / 1000), processes: mine.length, channel: state?.channel ?? null, container });
      if (processGoneMs === null && mine.length === 0) processGoneMs = Date.now() - endedAt;
      if (container?.running === false && container?.leased === false) {
        releasedMs = Date.now() - endedAt;
        break;
      }
    }
    check("the idle session's process ended", processGoneMs !== null, timeline.at(-1));
    check("the Container stopped and its lease went", releasedMs !== null, timeline.at(-1));
    const budget = (await admin("GET", "/_t3flare/agents/budget")).json;
    const second = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
    check("turn 2 completed", second.runs.at(-1)?.status === "completed", second.runs);
    check("turn 2 knew the code word", second.text.includes("PLOVER-88"), second.text);
    const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
    check("the same native thread", JSON.stringify(native(first)) === JSON.stringify(native(second)), { first: native(first), second: native(second) });
    finish(arg("out") ?? `spi1043-idle-${cli}.json`, { cli, workspace, first, processGoneMs, releasedMs, timeline, budget, second });
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
