// @effect-diagnostics globalDate:off globalDateInEffect:off effectFnOpportunity:off globalConsole:off cryptoRandomUUID:off
// The Environment's process spawner (step 2a plan, section 2): the Environment DO runs no processes, so every command
// t3 spawns is answered here. `git` in a Workspace (`/w/<id>/…`) runs in that Workspace's Container; t3's clone into
// `/w` makes a Workspace; `gh auth token` is the Environment's own GitHub token (t3's PR features); everything else is
// a missing binary, as in step 1. Every routed command is kept in a short trace (admin `GET /_t3flare/agents/router-trace`).
import { fromWorkspaceText, HARNESS_ROOT, isUnderW, normalize, toWorkspace } from "@t3flare/workspace-client";
import {
  CONTAINER_GITHUB_PERMISSIONS,
  ENVIRONMENT_GITHUB_PERMISSIONS,
  PUSH_GATEWAY_PERMISSIONS,
  PUSH_GATEWAY_WORKFLOWS_PERMISSIONS,
} from "@t3flare/github-app/permissions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";

import * as StateStore from "../platform/stateStore.ts";
import { environmentServices } from "./bindings.ts";
import {
  cloneRequestOf,
  gitEnvOf,
  intoWorkspace,
  mayStartContainer,
  gatewayUrlsToGitHub,
  pushPlanOf,
  parseWorktreeList,
  readScopeOf,
  remoteRepoOf,
  subcommandOf,
  type WorktreeCommand,
  worktreeCommandOf,
  worktreeDestinationOf,
  worktreeListPorcelain,
} from "./gitRoutes.ts";
import { workspaceRpc } from "./workspaceClient.ts";
import { CLI_NAMES, spawnCli } from "./cliProcess.ts";

/** Commands t3 tried to spawn that nothing answers (step 1's report). */
export const spawnAttempts = new Map<string, number>();

export type Route = "protocol" | "process" | "container" | "cache" | "stale-patched" | "stale-last-answer" | "container-stopped" | "clone" | "worktree" | "gh-token" | "emulated" | "no-workspace" | "not-found" | "error";

export interface TraceEntry {
  readonly at: number;
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string | null;
  readonly route: Route;
  readonly exitCode: number | null;
  readonly ms: number;
  readonly detail?: string;
}

const TRACE_MAX = 300;
const trace: Array<TraceEntry> = [];

export const routerTrace = (): ReadonlyArray<TraceEntry> => [...trace];

/** Step 4a: a CLI protocol step worth proving later (a native thread resumed), in the same trace. */
export const traceProtocol = (cli: string, step: string, detail: string): void =>
  record({ at: Date.now(), command: cli, argv: [step], cwd: null, route: "protocol", exitCode: null, ms: 0, detail: detail.slice(0, 300) });
export const clearRouterTrace = (): void => void trace.splice(0);

const record = (entry: TraceEntry) => {
  trace.push(entry);
  if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
};

interface Answer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly route: Route;
  readonly detail?: string;
}

/** Every live GitHub token taken out of `text`. */
const redactTokens = (text: string): string => {
  let out = text;
  for (const token of environmentServices().github().live()) out = out.split(token).join("***");
  return out;
};

/** An argv as the trace keeps it: credentials in URLs and anything token-like removed. */
const traceArgv = (args: ReadonlyArray<string>) =>
  args.map((arg) => redactTokens(arg.replace(/\/\/[^/@\s]+@/g, "//***@")).slice(0, 300));

const ghToken = async (): Promise<Answer> => {
  const services = environmentServices();
  const repos = services.workspaces.list().filter((ws) => ws.host === "github.com" && ws.owner !== null && ws.name !== null);
  const owner = repos[0]?.owner;
  if (owner === undefined || owner === null) {
    return { exitCode: 1, stdout: "", stderr: "no oauth token: no GitHub Workspace in this Environment\n", route: "gh-token" };
  }
  const names = [...new Set(repos.filter((ws) => ws.owner === owner).map((ws) => ws.name!))];
  const minted = await services.github().mint({ owner, repositories: names, permissions: ENVIRONMENT_GITHUB_PERMISSIONS });
  return { exitCode: 0, stdout: `${minted.token}\n`, stderr: "", route: "gh-token", detail: `${owner}: ${names.join(",")}` };
};

