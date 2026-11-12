// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off
// Step 4a's acceptance (`acceptance.ts --codex` / `--pi`): on a fresh clone of the fixture, the key route refused with no
// CLI alive; a CLI turn at approval-required that edits a file and runs `bash test.sh`, each asked and approved; the
// Container stopped; a second turn that resumes the same native thread (the protocol trace, no handoff); the leak check
// clean. The Workspace is removed afterwards.
import { admin, sleep } from "./client.ts";
import { cliTurn, enable } from "./cliTurn.ts";

export interface CliAcceptanceReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

export const cliAcceptance = async (cookie: string, cli: "codex" | "pi"): Promise<CliAcceptanceReport> => {
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
    return ok;
  };
  const workspace = `acceptance-${cli}-${Date.now().toString(36)}`;
  const report: Record<string, unknown> = { cli, workspace };
  await enable(cookie, cli, cli);
  await admin("GET", "/_t3flare/agents/router-trace?clear=1");

  const first = await cliTurn(cookie, {
    cli,
    workspace,
    mode: "approval-required",
    plan: false,
    prompt: "In src/greeting.txt add a new last line `Hello from the CLI acceptance.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed.",
  });
  report.first = first;
  check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
  check("turn 1 asked and each ask was approved", first.requests.length >= 2 && first.requests.every((request: any) => request.status === "resolved"), first.requests);
  check("bash test.sh exited 0", first.items.some((item: any) => item.type === "command_execution" && /test\.sh/.test(String(item.input)) && item.exitCode === 0), first.items);

  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  let container: any = null;
  for (let i = 0; i < 6 && container?.running !== false; i++) {
    await sleep(5000);
    container = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces?.find((ws: any) => ws.id === workspace)?.container ?? null;
  }
  report.stopped = container;
  check("the Container stopped and its lease went", container?.running === false && container?.leased === false, container);

  const second = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, prompt: "What line did you add to src/greeting.txt in the last turn? Quote it, and do not run anything.", threadId: first.threadId });
  report.second = second;
  check("turn 2 completed", second.runs.at(-1)?.status === "completed", second.runs);
  const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
  check("the same native thread", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(second)), { first: native(first), second: native(second) });
  const trace = ((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>;
  const protocol = trace.filter((entry) => entry.route === "protocol");
  report.protocol = protocol;
  check("the CLI resumed its native thread", protocol.some((entry) => String(entry.detail).includes(String(native(first)[0])) && !String(entry.detail).startsWith("failed")), protocol);

  const leak = (await admin("POST", `/_t3flare/check/leak?id=${workspace}`)).json;
  report.leak = leak;
  check("no credential in the Workspace or its Container", (leak?.do ?? []).length === 0 && (leak?.container?.hits ?? []).length === 0 && leak?.flagged === null, leak);

  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  const keyRoute = (await admin("POST", `/_t3flare/agents/workspace-call?id=${workspace}`, { exec: { script: "curl -s -o /dev/null -w '%{http_code}' http://computer.internal/t3flare/model-key?cli=x", timeoutMs: 180_000 } })).json?.result?.stdout;
  report.keyRouteWithoutCli = keyRoute;
  check("the key route refuses with no CLI process", keyRoute === "403", keyRoute);
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
  return { ok: failures.length === 0, failures, ...report };
};
