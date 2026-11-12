// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// The back-to-stock step's stage cases (docs/steps/stock-plan.md): pushes land from the agent's own shell with no card
// of t3flare's, under the thread's mode (Durable, Codex, and a linked thread under its link's mode); Claude Code runs a
// repository's own `.claude/settings.json` hook; Codex's `auto` runs as t3 runs it. Evidence goes to docs/steps/stock/.
//
//   node scripts/stage.ts run stock stock push|linked|hook|auto|claude-auto|all
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { cliTurn as acpTurn, enable as enableAcp, ensureProject as ensureAcpProject } from "./lib/acpTurn.ts";
import { cliTurn, enable as enableCli } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, mutateProject, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, updateSettings, uuid, wsCall } from "./lib/client.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const DURABLE = { instanceId: "piDurable", model: "anthropic/claude-sonnet-5-5", options: [{ id: "thinking", value: "low" }] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/stock");
const marker = Date.now().toString(36);

const SECRET_KEYS = /token|authorization|cookie|secret|handle|bearer|credential|csrf/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  // A GitHub token in any text (an agent's output) never reaches evidence.
  return typeof value === "string" ? value.replace(/gh[sopu]_[A-Za-z0-9]{20,}/g, "[token]").replace(/x-access-token:[^@\s]+/g, "x-access-token:[token]") : value;
};
const writeEvidence = (name: string, value: unknown) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/stock/${name}`);
};

const cookie = await pair();

/** The fixture's branch on GitHub, read with the local `gh` (the owner's own sign-in), or null. */
const remoteSha = (branch: string): string | null => {
  const result = spawnSync("gh", ["api", `repos/${FIXTURE}/git/ref/heads/${branch}`, "--jq", ".object.sha"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const deleteBranch = (branch: string) => spawnSync("gh", ["api", "-X", "DELETE", `repos/${FIXTURE}/git/refs/heads/${branch}`], { encoding: "utf8" });

const pushPrompt = (branch: string) =>
  `Run exactly this one shell command with your shell tool, nothing else, then reply with its last line of output:\n\ngit -c user.name=t3flare -c user.email=t3flare@example.invalid commit --allow-empty -m "stock push ${branch}" && git push origin HEAD:refs/heads/${branch} 2>&1 | tail -3`;

/** Cards t3flare would have raised for a push: none may exist since the cut. */
const pushCards = (cards: ReadonlyArray<{ readonly prompt?: string; readonly title?: string }>) => cards.filter((card) => /allow git push|t3flare-push/i.test(`${card.title ?? ""} ${card.prompt ?? ""}`));

let durableOn = false;
const durableThread = async (label: string, mode: string) => {
  if (!durableOn) {
    await enableCli(cookie, "piDurable", "piDurable");
    durableOn = true;
  }
  const id = `stock-${label}-${marker}`;
  const destination = `/w/${id}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: destination })) as { cwd?: string };
  if (cloned.cwd !== destination) throw new Error(`clone failed: ${JSON.stringify(cloned).slice(0, 300)}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: destination, createWorkspaceRootIfMissing: false });
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: id, modelSelection: DURABLE, runtimeMode: mode, interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return { id, threadId, projectId };
};

/** Sends `text`, answers every card with accept, until the run settles; the cards it saw. */
const watch = async (threadId: string, send: () => Promise<unknown>, quietPolls = 1, runsBefore?: number) => {
  const started = Date.now();
  const before = runsBefore ?? runsOf(projectionOf(await threadWindow(cookie, threadId).catch(() => undefined))).length;
  await send();
  const answered = new Set<string>();
  const cards: Array<{ kind: string; title: string; prompt: string; options: unknown }> = [];
  let projection: any;
  let quiet = 0;
  while (Date.now() - started < 10 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined)) ?? projection;
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      const item = itemsOf(projection).find((candidate: any) => candidate.requestId === request.id);
      cards.push({ kind: request.kind, title: String(item?.title ?? ""), prompt: String(item?.prompt ?? "").slice(0, 600), options: item?.options ?? null });
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(projection);
    const settled = runs.length > before && runs.every((run: any) => SETTLED.has(run.status)) && !(projection?.runtimeRequests ?? []).some((r: any) => r.status === "pending");
    quiet = settled ? quiet + 1 : 0;
    if (quiet >= quietPolls) break;
    await sleep(1500);
  }
  const text = itemsOf(projection).filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "")).join("").slice(-400);
  return { cards, status: runsOf(projection).at(-1)?.status ?? null, text, ms: Date.now() - started };
};

type Case = Record<string, unknown> & { readonly name: string; readonly ok: boolean };

const push = async () => {
  const cases: Array<Case> = [];
  // Durable, at approval-required (its command asks, as the mode says) and at full access (nothing asks).
  for (const mode of ["approval-required", "full-access"]) {
    const branch = `stock-durable-${mode === "full-access" ? "fa" : "ar"}-${marker}`;
    const thread = await durableThread(`durable-${mode === "full-access" ? "fa" : "ar"}`, mode);
    const run = await watch(thread.threadId, () => sendMessage(cookie, thread.threadId, pushPrompt(branch), DURABLE));
    const sha = remoteSha(branch);
    cases.push({
      name: `Durable at ${mode}: the push lands from the agent's shell, no push card${mode === "full-access" ? ", no card at all" : "; the command's own card"}`,
      branch,
      landed: sha !== null,
      ...run,
      ok: sha !== null && pushCards(run.cards).length === 0 && (mode === "full-access" ? run.cards.length === 0 : run.cards.every((card) => card.kind === "command")),
    });
    deleteBranch(branch);
  }
  // Codex, at full access and approval-required.
  await enableCli(cookie, "codex", "codex");
  for (const mode of ["full-access", "approval-required"]) {
    const branch = `stock-codex-${mode === "full-access" ? "fa" : "ar"}-${marker}`;
    const result = await cliTurn(cookie, { cli: "codex", workspace: `stock-codex-${mode === "full-access" ? "fa" : "ar"}-${marker}`, mode, plan: false, prompt: pushPrompt(branch), approve: "accept" });
    const sha = remoteSha(branch);
    cases.push({
      name: `Codex at ${mode}: the push lands with no push card${mode === "full-access" ? ", no card at all" : "; Codex's own command cards"}`,
      branch,
      landed: sha !== null,
      runs: result.runs,
      requests: result.requests,
      text: result.text,
      ok: sha !== null && !result.requests.some((request: any) => String(request.id).includes("t3flare-")) && (mode === "full-access" ? result.requests.length === 0 : true),
    });
    deleteBranch(branch);
  }
  writeEvidence("push.json", { cases, ok: cases.every((c) => c.ok) });
  return cases;
};