const clone = async (request: { readonly id: string; readonly url: string }): Promise<Answer> => {
  const services = environmentServices();
  const remote = remoteRepoOf(request.url);
  const url = remote?.https ?? request.url;
  const fields = { host: remote?.host ?? null, owner: remote?.owner ?? null, name: remote?.name ?? null, cloneUrl: url };
  // t3 creates the project, and with it the folder (an empty Workspace), before it clones into it.
  const existing = services.workspaces.get(request.id);
  if (existing !== undefined && existing.cloneUrl !== null) {
    return { exitCode: 128, stdout: "", stderr: `fatal: destination path '${request.id}' already exists and is not an empty directory.\n`, route: "clone" };
  }
  try {
    if (existing === undefined) services.workspaces.create({ id: request.id, ...fields });
    else services.workspaces.setRemote(request.id, fields);
  } catch (error) {
    return { exitCode: 128, stdout: "", stderr: `fatal: ${(error as Error).message}\n`, route: "clone" };
  }
  // The clone's credential helper asks the Workspace DO, which asks this object for a read-only token (SPI-992). Not in
  // the App's installation: a public repo still clones, a private one fails with git's own message.
  const detail = remote?.host === "github.com" ? "github-app" : "public";
  const answer = await workspaceRpc(request.id).clone({ id: request.id, url });
  if (!answer.ran || answer.exitCode !== 0) {
    if (existing === undefined) services.workspaces.remove(request.id);
    else services.workspaces.setRemote(request.id, { host: null, owner: null, name: null, cloneUrl: null });
    const stderr = answer.ran ? answer.stderr : `fatal: ${answer.detail}\n`;
    return { exitCode: answer.ran ? answer.exitCode || 128 : 128, stdout: "", stderr, route: "clone", detail };
  }
  services.workspaces.setState(request.id, "ready");
  return { exitCode: 0, stdout: "", stderr: answer.stderr, route: "clone", detail };
};

/**
 * A Workspace's token for its one repo (ADR-0013; SPI-992), with the repo and its expiry. `read`: the Container token
 * (`CONTAINER_GITHUB_PERMISSIONS`: code read-only, `pull_requests: write`), for the credential helper. `push`: the push
 * gateway's (`contents: write`, and `workflows` only when the Workspace is opted in), which the agents Worker adds to an
 * allowed push and never hands to a Container. Null for a Workspace without a GitHub remote or outside the App.
 */
export const workspaceGitHubToken = async (
  id: string,
  purpose: "read" | "push",
): Promise<{ readonly token: string; readonly expiresAt: number; readonly repo: { readonly owner: string; readonly name: string } } | null> => {
  const record = environmentServices().workspaces.resolve(id);
  if (record === undefined || record.host !== "github.com" || record.owner === null || record.name === null) return null;
  try {
    const minted = await environmentServices().github().mint({
      owner: record.owner.toLowerCase(),
      repositories: [record.name],
      permissions: purpose === "read" ? CONTAINER_GITHUB_PERMISSIONS : record.workflows ? PUSH_GATEWAY_WORKFLOWS_PERMISSIONS : PUSH_GATEWAY_PERMISSIONS,
    });
    return { token: minted.token, expiresAt: minted.expiresAt, repo: { owner: record.owner, name: record.name } };
  } catch (error) {
    console.warn(JSON.stringify({ t3flare: "container-token-failed", id, purpose, error: String(error).slice(0, 300) }));
    return null;
  }
};

/** Temporary index files t3 made on the Environment's side (State directory) and seeded into a Workspace, by path. */
const seededIndexes = new Map<string, { readonly bridged: string; readonly at: number }>();

/**
 * t3 builds temporary indexes (`GIT_INDEX_FILE`) in its own temp directory, which the Container cannot see: it copies
 * the repo's index there, then runs git with the variable set (the commit message's context, the review totals). The
 * router copies such a file into the Workspace's harness directory the first time a git command names it, and points
 * the variable there; from then on the Container's git owns it (t3 only hands it back to git, never reads it).
 */
