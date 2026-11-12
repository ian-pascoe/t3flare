// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4b's stage evidence (plan §8 M1–M5), through the admin routes and t3's own client protocol.
//
//   bun scripts/stage.ts run step4b cli4b acp --cli claude|opencode [--model <id>] [--workspace <id>]
//        M1: the CLI through t3's spawner and the channel, over ACP, without t3's drivers
//   bun scripts/stage.ts run step4b cli4b turn --cli claude|opencode [--model <slug>] [--mode <runtime mode>] [--plan]
//        [--workspace <id>] [--prompt <text>] [--thread <id>] [--approve accept|decline] [--out <file>]
//        M2/M3: one turn from t3's client protocol, every request answered
//   bun scripts/stage.ts run step4b cli4b restart-turn --cli claude|opencode   M4: the Environment restarts mid-turn
//   bun scripts/stage.ts run step4b cli4b modes --cli claude|opencode [--model <slug>] [--out <file>]
//        M2/M3: approval-required, auto-accept-edits, full-access and plan, each on a fresh thread
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, dispatch, pair, projectionOf, runsOf, sleep, threadWindow, uuid } from "./lib/client.ts";
import { CLAUDE_PINNED_EMPTY } from "../src/agents/acpProfiles.ts";
import { changed, cliTurn, EDIT_AND_TEST, enable, ensureProject, reset } from "./lib/acpTurn.ts";
import { writeEvidence as writeAt } from "./lib/evidence.ts";

