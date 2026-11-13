// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// `pnpm run test:docker` (step 4a, plan §9; SPI-1043): the pinned Codex and pi, launched exactly as the Workspace DO
// launches them (`profileLaunch` → `processCommand`, the request guard's turn policy), in a container with the image's
// CLI layer (test/docker/Dockerfile), against the real model proxy. Not part of `pnpm run check`: it needs Docker,
// network, MODEL_PROXY_URL and COMMISSARY_CONTAINER_API_KEY; the nightly bump job runs it.
//
// Per CLI: a tool turn with an approval answered, then a fresh container (a Container that slept: only the synced
// directory survives) resumes the same native conversation. Then: the key is nowhere in the synced directory, and the
// CLI network (internal, its only peer the stand-in `computer.internal`) tunnelled only to the proxy's host.
//
//   pnpm run test:docker            (vitest.docker.config.ts; T3FLARE_TEST_DOCKER_OUT=<file> writes the report)
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { CatalogModel } from "@t3flare/models";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { processCommand } from "@t3flare/sandbox-image/process";

import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../../t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";
import { type Launch, type LaunchInput, PI_SESSIONS, profileLaunch } from "../../src/agents/cliProfiles.ts";
import { guardRequest } from "../../src/provider/cli/codexGuard.ts";
import { expect, it } from "vitest";

const here = import.meta.dirname;
const imageContext = path.resolve(here, "../../../sandbox-image/image");
const IMAGE = "t3flare-cli-test";
const KEYHOST = "t3flare-cli-test-keyhost";
const NET_OUT = "t3flare-cli-test-out";
const NET_INT = "t3flare-cli-test-int";
const T3_PATH = "/w/fixture";
const EXTENSION = "/t3/caches/pi-t3-mcp-extension.ts";

const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/$/, "");
let proxyHost = "";
const key = process.env.COMMISSARY_CONTAINER_API_KEY ?? "";
const out = process.env.T3FLARE_TEST_DOCKER_OUT;

const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 800)}`}`);
  return ok;
};
/** Output with the proxy's host replaced (the report names it `<proxy host>`) and the key never shown. */
const scrub = (text: string) => {
  const keyless = key === "" ? text : text.replaceAll(key, "<key>");
  return proxyHost === "" ? keyless : keyless.replaceAll(proxyHost, "<proxy host>");
};

const docker = (args: ReadonlyArray<string>, options: { env?: Record<string, string>; quiet?: boolean } = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, ...options.env }, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && options.quiet !== true) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${scrub(result.stderr ?? "").slice(-1500)}`);
  return result;
};

const model = (id: string): CatalogModel => ({ id, name: id, provider: "anthropic", vendor: "Anthropic", api: "anthropic-messages", slug: `anthropic/${id}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 32_000 });
const PI_MODEL = "claude-haiku-5-5";
const CODEX_MODEL = "gpt-6-luna";

const launchOf = (input: Omit<LaunchInput, "allowProbe" | "cwd">): Launch => {
  const answer = profileLaunch(
    { ...input, cwd: T3_PATH, allowProbe: false },
    { proxyUrl, models: [model(PI_MODEL)], readStateFile: (file) => (file === EXTENSION ? PI_T3_MCP_EXTENSION_SOURCE : undefined), piExtensionSource: PI_T3_MCP_EXTENSION_SOURCE },
  );
  if ("refused" in answer) throw new Error(`the profile refused: ${answer.refused}`);
  return answer;
};