const bridgeIndex = async (id: string, env: Record<string, string>): Promise<Record<string, string>> => {
  const value = env.GIT_INDEX_FILE;
  if (value === undefined || !value.startsWith("/") || isUnderW(value)) return env;
  let seeded = seededIndexes.get(value);
  if (seeded === undefined) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}\0${value}`));
    const name = [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const bridged = `${HARNESS_ROOT}/tmp/index-${name}/index`;
    const rpc = workspaceRpc(id);
    const entry = StateStore.get(value);
    await rpc.fs({ op: "remove", path: bridged.slice(0, bridged.lastIndexOf("/")), options: { recursive: true, force: true } });
    await rpc.fs({ op: "mkdir", path: bridged.slice(0, bridged.lastIndexOf("/")), recursive: true });
    if (entry !== undefined && entry.kind === "file") await rpc.fs({ op: "write", path: bridged, data: StateStore.readFile(value) });
    seeded = { bridged, at: Date.now() };
    seededIndexes.set(value, seeded);
    for (const [key, old] of seededIndexes) if (Date.now() - old.at > 30 * 60_000) seededIndexes.delete(key);
  }
  return { ...env, GIT_INDEX_FILE: seeded.bridged };
};

const git = async (args: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, unknown>> | undefined, stdin: string | undefined): Promise<Answer> => {
  const at = toWorkspace(cwd);
  if (at === null || environmentServices().workspaces.resolve(at.id) === undefined) {
    return { exitCode: 128, stdout: "", stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`, route: "no-workspace" };
  }
  const startContainer = mayStartContainer(args);
  // SPI-992: no token goes with any git command (the credential helper asks for a read-only one); t3's own push is
  // announced to the push gateway as an expectation for as long as the command runs (review M2).
  const expectation = await expectOwnPush(at.id, at.inner, args);
  const answer = await workspaceRpc(at.id)
    .git({
      argv: args.map((arg) => intoWorkspace(at.id, arg)),
      cwd: at.inner,
      env: await bridgeIndex(at.id, gitEnvOf(at.id, env)),
      ...(stdin === undefined ? {} : { stdin }),
      startContainer,
      readScope: readScopeOf(args),
    })
    .finally(() => (expectation === null ? undefined : workspaceRpc(at.id).unexpectPush({ id: expectation }).catch(() => undefined)));
  if (!answer.ran) {
    const stopped = answer.reason === "container_stopped";
    return {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: t3flare: ${stopped ? "the Workspace's Container is stopped" : answer.detail}\n`,
      route: stopped ? "container-stopped" : "error",
      detail: answer.detail,
    };
  }
  return {
    exitCode: answer.exitCode,
    stdout: gatewayUrlsToGitHub(args, redactTokens(fromWorkspaceText(at.id, answer.stdout))),
    stderr: redactTokens(fromWorkspaceText(at.id, answer.stderr)),
    route: answer.stale !== undefined ? `stale-${answer.stale}` : answer.cached === true ? "cache" : "container",
    // An action's failure keeps git's own words in the trace (tokens taken out), as the evidence of what the remote said.
    detail: `${startContainer ? "action" : "passive"} ${answer.ms}ms${answer.startedContainer === undefined ? "" : ` started the Container: first ${answer.startedContainer} read`}${
      startContainer && answer.exitCode !== 0 ? `: ${redactTokens(answer.stderr).trim().slice(0, 400)}` : ""
    }`,
  };
};

/**
 * t3's own push (the owner's Commit & push, the stack rebase; SPI-992, review M2): what it will update, resolved in the
 * Workspace (`pushPlanOf`'s sources to commits; bare `push` through the branch's push destination), registered with the
 * Workspace DO as an expectation. Null when the argv is not a push, a form `pushPlanOf` does not read, or nothing
 * resolved: the gateway's policy then decides alone.
 */
const expectOwnPush = async (id: string, cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  const plan = pushPlanOf(args);
  if (plan.kind === "not-push" || plan.kind === "unparsed") return null;
  const zero = "0".repeat(40);
  const quote = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
  const script =
    plan.kind === "current"
      ? `b=$(git symbolic-ref -q HEAD) || exit 3; printf 'U %s %s\\n' "$(git for-each-ref --format='%(push:remoteref)' "$b")" "$(git rev-parse --verify -q HEAD^{commit})"`
      : plan.refspecs
          .map((spec) => (spec.src === null ? `printf 'U %s %s\\n' ${quote(spec.dst)} ${zero}` : `printf 'U %s %s\\n' ${quote(spec.dst)} "$(git rev-parse --verify -q ${quote(`${spec.src}^{commit}`)})"`))
          .join("\n");
  const resolved = await workspaceRpc(id)
    .exec({ script, cwd, timeoutMs: 30_000 })
    .catch(() => null);
  if (resolved === null || resolved.exitCode !== 0) return null;
  const updates = resolved.stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^U (refs\/\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line);
      return match === null ? [] : [{ ref: match[1]!, new: match[2]! }];
    });
  if (updates.length === 0) return null;
  const expectation = crypto.randomUUID();
  await workspaceRpc(id).expectPush({ id: expectation, updates });
  console.log(JSON.stringify({ t3flare: "push-expected", id, refs: updates.map((u) => u.ref) }));
  return expectation;
};

// ---------------------------------------------------------------------------------------------------------------------
// Worktrees (step 2b, plan sections 3.2–3.5): a worktree is a Workspace of its own, a full clone.

// t3 never shows git's stderr (it reports its own fixed text), so the trace keeps the reason too.
const fail = (stderr: string, detail?: string): Answer => ({
  exitCode: 128,
  stdout: "",
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`,
  route: "worktree",
  detail: `${detail === undefined ? "" : `${detail}: `}${stderr.trim()}`.slice(0, 1000),
});