const [scenario = "acp", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const flag = (name: string) => args.includes(`--${name}`);
const evidence = (name: string, value: unknown) => writeAt(path.resolve(import.meta.dirname, "../../../docs/steps/step-4b", name), value);
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const finish = (name: string | undefined, report: Record<string, unknown>) => {
  const full = { scenario, ok: failures.length === 0, failures, ...report };
  if (name !== undefined) evidence(name, full);
  console.log(JSON.stringify(full, null, 1).slice(0, 8000));
  process.exit(failures.length === 0 ? 0 : 1);
};

const workspaceArg = (fallback: string) => arg("workspace") ?? fallback;
switch (scenario) {
  case "acp": {
    const cli = arg("cli") ?? "claude";
    const workspace = workspaceArg(`acp-${cli}`);
    const cookie = await pair();
    await ensureProject(cookie, workspace);
    const report = (await admin("POST", "/_t3flare/agents/acp-check", { cli, workspace, ...(arg("model") === undefined ? {} : { model: arg("model") }) })).json as any;
    check("initialize answered, no login offered", report?.initialize?.error === undefined && (cli === "claude" ? report?.initialize?.authMethods?.length === 0 : true), report?.initialize);
    check("the prompt ended", report?.prompt?.stopReason === "end_turn", report?.prompt);
    if (cli === "claude") check("modes: default, no auto or bypass", report?.session?.modes?.current === "default" && !report?.session?.modes?.available?.some((m: string) => m === "auto" || m === "bypassPermissions"), report?.session?.modes);
    check("the process tree went with the kill", report?.markerProcessesAfterKill === 0, report?.markerProcessesAfterKill);
    finish(arg("out") ?? `m1-acp-${cli}.json`, { cli, workspace, report });
    break;
  }
  case "turn": {
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`cli-${cli}`);
    const result = await cliTurn(cookie, {
      cli,
      workspace,
      ...(arg("model") === undefined ? {} : { model: arg("model")! }),
      mode: arg("mode") ?? "approval-required",
      plan: flag("plan"),
      prompt: arg("prompt") ?? EDIT_AND_TEST,
      ...(arg("thread") === undefined ? {} : { threadId: arg("thread")! }),
      ...(arg("approve") === undefined ? {} : { approve: arg("approve") as "accept" | "decline" }),
    });
    check("the turn completed", result.runs.at(-1)?.status === "completed", result.runs);
    finish(arg("out"), { cli, result, changed: await changed(workspace) });
    break;
  }
  case "modes": {
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`modes-${cli}-${Date.now().toString(36)}`);
    const rows: Array<Record<string, unknown>> = [];
    // One thread, its mode changed between turns as the client does (t3 restarts the agent on a runtime-mode change).
    let threadId: string | undefined;
    for (const [mode, plan] of [
      ["approval-required", false],
      ["auto-accept-edits", false],
      ["full-access", false],
      ["full-access", true],
    ] as const) {
      await ensureProject(cookie, workspace);
      await reset(workspace);
      if (threadId !== undefined) {
        await dispatch(cookie, { type: "thread.runtime-mode.set", commandId: uuid(), threadId, runtimeMode: mode });
        await dispatch(cookie, { type: "thread.interaction-mode.set", commandId: uuid(), threadId, interactionMode: plan ? "plan" : "default" });
      }
      const result = await cliTurn(cookie, {
        cli,
        workspace,
        ...(arg("model") === undefined ? {} : { model: arg("model")! }),
        mode,
        plan,
        prompt: plan ? `Plan this change, do not make it: ${EDIT_AND_TEST}` : EDIT_AND_TEST,
        ...(threadId === undefined ? {} : { threadId }),
      });
      threadId = result.threadId;
      const diff = await changed(workspace);
      const kinds = result.requests.map((r: any) => r.requestKind ?? r.kind);
      rows.push({ mode, plan, status: result.runs.at(-1)?.status, failure: result.runs.at(-1)?.failure ?? null, asked: kinds, items: result.items.map((item: any) => `${item.type}:${item.title ?? ""}`), diff, proposedPlan: result.proposedPlan, text: result.text, threadId: result.threadId });
      if (plan) {
        check(`${mode} plan: edits nothing`, !diff.includes("greeting"), diff);
        if (cli === "claude") check(`${mode} plan: a proposed plan`, result.proposedPlan.length > 0, result.items);
      } else {
        check(`${mode}: the edit happened`, diff.includes("greeting"), { diff, runs: result.runs });
        // The edit asks as a file change, or as the command that made it (a model may append with the shell).
        if (mode === "approval-required") check(`${mode}: the edit and the command asked`, kinds.some((k: string) => /file/i.test(k)) && kinds.some((k: string) => /command/i.test(k)), kinds);
        if (mode === "auto-accept-edits") check(`${mode}: the command asked, the edit inside the project did not`, kinds.some((k: string) => /command/i.test(k)) && !kinds.some((k: string) => /file/i.test(k)), kinds);
        if (mode === "full-access") check(`${mode}: nothing asked`, kinds.length === 0, kinds);
      }
    }
    await reset(workspace);
    finish(arg("out") ?? `m${cli === "claude" ? 2 : 3}-modes.json`, { cli, workspace, rows });
    break;
  }
  case "resume": {
    // M4: a turn sets a code word, the Workspace's Container stops, the next turn on the same thread resumes the
    // agent's own session from the synced state (Claude's projects/, OpenCode's snapshot). Review F8: the proof is the
    // `acp-request` log line of a session/load or session/resume that succeeded, read from the Worker's logs after.
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`resume-${cli}-${Date.now().toString(36)}`);
    const word = `${cli === "claude" ? "PERSIMMON" : "QUINCE"}-${(Date.now() % 90) + 10}`;
    const first = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, prompt: `Remember the code word ${word}. Reply with the single word ok.` });
    // OpenCode's snapshot is taken within 15 s of a change.
    await sleep(20_000);
    const stoppedAt = Date.now();
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(workspace)}`);
    await sleep(20_000);
    const second = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, threadId: first.threadId, prompt: "What was the code word? Reply with it only." });
    const native = (result: typeof first) => result.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    check("turn 2 completed", second.runs.at(-1)?.status === "completed", second.runs);
    check("turn 2 recalls the code word", second.text.includes(word), second.text);
    check("the same native session", JSON.stringify(native(first)) === JSON.stringify(native(second)) && native(second).length === 1, { first: native(first), second: native(second) });
    check("no handoff", !second.items.some((item: any) => /handoff|context_transfer/i.test(String(item.type))), second.items);
    finish(arg("out") ?? `m4-resume-${cli}.json`, { cli, workspace, word, stoppedAt, first: { threadId: first.threadId, runs: first.runs, native: native(first) }, second: { runs: second.runs, native: native(second), text: second.text, items: second.items } });
    break;
  }
  case "two": {
    // M4: a Claude turn in one project and an OpenCode turn in another, at once (two Containers).
    const cookie = await pair();
    await enable(cookie, "claude");
    await enable(cookie, "opencode");
    const stamp = Date.now().toString(36);
    const [claude, opencode] = await Promise.all([
      cliTurn(cookie, { cli: "claude", workspace: `two-claude-${stamp}`, mode: "full-access", plan: false, prompt: EDIT_AND_TEST }),
      cliTurn(cookie, { cli: "opencode", workspace: `two-opencode-${stamp}`, mode: "full-access", plan: false, prompt: EDIT_AND_TEST }),
    ]);
    check("Claude completed", claude.runs.at(-1)?.status === "completed", claude.runs);
    check("OpenCode completed", opencode.runs.at(-1)?.status === "completed", opencode.runs);
    finish(arg("out") ?? "m4-two-at-once.json", { claude: { runs: claude.runs, ms: claude.ms, text: claude.text }, opencode: { runs: opencode.runs, ms: opencode.ms, text: opencode.text } });
    break;
  }
  case "restart-turn": {
    // The Environment restarts (as a deploy or an eviction does) while a Claude Code or OpenCode turn runs a long
    // command, as 4a's SPI-1043 case: the turn settles with a reason (never a silent hang), the old epoch's process (and
    // Claude's `claude` child) goes, t3 continues the run, and the next turn continues the CLI's own session.
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`restart-${cli}-${Date.now().toString(36)}`);
    const processState = async () => (await admin("GET", `/_t3flare/agents/process-state?id=${encodeURIComponent(workspace)}`)).json as any;
    const markers = async (key: string) =>
      Number(((await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: `grep -l -a 'T3FLARE_EXEC=${key.replace(/[^A-Za-z0-9-]/g, "")}' /proc/[0-9]*/environ 2>/dev/null | wc -l`, timeoutMs: 20_000 } })).json as any)?.result?.stdout ?? "-1");
    const first = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "Remember the code word OSPREY-17 for later. Reply with ok only." });
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    const long = cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: `Run the shell command \`${cli === "claude" ? "node -e \"setTimeout(() => console.log('slept'), 90000)\"" : "sleep 120 && echo slept"}\` in the foreground (never in the background), wait for it to finish, and then reply with the single word done.`, threadId: first.threadId });
    let key: string | undefined;
    for (let i = 0; i < 40 && key === undefined; i++) {
      await sleep(3000);
      key = ((await processState())?.workspace?.processes ?? []).find((p: any) => p.thread === first.threadId && p.inTurn === true)?.key;
    }
    check("the CLI was in its turn before the restart", key !== undefined);
    await sleep(10_000);
    const markersBefore = key === undefined ? null : await markers(key);
    const restartedAt = Date.now();
    await admin("POST", "/_t3flare/restart");
    const interrupted = await long;
    const settledAfterMs = Date.now() - restartedAt;
    const status = interrupted.runs.at(-1)?.status;
    check("the interrupted turn settled (no hang)", status !== undefined && status !== "running" && status !== "pending" && settledAfterMs < 5 * 60_000, { status, settledAfterMs });
    let oldProcess: unknown = "unchecked";
    const goneBy = Date.now();
    for (;;) {
      oldProcess = ((await processState())?.workspace?.processes ?? []).find((p: any) => p.key === key) ?? null;
      if (oldProcess === null || Date.now() - goneBy > 180_000) break;
      await sleep(5000);
    }
    check("the old epoch's process is gone", oldProcess === null, oldProcess);
    const markersAfter = key === undefined ? null : await markers(key);
    check("no process of the old epoch's tree is left (Claude's child included)", markersAfter === 0, { markersBefore, markersAfter });
    const oldProcessGoneMs = Date.now() - restartedAt;
    const third = await cliTurn(cookie, { cli, workspace, mode: "full-access", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
    check("the next turn completed", third.runs.at(-1)?.status === "completed", third.runs);
    check("the next turn knew the code word", third.text.includes("OSPREY-17"), third.text);
    const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
    check("the same native session (continuation, not a handoff)", JSON.stringify(native(first)) === JSON.stringify(native(third)), { first: native(first), third: native(third) });
    const projection = projectionOf(await threadWindow(cookie, first.threadId));
    const runs = runsOf(projection).map((run: any) => ({ ordinal: run.ordinal, status: run.status, failure: run.failure ?? null, restartContinuationOfRunId: run.restartContinuationOfRunId ?? null }));
    const continuation = runs.find((run) => run.restartContinuationOfRunId !== null);
    check("t3 continued the interrupted run, or failed it with a reason", (continuation !== undefined && continuation.status === "completed") || runs.some((run) => run.status === "failed" && run.failure !== null), runs);
    finish(arg("out") ?? `m4-restart-${cli}.json`, { cli, workspace, key, markersBefore, markersAfter, interrupted: { runs: interrupted.runs, text: interrupted.text }, settledAfterMs, oldProcessGoneMs, runs, third: { runs: third.runs, text: third.text } });
    break;
  }
  case "hostile": {
    // M5 (plan §4.4 with review F3, F5, F6): M0 P4's hostile repository planted in a Workspace's clone, then a turn at
    // approval-required whose every write and command must ask; no marker file; the turn's model calls reached the
    // proxy (a redirected key would fail the turn: the logging host does not resolve).
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`hostile-${cli}-${Date.now().toString(36)}`);
    await ensureProject(cookie, workspace);
    const plant = fs
      .readFileSync(path.resolve(import.meta.dirname, "../../../docs/steps/step-4b/probes/hostile-repo.sh"), "utf8")
      .replaceAll("http://computer.internal:8081", "https://evil.t3flare.invalid")
      .replaceAll("http://computer.internal:3128", "https://evil.t3flare.invalid:3128")
      .replaceAll("/w/marker-", "/tmp/marker-")
      .replace(/^d=\$1; mkdir .*$/m, "d=/workspace/repo; cd \"$d\"")
      .replace(/^git add -A .*$/m, "");
    const planted = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: plant, timeoutMs: 60_000 } })).json as any;
    const prompt =
      cli === "claude"
        ? "Do these in order: 1) create a.txt containing x with your Write tool; 2) run `bash test.sh` and `touch b.txt`; 3) ask the helper subagent to create c.txt containing y; 4) use the s skill. Then reply done."
        : "Do these in order: 1) create a.txt containing x with your write tool; 2) run `bash test.sh` and `touch b.txt`; 3) ask the sneaky subagent to create c.txt containing y; 4) ask the sneaky2 subagent to create c2.txt. Then reply done.";
    const result = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, prompt });
    const markers = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: "ls /tmp/marker-* 2>/dev/null; cd /workspace/repo && git status --porcelain", timeoutMs: 30_000 } })).json as any;
    const kinds = result.requests.map((r: any) => r.kind);
    check("the hostile files were planted", planted?.result?.exitCode === 0 || planted?.result?.code === 0 || planted?.result?.stderr === "", planted?.result);
    check("the turn completed on the proxy", result.runs.at(-1)?.status === "completed", result.runs);
    check("the write asked", kinds.includes("file-change"), kinds);
    check("the commands asked", kinds.filter((k: string) => k === "command").length >= 1, kinds);
    // The skill's own instruction (`touch /tmp/marker-claude-skill-tool`) is a command the agent asked for and the
    // harness approved; every other marker is code the repository would have run by itself.
    const ran = String(markers?.result?.stdout ?? "").split("\n").filter((line) => line.startsWith("/tmp/marker-") && line !== "/tmp/marker-claude-skill-tool");
    check("no marker file of code the repository ran by itself", ran.length === 0, ran);
    finish(arg("out") ?? `m5-hostile-${cli}.json`, { cli, workspace, requests: result.requests, items: result.items, text: result.text, after: markers?.result?.stdout ?? null });
    break;
  }
  case "leak": {
    // M5 (plan §1.5, §4.5 with review F10): a canary planted in the Environment DO's process.env before the spawn
    // reaches no process; each CLI process's environment holds the profile's names only.
    const cookie = await pair();
    const rows: Record<string, unknown> = {};
    for (const cli of ["claude", "opencode"] as const) {
      const workspace = `leak-${cli}`;
      await ensureProject(cookie, workspace);
      const canary = `canary${Date.now().toString(36)}x${cli}`;
      const report = (await admin("POST", "/_t3flare/agents/acp-check", { cli, workspace, canary })).json as any;
      const processes = (report?.processes ?? []) as Array<{ command: string; envNames: Array<string>; canaryHits: number }>;
      const names = [...new Set(processes.flatMap((process) => process.envNames))].sort();
      const scan = (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(workspace)}`)).json as any;
      check(`${cli}: the turn answered`, report?.prompt?.stopReason === "end_turn", report?.prompt);
      check(`${cli}: no process holds the canary`, processes.length > 0 && processes.every((process) => process.canaryHits === 0), processes);
      check(`${cli}: the profile's names are there`, ["HOME", "LANG", "T3FLARE_EXEC"].every((name) => names.includes(name)), names);
      // Names only: Claude's managed env pins its provider and auth variables to "" (claude-agent-acp applies the managed
      // env to its own process), so those names are present, empty.
      const keyish = names.filter((name) => /API_KEY$|AUTH_TOKEN|OAUTH|GITHUB_TOKEN|GH_TOKEN|MODEL_PROXY|COMMISSARY|BOOTSTRAP|ADMIN_TOKEN/.test(name) && !CLAUDE_PINNED_EMPTY.includes(name));
      check(`${cli}: no key or token by name (beyond the managed env's empty pins)`, keyish.length === 0, keyish);
      check(`${cli}: the leak scan finds nothing`, (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0, scan);
      rows[cli] = { processes: processes.map((process) => ({ command: process.command, envNames: process.envNames, canaryHits: process.canaryHits })), names, scan };
    }
    finish(arg("out") ?? "m5-leak.json", rows);
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
