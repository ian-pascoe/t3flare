// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// SPI-992 on a stage (docs/steps/spi-992-plan.md, M0 and M1; evidence in docs/steps/spi-992/). Runs git in the
// fixture project's Workspace Container through the admin `workspace-call` route, reads GitHub with the owner's `gh`
// (this machine), and never prints a token: a token found in the Container is named by its hash prefix only.
//
//   m1    the system gitconfig (M5); P1: a push through the gateway lands; a fetch works with the read token; the
//         Container's tokens cannot write (git and the REST API); bypassing the gateway fails; a foreign host gets no
//         token; an old helper's request is refused; t3's Commit & push lands through an expectation while tainted
//   p2    a receive-pack POST held 10 minutes by the gateway (probePush holdMs) still lands
//   p3    packs of ~90 MiB and ~110 MiB through the gateway (the documented 100 MiB request cap)
//   hostile  M2: a linked thread (link at auto-accept-edits) runs `scripts/spi992/hostile.sh`: it captures everything
//            around one push the owner approves, then replays the POST, tries every captured string against GitHub
//            directly (git and REST), and pushes through the gateway again; the harness declines the new cards and
//            tries `t3_pending_request respond` from the link (F7)
//   persist  M2/H1: a linked thread runs `scripts/spi992/plant.sh` (core.fsmonitor, a pre-push hook, a payload run by
//            a hook, a detached loop); the window lapses (probe), the Container restarts, the owner runs status and
//            Commit & push: no planted ref appears
//
//   bun scripts/stage.ts run spi992 spi992 <m1|p2|p3>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, dispatch, pair, sleep, uuid, wsStream } from "./lib/client.ts";
import { MODEL, pendingOf, projection, replyOf, settled } from "./lib/cloudThread.ts";
import { ensureCloudFixtureProject, FIXTURE } from "./lib/fixtureProject.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const mode = process.argv[2] ?? "m1";
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  return ok;
};
const stamp = Date.now().toString(36);
const out: Record<string, unknown> = { mode, stamp, fixture: FIXTURE };
const evidence = (name: string) => {
  const file = path.resolve(import.meta.dirname, "../../../docs/steps/spi-992", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...out, failures, ok: failures.length === 0 }, null, 1)}\n`);
  console.log(`wrote docs/steps/spi-992/${name}`);
};

const cookie = await pair();
const fixture = await ensureCloudFixtureProject(cookie);
const id = fixture.workspaceRoot.replace(/^\/w\//, "");
const call = async (body: Record<string, unknown>) => (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, body)).json;
const sh = async (script: string, timeoutMs = 300_000): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> => {
  const answer = await call({ exec: { script, cwd: "/workspace/repo", timeoutMs } });
  return { ...(answer?.result ?? { exitCode: -1, stdout: "", stderr: JSON.stringify(answer).slice(0, 500) }), ms: answer?.ms ?? 0 };
};
/**
 * Runs `script` detached in the Container (an admin request is cut after ~100 s at the edge), polling its log until it
 * prints its exit code. The log's last lines and the exit code.
 */
const detached = async (script: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; ms: number }> => {
  const name = `/tmp/spi992-${uuid()}`;
  await sh(`printf %s ${Buffer.from(`cd /workspace/repo\n${script}\n`).toString("base64")} | base64 -d > ${name}.sh; setsid nohup sh -c 'sh ${name}.sh > ${name}.log 2>&1; echo "DETACHED-EXIT $?" >> ${name}.log' >/dev/null 2>&1 &`);
  const started = Date.now();
  let output = "";
  while (Date.now() - started < timeoutMs) {
    await sleep(15_000);
    output = (await sh(`tail -c 4000 ${name}.log 2>/dev/null`)).stdout;
    if (/DETACHED-EXIT \d+/.test(output)) break;
  }
  const code = /DETACHED-EXIT (\d+)/.exec(output)?.[1];
  return { exitCode: code === undefined ? null : Number(code), output: output.replace(/DETACHED-EXIT \d+\n?/, ""), ms: Date.now() - started };
};

/** The owner's view of a ref on GitHub (gh on this machine); null when absent. */
const remoteRef = (ref: string): string | null => {
  const r = spawnSync("gh", ["api", `repos/${FIXTURE}/git/ref/${ref.replace(/^refs\//, "")}`, "--jq", ".object.sha"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const deleteRef = (ref: string) => spawnSync("gh", ["api", "-X", "DELETE", `repos/${FIXTURE}/git/refs/${ref.replace(/^refs\//, "")}`], { encoding: "utf8" }).status === 0;
const created: Array<string> = [];
const tail = (text: string) => text.trim().split("\n").slice(-6).join("\n").slice(-600);

/** Commits a file of `bytes` random bytes on a fresh branch from origin/main; prints the commit. */
const commitScript = (branch: string, files: Array<[string, number]>) =>
  [
    "set -e",
    "git fetch -q origin main",
    `git checkout -q -B ${branch} origin/main`,
    ...files.map(([name, bytes]) => `head -c ${bytes} /dev/urandom > ${name}`),
    `git add ${files.map(([name]) => name).join(" ")}`,
    `git -c user.name=spi992 -c user.email=spi992@example.invalid commit -qm "spi992 ${branch}"`,
    "git rev-parse HEAD",
  ].join("\n");

if (mode === "m1") {
  await call({ probePush: { holdMs: 0 } });
  // M5: the image's system gitconfig, read back by the Container's git.
  const system = await sh("git config --system --show-origin --get-regexp 'url\\..*\\.pushinsteadof|credential\\.helper' | cut -c1-160; echo; git remote get-url --push origin; git remote get-url origin; git --version");
  out.systemGitconfig = system.stdout.trim().split("\n");
  check("M5: the Container's git sends pushes to github.com through the gateway (system gitconfig)", /computer\.internal\/t3flare\/git\//.test(system.stdout) && /pushinsteadof https:\/\/github\.com\//i.test(system.stdout), system);

  // P1: a push through the gateway, streamed to GitHub, lands (the Workspace is untainted here or trusted again first).
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  const p1Branch = `spi992/p1-${stamp}`;
  const p1Commit = (await sh(commitScript(p1Branch, [[`p1-${stamp}.bin`, 2 * 1024 * 1024]]))).stdout.trim().split("\n").at(-1) ?? "";
  const p1 = await sh(`GIT_TRACE_CURL_NO_DATA=1 git push origin HEAD:refs/heads/${p1Branch} 2>&1`);
  created.push(`refs/heads/${p1Branch}`);
  out.p1 = { exitCode: p1.exitCode, output: tail(p1.stdout), ms: p1.ms, remote: remoteRef(`refs/heads/${p1Branch}`), commit: p1Commit };
  check("P1: a push through the gateway (2 MiB, streamed) lands at the pushed commit", p1.exitCode === 0 && remoteRef(`refs/heads/${p1Branch}`) === p1Commit, out.p1);

  // A fetch works with the helper's read-only token.
  const fetched = await sh("git fetch origin main 2>&1 && echo FETCHED");
  check("a fetch works with the read-only token", fetched.stdout.includes("FETCHED"), tail(fetched.stdout));

  // The Container's tokens cannot write: every ghs_ token found in the Container, and the helper's own.
  const scan = await sh(
    [
      `head=$(git rev-parse HEAD)`,
      `helper=$(printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')`,
      `found=$( { printf '%s\\n' "$helper"; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n'; git config --list 2>/dev/null; } | grep -o 'gh[spou]_[A-Za-z0-9_.-]\\{30,\\}' | sort -u)`,
      `echo "tokens $(printf '%s\\n' $found | grep -c .)"`,
      `for t in $found; do`,
      `  h=$(printf %s "$t" | sha256sum | cut -c1-12)`,
      `  api=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $t" -H 'Accept: application/vnd.github+json' https://api.github.com/repos/${FIXTURE}/git/refs -d "{\\"ref\\":\\"refs/heads/spi992/leak-${stamp}\\",\\"sha\\":\\"$head\\"}")`,
      `  direct=$(git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$t; }; f" -c remote.origin.pushurl=https://github.com/${FIXTURE}.git push -q origin HEAD:refs/heads/spi992/direct-${stamp} >/dev/null 2>&1 && echo pushed || echo refused)`,
      `  read=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" https://api.github.com/repos/${FIXTURE}/contents/README.md)`,
      `  echo "token $h api-write=$api git-direct=$direct api-read=$read"`,
      `done`,
    ].join("\n"),
  );
  created.push(`refs/heads/spi992/leak-${stamp}`, `refs/heads/spi992/direct-${stamp}`);
  const rows = scan.stdout.split("\n").filter((line) => line.startsWith("token "));
  out.containerTokens = rows;
  check("the scan found the helper's token (the scan works)", rows.length >= 1, rows);
  check("no token in the Container can write: REST refused, a direct git push refused", rows.every((row) => !/api-write=20/.test(row) && /git-direct=refused/.test(row)), rows);
  check("the leak and direct refs do not exist on GitHub", remoteRef(`refs/heads/spi992/leak-${stamp}`) === null && remoteRef(`refs/heads/spi992/direct-${stamp}`) === null);

  // The gateway bypassed (pushurl straight to GitHub): only the read-only token, so refused.
  const bypass = await sh(`git -c remote.origin.pushurl=https://github.com/${FIXTURE}.git push origin HEAD:refs/heads/spi992/bypass-${stamp} 2>&1; echo "exit $?"`);
  created.push(`refs/heads/spi992/bypass-${stamp}`);
  out.bypass = tail(bypass.stdout);
  check("a push bypassing the gateway fails (read-only token)", /exit [1-9]/.test(bypass.stdout) && remoteRef(`refs/heads/spi992/bypass-${stamp}`) === null, out.bypass);

  // A foreign host gets no token; an old helper's request (no v=2, the /proc op and cmd) is refused by the DO.
  const foreign = await sh(
    [
      `printf 'protocol=https\\nhost=attacker.example\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill >/dev/null 2>&1; echo "foreign-fill $?"`,
      `echo "old-helper $(curl -s -o /dev/null -w '%{http_code}' -G --data-urlencode op=push --data-urlencode cmd=git http://computer.internal/t3flare/git-credential)"`,
      `echo "new-helper-other-host $(curl -s -o /dev/null -w '%{http_code}' -G --data-urlencode v=2 --data-urlencode protocol=https --data-urlencode host=attacker.example http://computer.internal/t3flare/git-credential)"`,
    ].join("\n"),
  );
  out.foreign = foreign.stdout.trim().split("\n");
  check("a foreign host gets no token from the helper", /foreign-fill [1-9]/.test(foreign.stdout), out.foreign);
  check("the DO refuses an old helper's request and another host (403)", /old-helper 403/.test(foreign.stdout) && /new-helper-other-host 403/.test(foreign.stdout), out.foreign);

  // The gateway's own refusals: another repo, upload-pack, a compressed body.
  const gateway = await sh(
    [
      `echo "other-repo $(curl -s -o /dev/null -w '%{http_code}' 'http://computer.internal/t3flare/git/ian-pascoe/mac-bridge.git/info/refs?service=git-receive-pack')"`,
      `echo "upload-pack $(curl -s -o /dev/null -w '%{http_code}' 'http://computer.internal/t3flare/git/${FIXTURE}.git/info/refs?service=git-upload-pack')"`,
      `echo "gzip $(printf 0000 | curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/x-git-receive-pack-request' -H 'Content-Encoding: gzip' --data-binary @- 'http://computer.internal/t3flare/git/${FIXTURE}.git/git-receive-pack')"`,
      `echo "advertise $(curl -s -o /dev/null -w '%{http_code}' 'http://computer.internal/t3flare/git/${FIXTURE}.git/info/refs?service=git-receive-pack')"`,
    ].join("\n"),
  );
  out.gatewayRefusals = gateway.stdout.trim().split("\n");
  check("the gateway refuses another repo and upload-pack (404) and a compressed body (415), and advertises (200)", /other-repo 404/.test(gateway.stdout) && /upload-pack 404/.test(gateway.stdout) && /gzip 415/.test(gateway.stdout) && /advertise 200/.test(gateway.stdout), out.gatewayRefusals);

  // Tainted (H1): a push without an expectation and with no thread to ask is refused by name; t3's Commit & push lands.
  await call({ probePush: { noteLinked: { session: `thread:spi992-${stamp}`, ms: 1 } } });
  await call({ probePush: { lapseLinked: true } });
  const refused = await sh(`git push origin HEAD:refs/heads/spi992/tainted-${stamp} 2>&1; echo "exit $?"`);
  created.push(`refs/heads/spi992/tainted-${stamp}`);
  out.tainted = { output: tail(refused.stdout), state: (await call({ probePush: {} }))?.result };
  check("tainted, with no thread to ask: a push is refused with the named reason", /exit [1-9]/.test(refused.stdout) && /ran linked work/.test(refused.stdout) && remoteRef(`refs/heads/spi992/tainted-${stamp}`) === null, out.tainted);

  const t3Branch = `spi992/t3-${stamp}`;
  await sh(`set -e; git checkout -q -B ${t3Branch} origin/main; echo "t3 ${stamp}" > t3-${stamp}.txt`);
  const events = (await wsStream(cookie, "git.runStackedAction", { actionId: uuid(), cwd: fixture.workspaceRoot, action: "commit_push", featureBranch: false, commitMessage: `spi992 t3 commit & push ${stamp}` }).catch((error: unknown) => [{ kind: "action_failed", error: String(error).slice(0, 500) }])) as Array<any>;
  created.push(`refs/heads/${t3Branch}`);
  const head = (await sh("git rev-parse HEAD")).stdout.trim();
  out.t3Push = { events: events.map((event) => event.kind), failed: events.find((event) => event.kind === "action_failed") ?? null, remote: remoteRef(`refs/heads/${t3Branch}`), head };
  check("tainted: t3's Commit & push lands through its expectation, at HEAD", remoteRef(`refs/heads/${t3Branch}`) === head, out.t3Push);
  const trace = (await admin("GET", "/_t3flare/agents/router-trace?clear=1")).json;
  out.routerPushes = (trace?.entries ?? []).filter((entry: any) => /\bpush\b/.test(String(entry.argv ?? entry.command ?? ""))).slice(-5);
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
}

if (mode === "p2") {
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  const holdMs = Number(process.argv[3] ?? 600_000);
  const branch = `spi992/p2-${stamp}`;
  const commit = (await sh(commitScript(branch, [[`p2-${stamp}.txt`, 1024]]))).stdout.trim().split("\n").at(-1) ?? "";
  await call({ probePush: { holdMs } });
  // Detached in the Container (an admin request is cut after ~100 s at the edge): the push's output goes to a file.
  const log = `/tmp/p2-${stamp}.log`;
  await sh(`setsid nohup sh -c 'start=$(date +%s); git push origin HEAD:refs/heads/${branch} > ${log} 2>&1; echo "exit $? after $(( $(date +%s) - start ))s" >> ${log}' >/dev/null 2>&1 &`);
  let output = "";
  const started = Date.now();
  while (Date.now() - started < holdMs + 300_000) {
    await sleep(30_000);
    output = (await sh(`cat ${log} 2>/dev/null`)).stdout;
    if (/exit \d+ after/.test(output)) break;
  }
  await call({ probePush: { holdMs: 0 } });
  created.push(`refs/heads/${branch}`);
  out.p2 = { holdMs, output: tail(output), ms: Date.now() - started, remote: remoteRef(`refs/heads/${branch}`), commit };
  check(`P2: a receive-pack POST held ${holdMs / 60_000} min lands`, /exit 0/.test(output) && remoteRef(`refs/heads/${branch}`) === commit, out.p2);
}

if (mode === "p3") {
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  for (const [label, files] of [["90", [[`p3-90-${stamp}.bin`, 90 * 1024 * 1024]]], ["110", [[`p3-110a-${stamp}.bin`, 55 * 1024 * 1024], [`p3-110b-${stamp}.bin`, 55 * 1024 * 1024]]]] as Array<[string, Array<[string, number]>]>) {
    const branch = `spi992/p3-${label}-${stamp}`;
    // The commit, the pack git will send (bytes), then the push: all in the Container, detached.
    const run = await detached(
      [commitScript(branch, files), `echo "pack-bytes $(git rev-list --objects origin/main..HEAD | git pack-objects --stdout -q | wc -c)"`, `git push origin HEAD:refs/heads/${branch} 2>&1; echo "push-exit $?"`].join("\n"),
      20 * 60_000,
    );
    created.push(`refs/heads/${branch}`);
    const commit = /^([0-9a-f]{40})$/m.exec(run.output)?.[1] ?? null;
    const packBytes = Number(/pack-bytes (\d+)/.exec(run.output)?.[1] ?? "0");
    out[`p3_${label}`] = { output: tail(run.output), packBytes, packMiB: Math.round((packBytes / 1024 / 1024) * 10) / 10, pushExit: /push-exit (\d+)/.exec(run.output)?.[1] ?? null, ms: run.ms, remote: remoteRef(`refs/heads/${branch}`), commit };
    await detached(`git checkout -q --detach origin/main; git branch -D ${branch} >/dev/null 2>&1; rm -f p3-*.bin; git gc -q --prune=now 2>/dev/null; true`, 10 * 60_000);
  }
  const p90 = out.p3_90 as any;
  const p110 = out.p3_110 as any;
  check("P3: a ~90 MiB pack lands", p90.commit !== null && p90.packBytes > 90 * 1_000_000 && p90.remote === p90.commit, p90);
  // Recorded either way: the documented cap is 100 MiB per request body through an outbound handler.
  out.p3_110_landed = p110.commit !== null && p110.remote === p110.commit;
  check("P3: the ~110 MiB push was made (a pack over 100 MiB) and its outcome recorded", p110.commit !== null && p110.packBytes > 105 * 1024 * 1024, p110);
}

/** Copies scripts/spi992/<name> into the Workspace's `.spi992/` (untracked, excluded from git). */
const install = async (...names: Array<string>) => {
  for (const name of names) {
    const data = fs.readFileSync(path.join(import.meta.dirname, "spi992", name)).toString("base64");
    await sh(`mkdir -p .spi992 && printf %s ${data} | base64 -d > .spi992/${name} && grep -qx '.spi992/' .git/info/exclude 2>/dev/null || echo '.spi992/' >> .git/info/exclude`);
  }
};

/**
 * A linked thread (a link at auto-accept-edits) runs `command`, its command approvals accepted by the harness as the
 * owner's client; each "Allow git push?" card is answered by `onPush` (in order). The answers, and the final projection.
 */
const linkedRun = async (label: string, command: string, onPush: (index: number, threadId: string, request: any, mcp: McpClient) => Promise<string>) => {
  const link = await signIn((await mintPairingCode(cookie, { label: `spi992 ${label} ${stamp}` })).code, "auto-accept-edits", { clientName: `spi992 ${label} ${stamp}` });
  const mcp = new McpClient(link.token, { modeLimit: "auto-accept-edits/default" });
  const launched = await mcp.call("t3_thread_launch", {
    projectId: fixture.projectId,
    title: `spi992 ${label} ${stamp}`,
    modelSelection: MODEL,
    clientRequestId: `spi992-${label}-${stamp}`,
    message: `Run exactly this one bash command, once, with a timeout of at least 900 seconds, and do nothing else: \`${command}\`. Then reply with its last output line.`,
  });
  const threadId: string | undefined = launched.json?.threadId;
  const answers: Array<{ title: string; decision: string; at: number; summary?: string }> = [];
  if (!check(`${label}: the linked thread launched`, threadId !== undefined, launched.text.slice(0, 300))) return { threadId: null, answers, projection: null, mcp };
  const started = Date.now();
  const seen = new Set<string>();
  let pushes = 0;
  let p: any;
  while (Date.now() - started < 25 * 60_000) {
    p = await projection(cookie, threadId!).catch(() => p);
    for (const request of pendingOf(p).filter((r: any) => !seen.has(r.id))) {
      seen.add(request.id);
      const item = (p?.turnItems ?? []).find((entry: any) => entry.requestId === request.id);
      const title = item?.title ?? "";
      const decision = title === "Allow git push?" ? await onPush(pushes++, threadId!, request, mcp) : "acceptForSession";
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision });
      answers.push({ title, decision, at: Date.now() - started, ...(title === "Allow git push?" ? { summary: String(item?.prompt ?? "").slice(0, 400) } : {}) });
    }
    if (p !== undefined && settled(p) && pendingOf(p).length === 0) break;
    await sleep(1500);
  }
  return { threadId, answers, projection: p, mcp };
};

if (mode === "hostile") {
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  await install("hostile.sh", "logproxy.py");
  const mainBefore = remoteRef("refs/heads/main");
  let f7: unknown = null;
  const run = await linkedRun("hostile", `sh .spi992/hostile.sh ${stamp} ${FIXTURE}`, async (index, threadId, request, mcp) => {
    if (index === 0) return "accept";
    if (index === 2) {
      // F7: the link's own MCP client cannot answer the card (t3_pending_request respond refuses approvals).
      const responded = await mcp.call("t3_pending_request", { action: "respond", threadId, requestId: request.id, decision: "accept" });
      f7 = { isError: responded.isError, text: responded.text.slice(0, 300) };
    }
    return "decline";
  });
  created.push(`refs/heads/spi992/a-${stamp}`, `refs/heads/spi992/b-${stamp}`, `refs/heads/spi992/c-${stamp}`);
  const results = (await sh(`cat /tmp/spi992-cap-${stamp}/results 2>/dev/null; ls /tmp/spi992-cap-${stamp}/proxy 2>/dev/null | head -20`)).stdout.trim().split("\n");
  const approvedCommit = /approved-commit ([0-9a-f]{40})/.exec(results.join("\n"))?.[1] ?? null;
  const pushCards = run.answers.filter((a) => a.title === "Allow git push?");
  const leak = (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(id)}`)).json;
  out.hostile = { threadId: run.threadId, answers: run.answers, results, f7, reply: replyOf(run.projection).slice(-300), leak: { do: leak?.do ?? null, container: leak?.container ?? null } };
  check("hostile: the approved push asked once and landed at the approved commit", pushCards[0]?.decision === "accept" && approvedCommit !== null && remoteRef(`refs/heads/spi992/a-${stamp}`) === approvedCommit, out.hostile);
  check("hostile: the replayed POST raised a new card, declined, and nothing landed from it", pushCards.length >= 2 && results.some((line) => /^replay http=200 declined=[1-9]/.test(line)), results);
  const candidates = results.filter((line) => line.startsWith("candidate "));
  check("hostile: the hostile process captured credentials to try (the captures worked)", candidates.length >= 1, results);
  check("hostile: every captured string fails a write: direct git push, REST refs and contents", candidates.every((line) => /git=refused/.test(line) && !/rest-refs=20/.test(line) && !/rest-contents=20/.test(line)), candidates);
  check("hostile: the second gateway push raised a new card, declined, refused", pushCards.length >= 3 && results.some((line) => /^again-push-exit [1-9]\d* declined=[1-9]/.test(line)), results);
  check("hostile: t3_pending_request respond from the link cannot answer the push card (F7)", (f7 as any)?.isError === true || /refus|not allowed|cannot|approval/i.test(String((f7 as any)?.text ?? "")), f7);
  check("hostile: on GitHub only spi992/a exists of this run's refs, and main is unchanged", remoteRef(`refs/heads/spi992/b-${stamp}`) === null && remoteRef(`refs/heads/spi992/c-${stamp}`) === null && remoteRef("refs/heads/main") === mainBefore);
  check("hostile: the leak scan (the Workspace's files and its Container) finds no gateway (write) token", leak !== undefined && !JSON.stringify(leak).includes("gateway-token"), leak);
  await sh(`rm -rf /tmp/spi992-cap-${stamp}; git checkout -q --detach origin/main; true`);
}

if (mode === "persist") {
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  await install("plant.sh");
  const planted = ["fsm", "hook", "payload", "loop"].map((kind) => `refs/heads/spi992/${kind}-${stamp}`);
  created.push(...planted);
  const run = await linkedRun("persist", `sh .spi992/plant.sh ${stamp}`, () => Promise.resolve("decline"));
  const before = (await call({ probePush: {} }))?.result;
  // The window lapses (the probe ends every linked-work window now; the taint stays), then the Container restarts.
  await call({ probePush: { lapseLinked: true } });
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
  await sleep(5_000);
  // The owner: status (the fsmonitor runs), then Commit & push on a branch of their own (the hooks run).
  const ownerBranch = `spi992/owner-${stamp}`;
  created.push(`refs/heads/${ownerBranch}`);
  const status = await call({ git: { argv: ["status", "--porcelain"], cwd: "/workspace/repo", env: {}, startContainer: true, readScope: "repo" } });
  await sh(`git checkout -q -B ${ownerBranch} origin/main && echo "owner ${stamp}" > owner-${stamp}.txt`);
  const events = (await wsStream(cookie, "git.runStackedAction", { actionId: uuid(), cwd: fixture.workspaceRoot, action: "commit_push", featureBranch: false, commitMessage: `spi992 owner ${stamp}` }).catch((error: unknown) => [{ kind: "action_failed", error: String(error).slice(0, 500) }])) as Array<any>;
  const head = (await sh("git rev-parse HEAD")).stdout.trim();
  await sleep(75_000);
  const logs = (await sh(`for f in .git/spi992-*.log; do echo "== $f"; tail -n 4 "$f"; done 2>/dev/null`)).stdout;
  const after = (await call({ probePush: {} }))?.result;
  out.persist = {
    threadId: run.threadId,
    answers: run.answers,
    taintBefore: before?.taint ?? null,
    taintAfter: after?.taint ?? null,
    status: { ran: status?.result?.ran ?? null },
    t3Push: { events: events.map((event) => event.kind), failed: events.find((event) => event.kind === "action_failed") ?? null, head, remote: remoteRef(`refs/heads/${ownerBranch}`) },
    planted: planted.map((ref) => ({ ref, onGitHub: remoteRef(ref) })),
    logs: logs.split("\n").slice(0, 40),
  };
  check("persist: the plant ran in a linked thread and tainted the Workspace", before?.taint !== null && before?.taint !== undefined, before);
  check("persist: the taint outlived the window and the Container restart", after?.taint !== null && after?.taint !== undefined, after);
  check("persist: the owner's Commit & push landed (its expectation)", remoteRef(`refs/heads/${ownerBranch}`) === head, out.persist);
  check("persist: no planted ref appeared (fsmonitor, pre-push hook, payload, loop)", planted.every((ref) => remoteRef(ref) === null), out.persist);
  check("persist: the planted pushes reached the gateway and were refused by name", /ran linked work/.test(logs), logs.slice(0, 1500));
  // Clean up the plant (the owner, by hand).
  await sh(`git config --unset core.fsmonitor; rm -f .git/hooks/pre-push .git/hooks/post-commit .git/spi992-*; rm -rf .spi992; pkill -f 'spi992/loop' ; git checkout -q --detach origin/main; true`);
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
}

// The fixture's refs this run made are deleted (the owner's gh).
out.cleanup = created.filter((ref) => remoteRef(ref) !== null).map((ref) => ({ ref, deleted: deleteRef(ref) }));
await sh("git checkout -q --detach origin/main 2>/dev/null; true");
evidence(`${mode === "m1" ? "m1-gateway" : mode === "hostile" ? "m2-hostile-durable" : mode === "persist" ? "m2-hostile-persist" : `m0-${mode}`}.json`);
process.exit(failures.length === 0 ? 0 : 1);