/** t3's `git worktree add -- <path> <ref>` in a project: provisions the worktree Workspace (plan section 3.2). */
const worktreeAdd = async (cwd: string, command: Extract<WorktreeCommand, { verb: "add" }>): Promise<Answer> => {
  const services = environmentServices();
  if (command.detach) {
    // Review F6: the PR review guide's scratch checkout (`worktree add --detach`).
    return fail("fatal: t3flare: detached scratch worktrees are not made in the Cloud Environment: every worktree is a Workspace of its own (a clone and a Container), too heavy for a temporary checkout", "detached refused");
  }
  const destination = worktreeDestinationOf(cwd, command.path);
  if ("refused" in destination) return fail(destination.refused, "destination refused");
  const project = toWorkspace(cwd);
  const parent = project === null ? undefined : services.workspaces.resolve(project.id);
  if (parent === undefined || parent.kind !== "project") return fail(`fatal: t3flare: the project at ${cwd} is not a Workspace`);
  const ref = command.newBranch ?? command.ref;
  if (ref === null) return fail("fatal: t3flare: a worktree needs a branch");
  const id = destination.id;
  const existing = services.workspaces.get(id);
  if (existing !== undefined) {
    if (existing.state === "ready" || existing.state === "provisioning") return fail(`fatal: '${command.path}' already exists`);
    // Review F5: t3 makes a worktree's path from its branch, and re-creates a missing one at the same path. A tombstone
    // there is restored (its work kept); a removal still under way is finished first; a failed attempt starts again.
    if (existing.state === "tombstoned") {
      const { restoreWorkspace } = await import("./deletion.ts");
      restoreWorkspace(id);
      return { exitCode: 0, stdout: "", stderr: `Preparing worktree (restoring '${command.path}')\n`, route: "worktree", detail: "tombstone restored" };
    }
    if (existing.state === "deleting") {
      const { purgeWorkspace, referencesFrom } = await import("./deletion.ts");
      const purged = await purgeWorkspace(id, referencesFrom(services.sql).deletedThreads.get(id) ?? []);
      if (!purged.destroyed) return fail(`fatal: t3flare: '${command.path}' is still being removed: ${purged.error ?? ""}`, "deleting");
    } else services.workspaces.remove(id);
  }
  const started = Date.now();
  services.workspaces.createWorktree({ id, parent, branch: ref });
  const timings: Record<string, number> = {};
  const step = async <A>(name: string, run: () => Promise<A>): Promise<A> => {
    const at = Date.now();
    try {
      return await run();
    } finally {
      timings[name] = Date.now() - at;
    }
  };
  const failed = (raw: string): Answer => {
    // The budget's own reason, out of computer's connect-retry wrapping.
    const budget = /the Container cannot start: (.+?)(?:"|$)/s.exec(raw)?.[1];
    const reason = budget === undefined ? raw : `the Container cannot start: ${budget}`;
    services.workspaces.setState(id, "failed", { lastError: raw });
    console.warn(JSON.stringify({ t3flare: "worktree-failed", id, reason: redactTokens(reason).slice(0, 500), timings }));
    return fail(`fatal: t3flare: the worktree Workspace was not made: ${redactTokens(reason).slice(0, 800)}`, JSON.stringify(timings));
  };
  try {
    const worktree = workspaceRpc(id);
    const cloned = await step("clone", () => worktree.worktreeClone({ id, url: parent.cloneUrl, parent: parent.id }));
    if (!cloned.ok) return failed(`clone: ${cloned.error ?? "failed"}`);
    const name = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)))].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const projectRpc = workspaceRpc(parent.id);
    const bundled = await step("bundle", () => projectRpc.worktreeBundle({ ref, tips: cloned.tips, name }));
    if (!bundled.ok || bundled.commit === undefined) return failed(`bundle: ${bundled.error ?? "failed"}`);
    const finished = await step("checkout", () =>
      worktree.worktreeFinish({ parent: parent.id, bundle: bundled.bundle ?? null, ref, commit: bundled.commit!, config: bundled.config ?? [] }),
    );
    if (bundled.bundle) await projectRpc.fs({ op: "remove", path: bundled.bundle, options: { force: true } }).catch(() => undefined);
    if (!finished.ok) return failed(`checkout: ${finished.error ?? "failed"}`);
    // The project-root view (plan section 4.2): the project's untracked files, for setup scripts' `$T3CODE_PROJECT_ROOT`.
    const view = await step("projectRoot", () => worktree.seedProjectRoot({ parent: parent.id })).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
    services.workspaces.setState(id, "ready", { lastError: null });
    const detail = JSON.stringify({ ...timings, totalMs: Date.now() - started, bundled: bundled.bundle !== null && bundled.bundle !== undefined, projectRoot: view });
    console.log(JSON.stringify({ t3flare: "worktree-ready", id, detail }));
    return { exitCode: 0, stdout: "", stderr: `Preparing worktree (checking out '${ref}')\nHEAD is now at ${bundled.commit.slice(0, 7)}\n`, route: "worktree", detail };
  } catch (error) {
    return failed(String(error));
  }
};