it("Codex and pi run, ask, resume in a fresh container, keep the key off synced disk and reach only the proxy", () => {
  if (proxyUrl === "" || key === "") throw new Error("test:docker needs MODEL_PROXY_URL and COMMISSARY_CONTAINER_API_KEY in the environment (CI: the bump environment)");
  proxyHost = new URL(proxyUrl).hostname;
  // --- setup: the image, the networks, the stand-in egress host, the synced directory --------------------------------
  const nonces = { codex: `nonce-${randomUUID()}`, pi: `nonce-${randomUUID()}` };
  // The synced directory, a bind mount: under this directory, not the OS temp dir (Docker Desktop shares the home, not
// macOS's /var/folders, and an unshared path mounts empty).
const workspace = fs.mkdtempSync(path.join(here, ".work-"));
  const cleanup = () => {
    docker(["rm", "-f", KEYHOST], { quiet: true });
    docker(["network", "rm", NET_INT, NET_OUT], { quiet: true });
  };
  cleanup();
  console.log("building the test image (the Workspace image's CLI layer)…");
  docker(["build", "-q", "-t", IMAGE, "-f", path.join(here, "Dockerfile"), "--build-arg", `CODEX_VERSION=${CLIS.codex.version}`, "--build-arg", `CODEX_SHA256=${CLIS.codex.sha256}`, "--build-arg", `CODEX_SHA256_ARM64=${CLIS.codex.sha256Arm64}`, imageContext]);
  docker(["network", "create", NET_OUT]);
  docker(["network", "create", "--internal", NET_INT]);
  // The key reaches keyhost through the docker client's environment (`-e NAME`), never an argument.
  docker(["run", "-d", "--name", KEYHOST, "--network", NET_OUT, "-e", "KEYHOST_MODEL_KEY", "-e", `KEYHOST_NONCES=${nonces.codex},${nonces.pi}`, "-v", `${here}:/k:ro`, `node:26.13.0-bookworm-slim`, "node", "/k/keyhost.mjs"], {
    env: { KEYHOST_MODEL_KEY: key },
  });
  docker(["network", "connect", "--alias", "computer.internal", NET_INT, KEYHOST]);
  const keyhostIp = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${NET_INT}").IPAddress}}`, KEYHOST]).stdout.trim();
  fs.mkdirSync(path.join(workspace, "repo"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".t3flare"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "repo", "hello.txt"), "hello from the fixture\n");
  spawnSync("git", ["init", "-q"], { cwd: path.join(workspace, "repo") });
  // The container runs as root and writes into the synced directory; let the host clean it up afterwards.
  fs.chmodSync(workspace, 0o777);

  /** `docker run` of one CLI process: the launcher `bash -c`, the profile's env, the nonce, the egress host as proxy. */
  const containerCommand = (cli: "codex" | "pi", launch: Launch, marker: string): Array<string> => {
    const env: Record<string, string> = {
      ...launch.env,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      T3FLARE_EXEC: marker,
      T3FLARE_MODEL_KEY_NONCE: nonces[cli],
      HTTPS_PROXY: "http://computer.internal:3128",
      HTTP_PROXY: "http://computer.internal:3128",
      NO_PROXY: "computer.internal",
    };
    const command = processCommand({ marker, t3Path: T3_PATH, cwd: T3_PATH, argv: launch.argv, ...(launch.files ? { files: launch.files } : {}), ...(launch.links ? { links: launch.links } : {}), ...(launch.prune ? { prune: launch.prune } : {}) });
    return ["docker", "run", "--rm", "-i", "--name", `t3flare-cli-test-${marker}`, "--network", NET_INT, "--dns", keyhostIp, "-v", `${workspace}:/workspace`, ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), IMAGE, "bash", "-c", command];
  };

  const drive = (driver: string, scenario: unknown, command: ReadonlyArray<string>): any => {
    const result = spawnSync("node", [path.join(here, driver), JSON.stringify(scenario), "--", ...command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 420_000 });
    const line = (result.stdout ?? "").trim().split("\n").at(-1) ?? "";
    try {
      return JSON.parse(line);
    } catch {
      return { driverFailed: scrub(`${result.stdout ?? ""}${result.stderr ?? ""}`).slice(-1500) };
    }
  };

  const report: Record<string, unknown> = { at: new Date().toISOString(), clis: { codex: CLIS.codex.version, pi: CLIS.pi.version } };

  try {
    // --- Codex: approval-required without a sandbox (the guard's `untrusted`), then a resume in a fresh container ----
    const codexPolicy = guardRequest("turn/start", {}, { runtimeMode: "approval-required", sandbox: false });
    const turnParams = "params" in codexPolicy ? codexPolicy.params : {};
    const codexStart = () => {
      const marker = `proc-${randomUUID()}`;
      return containerCommand("codex", launchOf({ cli: "codex", args: ["app-server"], key: marker, env: { T3CODE_THREAD_ID: "t-codex" } }), marker);
    };
    const codex1 = drive("codex-rpc.mjs", { model: CODEX_MODEL, cwd: T3_PATH, prompt: "Remember the code word KESTREL-41 for later. Run the shell command `cat hello.txt`, then reply with the single word ok.", turnParams, timeoutMs: 300_000 }, codexStart());
    check("codex: turn 1 completed", codex1.turnStatus === "completed", { status: codex1.turnStatus, errors: codex1.errors, stderr: scrub(codex1.stderr ?? "").slice(-600), driver: codex1.driverFailed });
    check("codex: the command asked for approval (untrusted)", (codex1.approvals ?? []).length >= 1, codex1.approvals);
  check("codex: an approved command ran", (codex1.items ?? []).some((item: any) => item.type === "commandExecution" && item.status === "completed"), codex1.items);
    const codex2 = drive("codex-rpc.mjs", { model: CODEX_MODEL, cwd: T3_PATH, resume: codex1.threadId, prompt: "What was the code word? Reply with it only.", turnParams, timeoutMs: 300_000 }, codexStart());
    check("codex: turn 2 completed in a fresh container", codex2.turnStatus === "completed", { status: codex2.turnStatus, errors: codex2.errors });
    check("codex: resumed the same thread", codex2.threadId === codex1.threadId, { first: codex1.threadId, second: codex2.threadId });
    check("codex: remembered the code word", String(codex2.agentText ?? "").includes("KESTREL-41"), codex2.agentText);
    report.codex = { first: { threadId: codex1.threadId, status: codex1.turnStatus, approvals: codex1.approvals, items: codex1.items, ms: codex1.ms }, second: { threadId: codex2.threadId, status: codex2.turnStatus, text: String(codex2.agentText ?? "").slice(-200), ms: codex2.ms } };

    // --- pi: approval-required (t3's permission extension asks), then `--session` of the same file, fresh container --
    const piStart = (extra: ReadonlyArray<string>) => {
      const marker = `proc-${randomUUID()}`;
      return containerCommand(
        "pi",
        launchOf({ cli: "pi", args: ["--mode", "rpc", "--extension", EXTENSION, "--provider", "anthropic", "--model", PI_MODEL, ...extra], key: marker, env: { T3CODE_THREAD_ID: "t-pi", T3_PI_RUNTIME_MODE: "approval-required" } }),
        marker,
      );
    };
    const pi1 = drive("pi-rpc.mjs", { commands: [{ type: "prompt", message: "Remember the code word WREN-73 for later. Run `cat hello.txt` with your bash tool, then reply with the single word ok." }, { type: "get_state" }], confirm: true, timeoutMs: 300_000 }, piStart([]));
    const sessionFile = (pi1.responses ?? []).find((response: any) => response.command === "get_state")?.data?.sessionFile as string | undefined;
    check("pi: turn 1 ran a tool without errors", (pi1.toolCalls ?? []).length >= 1 && (pi1.errors ?? []).length === 0, { toolCalls: pi1.toolCalls, errors: pi1.errors, stderr: scrub(pi1.stderr ?? "").slice(-600), driver: pi1.driverFailed });
    check("pi: the command asked for approval", (pi1.uiRequests ?? []).some((request: any) => request.method === "confirm"), pi1.uiRequests);
    check("pi: the session is in the synced directory", sessionFile?.startsWith(`${PI_SESSIONS}/`) === true, sessionFile);
    const pi2 = drive("pi-rpc.mjs", { commands: [{ type: "prompt", message: "What was the code word? Reply with it only." }, { type: "get_state" }], confirm: true, timeoutMs: 300_000 }, piStart(["--session", sessionFile ?? `${PI_SESSIONS}/missing.jsonl`]));
    const sessionFile2 = (pi2.responses ?? []).find((response: any) => response.command === "get_state")?.data?.sessionFile;
    check("pi: turn 2 in a fresh container without errors", (pi2.errors ?? []).length === 0 && pi2.events?.agent_end >= 1, { errors: pi2.errors, stderr: scrub(pi2.stderr ?? "").slice(-600) });
    check("pi: the same session file", sessionFile2 === sessionFile, { first: sessionFile, second: sessionFile2 });
    check("pi: remembered the code word", String(pi2.text ?? "").includes("WREN-73"), pi2.text);
    report.pi = { first: { sessionFile, toolCalls: pi1.toolCalls, uiRequests: pi1.uiRequests, ms: pi1.ms }, second: { sessionFile: sessionFile2, text: String(pi2.text ?? "").slice(-200), ms: pi2.ms } };

    // --- the key on synced disk, and egress ---------------------------------------------------------------------------
    const hits: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && fs.readFileSync(file).includes(key)) hits.push(path.relative(workspace, file));
      }
    };
    walk(workspace);
    check("no key in the synced directory", hits.length === 0, hits);
    const events = docker(["logs", KEYHOST]).stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const tunnels = [...new Set(events.filter((event) => event.event === "connect").map((event) => event.host as string))];
    const names = [...new Set(events.filter((event) => event.event === "dns").map((event) => event.name as string))];
    const grants = events.filter((event) => event.event === "model-key");
    check("egress: tunnels only to the proxy's host", tunnels.length >= 1 && tunnels.every((host) => host === proxyHost), tunnels.map(scrub));
    check("egress: no plain HTTP through the proxy", !events.some((event) => event.event === "proxy-http"));
    check("the key helper was asked, and only with a known nonce", grants.length >= 2 && grants.every((grant) => grant.granted === true), grants);
    report.syncedDirectory = { files: hits.length === 0 ? "no key" : hits };
    report.egress = { tunnels: tunnels.map(scrub), dnsNamesAsked: names.map(scrub), grants: grants.map((grant) => ({ cli: grant.cli, granted: grant.granted })) };
  } finally {
    cleanup();
    spawnSync("docker", ["run", "--rm", "-v", `${workspace}:/workspace`, IMAGE, "rm", "-rf", "/workspace/repo", "/workspace/.t3flare"], { encoding: "utf8" });
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const full = { ok: failures.length === 0, failures, ...report };
  if (out !== undefined) fs.writeFileSync(out, `${scrub(JSON.stringify(full, null, 1))}\n`);
  console.log(scrub(JSON.stringify(full, null, 1)));
  expect(failures).toEqual([]);
}, 30 * 60_000);
