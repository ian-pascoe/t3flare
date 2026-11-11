// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalFetch:off
// Step 3, M0 R2–R4 (and R3's rerun before M5): a stock t3 server from npm at `--version` plays the laptop. It links to
// the stage with the stock CLI (`t3 environment link`, a plain pairing code the stage's owner session mints, access
// auto-accept-edits), lists the link, and, as an outside MCP client of the laptop, forwards t3_project_list,
// t3_thread_launch and t3_thread_wait to the stage. R4: the stage's fixture project and the laptop's local clone of
// the fixture report the same repository identity. Writes docs/steps/step-3/<--out>.
//
//   bun scripts/stage.ts run step3 peer-laptop --version 0.1.9-nightly.20261111.4515 --out m0-laptop-link.json
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { base, pair, updateSettings, uuid, wsCall } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { Laptop } from "./lib/laptop.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";
import { ensureCloudFixtureProject, FIXTURE } from "./lib/fixtureProject.ts";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};
const version = arg("version", "0.1.9-nightly.20261111.4515");
const outFile = arg("out", "m0-laptop-link.json");
const port = Number(arg("port", "47912"));
/** The bump job: no laptop clone of the private fixture (R4 is proved per step), only the link and a forwarded launch. */
const skipRepo = process.argv.includes("--skip-repo");
const out: Record<string, unknown> = { version, cloud: base.host };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return ok;
};

// The cloud: the owner's session, Linked environments on, the Durable agent on, the fixture project.
const cookie = await pair();
await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
await wsCall(cookie, "server.updateSettings", {
  patch: {},
  providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
});
const cloudProject = await ensureCloudFixtureProject(cookie);
out.cloudProject = cloudProject;

// The laptop.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-laptop-"));
const laptop = new Laptop({ version, port, dir });
try {
  const descriptor = await laptop.start();
  out.laptop = { environmentId: descriptor.environmentId, serverVersion: descriptor.serverVersion };
  const laptopCookie = await laptop.pair();
  await laptop.client.updateSettings(laptopCookie, { linkedEnvironmentsEnabled: true });
  const clone = path.join(dir, "fixture");
  const laptopProjectId = uuid();
  if (!skipRepo) {
    const cloned = spawnSync("gh", ["repo", "clone", FIXTURE, clone, "--", "--depth", "1"], { encoding: "utf8" });
    check("the fixture clones on the laptop", cloned.status === 0, cloned.stderr.slice(-300));
    await laptop.client.mutateProject(laptopCookie, {
      type: "project.create",
      commandId: uuid(),
      projectId: laptopProjectId,
      title: "fixture (laptop)",
      workspaceRoot: clone,
      createWorkspaceRootIfMissing: false,
    });
  }

  // R2: link with the stock CLI.
  const code = (await mintPairingCode(cookie, { label: `laptop ${version}` })).code;
  const linked = laptop.cli(["environment", "link", base.origin, "--pairing-code", code, "--access", "auto-accept-edits"], { allowFailure: true });
  out.link = { status: linked.status, stdout: linked.stdout.slice(0, 600), stderr: linked.stderr.slice(-600) };
  check("t3 environment link succeeds", linked.status === 0, out.link);
  const listed = laptop.cli(["environment", "list", "--json"], { allowFailure: true });
  let links: any;
  try {
    links = JSON.parse(listed.stdout);
  } catch {
    links = listed.stdout.slice(0, 600);
  }
  out.list = links;

  // R3: an outside MCP client of the laptop (an app approval code at full access) forwards to the stage.
  const appCode = (await mintPairingCode(laptopCookie, { access: "full-access", label: "harness app" }, laptop.url)).code;
  const app = await signIn(appCode, "full-access", { at: laptop.url, peerLink: false });
  const mcp = new McpClient(app.token, { at: laptop.url });
  const environments = await mcp.call("t3_environment_links", {});
  out.environmentLinks = { isError: environments.isError, sample: environments.text.slice(0, 800) };
  const cloudId = ((await (await fetch(new URL("/.well-known/t3/environment", base))).json()) as { environmentId: string }).environmentId;
  const cloudEnvironmentId: string | undefined = (environments.json?.links ?? []).find((link: any) => link.environmentId === cloudId)?.environmentId;
  check("the laptop lists the stage as a linked environment", cloudEnvironmentId !== undefined, out.environmentLinks);
  if (cloudEnvironmentId !== undefined) {
    const remoteProjects = await mcp.call("t3_project_list", { environmentId: cloudEnvironmentId });
    const localProjects = await mcp.call("t3_project_list", {});
    const remote = (remoteProjects.json?.projects ?? []).find((project: any) => project.id === cloudProject.projectId);
    const local = (localProjects.json?.projects ?? []).find((project: any) => project.id === laptopProjectId);
    out.repoIdentity = { remote: remote?.repositoryIdentity ?? null, local: local?.repositoryIdentity ?? null, remoteError: remoteProjects.isError ? remoteProjects.text.slice(0, 300) : null };
    check(
      "R4: the stage's fixture project and the laptop's clone have the same canonicalKey",
      skipRepo ||
      remote?.repositoryIdentity?.canonicalKey !== undefined && remote?.repositoryIdentity?.canonicalKey === local?.repositoryIdentity?.canonicalKey,
      out.repoIdentity,
    );
    const launched = await mcp.call("t3_thread_launch", {
      environmentId: cloudEnvironmentId,
      projectId: cloudProject.projectId,
      title: `step3 forwarded ${version}`,
      message: "Reply with exactly the word PONG and nothing else. Use no tools.",
      modelSelection: { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5" },
      clientRequestId: `forwarded-${Date.now()}`,
    });
    out.launch = { isError: launched.isError, sample: launched.text.slice(0, 800) };
    const threadId: string | undefined = launched.json?.threadId ?? launched.json?.thread?.threadId;
    check("a forwarded t3_thread_launch starts a thread on the stage", !launched.isError && threadId !== undefined, out.launch);
    if (threadId !== undefined) {
      const started = Date.now();
      let waited = await mcp.call("t3_thread_wait", { environmentId: cloudEnvironmentId, threadId, timeoutMs: 50_000 });
      while (!waited.isError && waited.json?.timedOut === true && Date.now() - started < 5 * 60_000) {
        waited = await mcp.call("t3_thread_wait", { environmentId: cloudEnvironmentId, threadId, timeoutMs: 50_000 });
      }
      out.wait = { isError: waited.isError, ms: Date.now() - started, sample: waited.text.slice(0, 600) };
      check("a forwarded t3_thread_wait decodes and the run completes", !waited.isError && waited.json?.status === "completed", out.wait);
      const read = await mcp.call("t3_thread_read", { environmentId: cloudEnvironmentId, threadId });
      out.read = { isError: read.isError, pong: read.text.includes("PONG"), linkOrigin: read.text.includes("linkOrigin") };
      check("the reply reads back through the link", read.text.includes("PONG"), out.read);
    }
  }
} catch (error) {
  failures.push(`threw: ${String(error).slice(0, 600)}`);
} finally {
  await laptop.stop();
  out.failures = failures;
  out.ok = failures.length === 0;
  writeEvidence(outFile, out);
  console.log(JSON.stringify(out, null, 1).slice(0, 6000));
}
process.exit(failures.length === 0 ? 0 : 1);