/**
 * `git worktree list --porcelain [-z]` in a project: the project's own entry (its real answer, passive), then one per
 * worktree Workspace of it, with HEAD and branch read from that Workspace's own files (never starting a Container).
 */
const worktreeList = async (args: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, unknown>> | undefined, command: Extract<WorktreeCommand, { verb: "list" }>): Promise<Answer> => {
  const own = await git(args, cwd, env, undefined);
  if (own.exitCode !== 0 || !command.porcelain) return own;
  const project = toWorkspace(cwd)!;
  const worktrees = environmentServices().workspaces.worktreesOf(project.id).filter((ws) => ws.state === "ready");
  const entries = await Promise.all(
    worktrees.map(async (ws) => {
      const head = await workspaceRpc(ws.id).worktreeHead().catch(() => ({ head: null, branch: null }));
      return { path: `/w/${ws.id}`, head: head.head, branch: head.branch ?? (ws.branch === null ? null : `refs/heads/${ws.branch}`) };
    }),
  );
  const main = parseWorktreeList(own.stdout, command.z).slice(0, 1);
  return { ...own, stdout: worktreeListPorcelain([...main, ...entries], command.z), route: "worktree", detail: `${entries.length} worktree Workspaces` };
};

/** The worktree verbs in a project; null for a worktree command that its own Workspace's git answers. */
const worktreeRouteOf = (
  args: ReadonlyArray<string>,
  cwd: string,
): ((env: Readonly<Record<string, unknown>> | undefined, stdin: string | undefined) => Promise<Answer>) | null => {
  const command = worktreeCommandOf(args);
  const at = toWorkspace(cwd);
  if (command === null || at === null || at.id.startsWith(".wt/")) return null;
  switch (command.verb) {
    case "add":
      return () => worktreeAdd(cwd, command);
    case "list":
      return (env) => worktreeList(args, cwd, env, command);
    case "prune":
      // The registry keeps no stale links.
      return async () => ({ exitCode: 0, stdout: "", stderr: "", route: "worktree" });
    case "remove":
      return async () => {
        const { removeWorktree } = await import("./deletion.ts");
        const services = environmentServices();
        const answer = await removeWorktree(cwd, command.path, command.force, services.sql, services.sweep);
        return { exitCode: answer.exitCode, stdout: "", stderr: answer.stderr, route: "worktree", detail: answer.detail };
      };
    case "unsupported":
      return async () => fail(`fatal: t3flare: 'git worktree ${command.name}' is not supported in the Cloud Environment`);
  }
};