/** A linked thread launched over a Peer link at `access`, in a fresh Durable project; every card accepted. */
const linked = async () => {
  const cases: Array<Case> = [];
  await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
  for (const access of ["full-access", "approval-required"] as const) {
    const label = access === "full-access" ? "fa" : "ar";
    const branch = `stock-linked-${label}-${marker}`;
    const project = await durableThread(`linked-${label}`, "approval-required");
    const link = await signIn((await mintPairingCode(cookie, { label: `stock ${label}` })).code, access, { clientName: `stock ${label}` });
    const mcp = new McpClient(link.token, { modeLimit: `${access}/default` });
    let threadId: string | undefined;
    const run = await (async () => {
      const launched = await mcp.call("t3_thread_launch", { projectId: project.projectId, title: `stock linked ${label}`, modelSelection: DURABLE, clientRequestId: `stock-linked-${label}-${marker}`, message: pushPrompt(branch) });
      threadId = launched.json?.threadId;
      if (threadId === undefined) throw new Error(`linked launch failed: ${launched.text.slice(0, 300)}`);
      // The launch already started its run: every run of the thread counts.
      return watch(threadId, () => Promise.resolve(), 4, 0);
    })();
    const sha = remoteSha(branch);
    cases.push({
      name: `linked thread at ${access === "full-access" ? "a" : "an"} ${access} link: the push follows the link's mode, no push card${access === "full-access" ? ", no card at all" : "; the command's own card"}`,
      branch,
      landed: sha !== null,
      ...run,
      ok: sha !== null && pushCards(run.cards).length === 0 && (access === "full-access" ? run.cards.length === 0 : run.cards.every((card) => card.kind === "command")),
    });
    deleteBranch(branch);
  }
  writeEvidence("linked-push.json", { cases, ok: cases.every((c) => c.ok) });
  return cases;
};

const exec = async (workspace: string, script: string) =>
  (await admin("POST", `/_t3flare/agents/workspace-call?id=${workspace}`, { exec: { script, cwd: "/workspace/repo", timeoutMs: 60_000 } })).json?.result ?? {};

