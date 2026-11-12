// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// The acceptance test's Claude Code and OpenCode checks (step 4b, plan §9; `scripts/acceptance.ts --claude --opencode`):
// on a fresh clone of the fixture, an approval-required turn whose edit and `bash test.sh` are each asked and
// approved, the diff, then a plan turn on the same thread that edits nothing (Claude's with a proposed plan), and 4a's
// leak check of the Workspace.
import { admin, dispatch, uuid } from "./client.ts";
import { changed, cliTurn, EDIT_AND_TEST, enable, reset } from "./acpTurn.ts";

export interface AcpAcceptanceReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

export const acpAcceptance = async (cookie: string, cli: "claude" | "opencode"): Promise<AcpAcceptanceReport> => {
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
    return ok;
  };
  const workspace = `acceptance-${cli}-${Date.now().toString(36)}`;
  await enable(cookie, cli);
  const turn = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, prompt: EDIT_AND_TEST });
  const diff = await changed(workspace);
  const kinds = turn.requests.map((request: any) => request.kind);
  check("the turn completed", turn.runs.at(-1)?.status === "completed", turn.runs);
  check("the edit and the command were each asked and approved", kinds.includes("file-change") && kinds.includes("command") && turn.requests.every((r: any) => r.decision === "accept"), turn.requests);
  check("the diff holds the edit", diff.includes("greeting"), diff);
  await reset(workspace);
  await dispatch(cookie, { type: "thread.interaction-mode.set", commandId: uuid(), threadId: turn.threadId, interactionMode: "plan" });
  const plan = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: true, threadId: turn.threadId, prompt: `Plan this change, do not make it: ${EDIT_AND_TEST}` });
  const planDiff = await changed(workspace);
  check("the plan turn completed", plan.runs.at(-1)?.status === "completed", plan.runs);
  check("the plan turn edited nothing", !planDiff.includes("greeting"), planDiff);
  if (cli === "claude") check("Claude's plan is t3's proposed plan", plan.proposedPlan.length > 0, plan.items);
  const leak = (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(workspace)}`)).json as any;
  check("no credential in the Workspace's files or processes", (leak?.do ?? []).length === 0 && (leak?.container?.hits ?? []).length === 0, leak);
  return { ok: failures.length === 0, failures, cli, workspace, turn: { runs: turn.runs, requests: turn.requests, diff, ms: turn.ms }, plan: { runs: plan.runs, proposedPlan: plan.proposedPlan, diff: planDiff }, leak };
};