/** What `git --version` says: the Workspace image's git (apps/sandbox-image; M0's check printed 2.56.0). */
const GIT_VERSION = "git version 2.56.0";

/** `-C <dir>` options folded into the cwd, as git applies them (each relative to the last). */
const withoutDashC = (argv: ReadonlyArray<string>, cwd: string | undefined): { readonly args: ReadonlyArray<string>; readonly cwd: string | undefined } => {
  const args: Array<string> = [];
  let at = cwd;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-C" && i + 1 < argv.length) {
      const dir = argv[++i]!;
      at = dir.startsWith("/") ? dir : at === undefined ? undefined : `${at}/${dir}`;
    } else if (arg === "-c" && i + 1 < argv.length) {
      args.push(arg, argv[++i]!);
    } else if (arg.startsWith("-")) {
      args.push(arg);
    } else break;
  }
  return { args: [...args, ...argv.slice(i)], cwd: at === undefined ? undefined : normalize(at) };
};

/** The account `gh auth status` names when no GitHub Workspace names the GitHub App installation's account yet. */
const GH_APP_LOGIN = "t3flare[bot]";

/**
 * `gh auth status --json hosts`: always signed in to github.com, as the Environment's GitHub tokens come from the
 * GitHub App (ADR-0013), not a login. The account is the installation's (a GitHub Workspace's owner, the one
 * `gh auth token` mints for), else the App's own label. In the shape t3's `parseGitHubAuth` reads (gh 2.81+).
 */
const ghAuthStatus = async (): Promise<Answer> => {
  const owner = environmentServices()
    .workspaces.list()
    .find((ws) => ws.host === "github.com" && ws.owner !== null)?.owner;
  const login = owner ?? GH_APP_LOGIN;
  const hosts = { "github.com": [{ state: "success", active: true, host: "github.com", login, tokenSource: "t3flare-github-app" }] };
  return { exitCode: 0, stdout: `${JSON.stringify({ hosts })}\n`, stderr: "", route: "emulated" };
};

/** gh as t3's GitHub provider uses it: its version, its sign-in, and its token, from the GitHub App. */
const ghRouteOf = (args: ReadonlyArray<string>): (() => Promise<Answer>) | null => {
  if (args[0] === "--version") return async () => ({ exitCode: 0, stdout: "gh version 2.83.0 (t3flare)\n", stderr: "", route: "emulated" });
  if (args[0] === "config" && args[1] === "get") return async () => ({ exitCode: 0, stdout: "\n", stderr: "", route: "emulated" });
  if (args[0] === "auth" && args[1] === "token") return () => ghToken();
  if (args[0] === "auth" && args[1] === "status") return () => ghAuthStatus();
  return null;
};

/** What answers `command`, or null when nothing does (a missing binary). */
const routeOf = (
  name: string,
  argv: ReadonlyArray<string>,
  spawnCwd: string | undefined,
): ((env: Readonly<Record<string, unknown>> | undefined, stdin: string | undefined) => Promise<Answer>) | null => {
  if (name === "gh") return ghRouteOf(argv);
  if (name !== "git") return null;
  if (argv.length === 1 && argv[0] === "--version") return async () => ({ exitCode: 0, stdout: `${GIT_VERSION}\n`, stderr: "", route: "emulated" });
  // `git -C <dir> …`: the directory is the command's cwd.
  const { args, cwd } = withoutDashC(argv, spawnCwd);
  if (cwd === undefined) return null;
  const cloneRequest = cloneRequestOf(args, cwd);
  if (cloneRequest !== null) return () => clone(cloneRequest);
  const normal = normalize(cwd);
  const worktree = worktreeRouteOf(args, normal);
  if (worktree !== null) return worktree;
  // Outside the Workspaces there is no repository: git says so, as it would on a laptop.
  if (!normal.startsWith("/w/")) {
    return async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      route: "no-workspace",
    });
  }
  return (env, stdin) => git(args, normal, env, stdin);
};