/** Claude Code in a repository whose `.claude/settings.json` has a hook: the hook runs (owner, 2026-11-12, back to stock). */
const hook = async () => {
  await enableAcp(cookie, "claude");
  const workspace = `stock-hook-${marker}`;
  await ensureAcpProject(cookie, workspace);
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo hook-ran-${marker} > /tmp/t3flare-stock-hook` }] }] } };
  const planted = await exec(workspace, `mkdir -p .claude && printf '%s' '${JSON.stringify(settings)}' > .claude/settings.json && rm -f /tmp/t3flare-stock-hook && cat .claude/settings.json`);
  const result = await acpTurn(cookie, { cli: "claude", workspace, mode: "full-access", plan: false, prompt: "Reply with the single word OK. Do not run any tool.", approve: "accept" });
  const seen = await exec(workspace, "cat /tmp/t3flare-stock-hook 2>&1");
  const out = String(seen.stdout ?? "").trim();
  const cases: Array<Case> = [{ name: "Claude Code runs the repository's own UserPromptSubmit hook", planted: String(planted.stdout ?? "").slice(0, 300), runs: result.runs, text: result.text, hookOutput: out, ok: out === `hook-ran-${marker}` }];
  writeEvidence("claude-hook.json", { workspace, cases, ok: cases.every((c) => c.ok) });
  return cases;
};

/** Codex at t3's `auto`: on-request with Codex's own reviewer; an in-Workspace write runs, an escalation is reviewed, not carded. */
const auto = async () => {
  await enableCli(cookie, "codex", "codex");
  const workspace = `stock-auto-${marker}`;
  const cases: Array<Case> = [];
  const inside = await cliTurn(cookie, { cli: "codex", workspace, mode: "auto", plan: false, prompt: `Run this shell command and reply with its output: echo auto-${marker} > auto.txt && cat auto.txt`, approve: "decline" });
  const file = String((await exec(workspace, "cat auto.txt 2>&1")).stdout ?? "").trim();
  cases.push({ name: "Codex auto: a write inside the Workspace runs without a card", runs: inside.runs, requests: inside.requests, text: inside.text, file, ok: file === `auto-${marker}` && inside.requests.length === 0 });
  const outside = await cliTurn(cookie, { cli: "codex", workspace, mode: "auto", plan: false, prompt: `Run this shell command (it needs to write outside the workspace; request escalated permissions if needed) and reply with its output: echo outside-${marker} > /var/tmp/t3flare-auto-${marker} && cat /var/tmp/t3flare-auto-${marker}`, approve: "decline" });
  const outsideFile = String((await exec(workspace, `cat /var/tmp/t3flare-auto-${marker} 2>&1`)).stdout ?? "").trim();
  const items = outside.items.map((item: any) => item.type);
  cases.push({
    name: "Codex auto: an escalation goes to Codex's reviewer (auto_review), not to the owner (cards declined if any appear)",
    runs: outside.runs,
    requests: outside.requests,
    items,
    text: outside.text,
    outsideFile,
    ok: outside.runs.at(-1)?.status === "completed" && outside.requests.length === 0,
  });
  writeEvidence("codex-auto.json", { workspace, cases, ok: cases.every((c) => c.ok) });
  return cases;
};

/** Claude at t3's `auto` (informational): its own auto mode, or the asking mode when it does not offer auto. */
const claudeAuto = async () => {
  await enableAcp(cookie, "claude");
  const workspace = `stock-claude-auto-${marker}`;
  const result = await acpTurn(cookie, { cli: "claude", workspace, mode: "auto", plan: false, prompt: `Run this shell command and reply with its output: echo claude-auto-${marker} > claude-auto.txt && cat claude-auto.txt`, approve: "accept" });
  const file = String((await exec(workspace, "cat claude-auto.txt 2>&1")).stdout ?? "").trim();
  const cases: Array<Case> = [{ name: "Claude at t3's auto: the turn runs (Claude's auto mode decides what to ask; any card is accepted)", runs: result.runs, requests: result.requests, text: result.text, file, ok: result.runs.at(-1)?.status === "completed" && file === `claude-auto-${marker}` }];
  writeEvidence("claude-auto.json", { workspace, cases, ok: cases.every((c) => c.ok) });
  return cases;
};

const which = process.argv[2] ?? "all";
const all: Array<Case> = [];
if (which === "push" || which === "all") all.push(...(await push()));
if (which === "linked" || which === "all") all.push(...(await linked()));
if (which === "hook" || which === "all") all.push(...(await hook()));
if (which === "auto" || which === "all") all.push(...(await auto()));
if (which === "claude-auto" || which === "all") all.push(...(await claudeAuto()));
for (const c of all) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
process.exit(all.every((c) => c.ok) ? 0 : 1);
