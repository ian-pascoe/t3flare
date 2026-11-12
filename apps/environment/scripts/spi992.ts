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
//
//   bun scripts/stage.ts run spi992 spi992 <m1|p2|p3>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, pair, uuid, wsStream } from "./lib/client.ts";
import { ensureCloudFixtureProject, FIXTURE } from "./lib/fixtureProject.ts";

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
  const pushed = await sh(`start=$(date +%s); git push origin HEAD:refs/heads/${branch} 2>&1; echo "exit $? after $(( $(date +%s) - start ))s"`, holdMs + 300_000);
  await call({ probePush: { holdMs: 0 } });
  created.push(`refs/heads/${branch}`);
  out.p2 = { holdMs, output: tail(pushed.stdout), ms: pushed.ms, remote: remoteRef(`refs/heads/${branch}`), commit };
  check(`P2: a receive-pack POST held ${holdMs / 60_000} min lands`, /exit 0/.test(pushed.stdout) && remoteRef(`refs/heads/${branch}`) === commit, out.p2);
}

if (mode === "p3") {
  await admin("POST", `/_t3flare/agents/workspace-trust?id=${encodeURIComponent(id)}`);
  for (const [label, files] of [["90", [[`p3-90-${stamp}.bin`, 90 * 1024 * 1024]]], ["110", [[`p3-110a-${stamp}.bin`, 55 * 1024 * 1024], [`p3-110b-${stamp}.bin`, 55 * 1024 * 1024]]]] as Array<[string, Array<[string, number]>]>) {
    const branch = `spi992/p3-${label}-${stamp}`;
    const commit = (await sh(commitScript(branch, files), 600_000)).stdout.trim().split("\n").at(-1) ?? "";
    const pushed = await sh(`git push origin HEAD:refs/heads/${branch} 2>&1; echo "exit $?"`, 900_000);
    created.push(`refs/heads/${branch}`);
    out[`p3_${label}`] = { output: tail(pushed.stdout), ms: pushed.ms, remote: remoteRef(`refs/heads/${branch}`), commit };
    await sh(`git checkout -q --detach origin/main && git branch -D ${branch} >/dev/null 2>&1; git gc -q --prune=now 2>/dev/null; true`, 600_000);
  }
  check("P3: a ~90 MiB pack lands", (out.p3_90 as any).remote === (out.p3_90 as any).commit, out.p3_90);
  check("P3: a ~110 MiB pack is refused (413, the outbound handler's 100 MiB request cap)", (out.p3_110 as any).remote === null && /413|exit [1-9]/.test((out.p3_110 as any).output), out.p3_110);
}

// The fixture's refs this run made are deleted (the owner's gh).
out.cleanup = created.filter((ref) => remoteRef(ref) !== null).map((ref) => ({ ref, deleted: deleteRef(ref) }));
await sh("git checkout -q --detach origin/main 2>/dev/null; true");
evidence(`${mode === "m1" ? "m1-gateway" : `m0-${mode}`}.json`);
process.exit(failures.length === 0 ? 0 : 1);