const notFound = (name: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: `t3flare: the Environment DO cannot run '${name}'`,
      pathOrDescriptor: name,
    }),
  );

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const spawn = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    if (command._tag !== "StandardCommand") {
      spawnAttempts.set("pipeline", (spawnAttempts.get("pipeline") ?? 0) + 1);
      return yield* notFound("pipeline");
    }
    const name = command.command.replace(/^.*\//, "");
    const args = command.args.map((word) => (typeof word === "string" ? word : Redacted.value(word)));
    const cwd = command.options.cwd;
    // Step 4a: a CLI agent streams through the process channel to its Workspace's Container.
    if (CLI_NAMES.has(name)) {
      const started = Date.now();
      return yield* spawnCli(command).pipe(
        Effect.tap(() => Effect.sync(() => record({ at: started, command: name, argv: traceArgv(args.slice(0, 4)), cwd: cwd ?? null, route: "process", exitCode: null, ms: Date.now() - started }))),
        Effect.tapError((error) => Effect.sync(() => record({ at: started, command: name, argv: traceArgv(args.slice(0, 4)), cwd: cwd ?? null, route: "error", exitCode: null, ms: Date.now() - started, detail: String(error).slice(0, 300) }))),
      );
    }
    const route = routeOf(name, args, cwd);
    if (route === null) {
      spawnAttempts.set(name, (spawnAttempts.get(name) ?? 0) + 1);
      record({ at: Date.now(), command: name, argv: traceArgv(args), cwd: cwd ?? null, route: "not-found", exitCode: null, ms: 0 });
      return yield* notFound(name);
    }

    // stdin arrives through the handle's sink, written alongside the output's reads; the command runs once it ends
    // (or at once, when nothing writes it within a few milliseconds).
    const stdinChunks: Array<Uint8Array> = [];
    let stdinStarted = false;
    const stdinDone = yield* Deferred.make<void>();
    const env = command.options.env as Readonly<Record<string, unknown>> | undefined;
    const started = Date.now();
    const answer = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Effect.sleep(5);
        if (stdinStarted) yield* Deferred.await(stdinDone);
        const stdin = stdinChunks.length === 0 ? undefined : stdinChunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
        return yield* Effect.tryPromise({
          try: () => route(env, stdin),
          catch: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "spawn",
              description: `t3flare: ${name}: ${String(cause).slice(0, 300)}`,
              pathOrDescriptor: name,
            }),
        });
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            record({
              at: started,
              command: name,
              argv: traceArgv(args),
              cwd: cwd ?? null,
              route: result.route,
              exitCode: result.exitCode,
              ms: Date.now() - started,
              ...(result.detail === undefined ? {} : { detail: redactTokens(result.detail) }),
            }),
          ),
        ),
        Effect.tapError((error) =>
          Effect.sync(() =>
            record({ at: started, command: name, argv: traceArgv(args), cwd: cwd ?? null, route: "error", exitCode: null, ms: Date.now() - started, detail: String(error).slice(0, 300) }),
          ),
        ),
      ),
    );

    const output = (pick: (result: Answer) => string) =>
      Stream.fromEffect(answer).pipe(
        Stream.map((result) => encoder.encode(pick(result))),
        Stream.filter((bytes) => bytes.byteLength > 0),
      );

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.map(answer, (result) => ChildProcessSpawner.ExitCode(result.exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          stdinStarted = true;
          stdinChunks.push(chunk);
        }),
      ).pipe(Sink.ensuring(Deferred.succeed(stdinDone, undefined))),
      stdout: output((result) => result.stdout),
      stderr: output((result) => result.stderr),
      all: Stream.concat(
        output((result) => result.stdout),
        output((result) => result.stderr),
      ),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

export const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));

/** For tests: the subcommand a traced argv ran. */
export const subcommand = (argv: ReadonlyArray<string>) => subcommandOf(argv).name;
