// Parity G7 (SPI-998): t3's PR review guide's scratch checkout, as t3 makes it (`PullRequestReviewGuideService.checkoutHead`):
// a temporary directory in its worktrees directory through `FileSystem`, `git worktree add --detach` in the project, git
// in the checkout, `git worktree remove --force` and the directory's removal. Each git command must reach the project's
// Workspace DO as an action (never the read cache), with t3's own paths, which the Container shares.
import { afterEach, describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { codexExecArgs, profileLaunch } from "../src/agents/cliProfiles.ts";
import { spawn } from "../src/agents/processRouter.ts";
import { clearScratches, scratchProjectOf } from "../src/agents/scratch.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { routing } from "../src/platform/routingFileSystem.ts";
import { execOutcome } from "../src/provider/cli/codexInvestigation.ts";

const record = (id: string): WorkspaceRecord =>
  ({ id, host: "github.com", owner: "o", name: id, cloneUrl: `https://github.com/o/${id}.git`, state: "ready", kind: "project", parent: null, branch: null, workflows: false }) as unknown as WorkspaceRecord;

interface GitCall {
  readonly workspace: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly startContainer: boolean;
}

const calls: Array<GitCall> = [];

const bind = () => {
  const records = new Map([["demo", record("demo")]]);
  bindEnvironmentServices({
    workspaces: { list: () => [...records.values()], resolve: (id: string) => records.get(id), get: (id: string) => records.get(id), worktreesOf: () => [] },
    github: () => ({ live: () => [] }),
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          git: async (run: { argv: ReadonlyArray<string>; cwd: string; startContainer: boolean }) => {
            calls.push({ workspace: name, argv: run.argv, cwd: run.cwd, startContainer: run.startContainer });
            return { ran: true, exitCode: 0, stdout: "abc123\n", stderr: "", ms: 1 };
          },
        }),
      },
    },
  } as unknown as EnvironmentServices);
};

const run = (args: ReadonlyArray<string>, cwd: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* spawn(ChildProcess.make("git", [...args], { cwd }) as ChildProcess.Command);
      const text = (stream: Stream.Stream<Uint8Array, unknown>) => Stream.runFold(stream, () => "", (acc, bytes) => acc + new TextDecoder().decode(bytes));
      const stderr = yield* text(handle.stderr);
      return { exitCode: yield* handle.exitCode, stderr };
    }).pipe(Effect.scoped),
  );

const fail = () => Effect.die("local file system not expected");
const fs = routing(new Proxy({}, { get: () => fail }) as Parameters<typeof routing>[0]);

afterEach(() => {
  calls.splice(0);
  clearScratches();
});

describe("a review guide's scratch checkout", () => {
  it("runs t3's own commands in the project's Container, at t3's paths, as actions", async () => {
    bind();
    const dir = await Effect.runPromise(fs.makeTempDirectory({ directory: "/w/.wt", prefix: "review-guide-" }));
    expect(dir).toMatch(/^\/w\/\.wt\/review-guide-[0-9a-f]{16}$/);
    const checkout = `${dir}/checkout`;

    const add = ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", checkout, "0123456789abcdef0123456789abcdef01234567"];
    expect((await run(add, "/w/demo")).exitCode).toBe(0);
    expect(scratchProjectOf(checkout)).toBe("demo");
    expect(calls.at(-1)).toEqual({ workspace: "demo", argv: add, cwd: "/workspace/repo", startContainer: true });

    // merge-base and diff are passive reads elsewhere; in a scratch checkout they always run in the Container.
    expect((await run(["merge-base", "aaaa", "HEAD"], checkout)).exitCode).toBe(0);
    expect(calls.at(-1)).toEqual({ workspace: "demo", argv: ["-C", checkout, "merge-base", "aaaa", "HEAD"], cwd: "/workspace/repo", startContainer: true });

    const remove = ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", "--force", "--", checkout];
    expect((await run(remove, "/w/demo")).exitCode).toBe(0);
    expect(calls.at(-1)).toEqual({ workspace: "demo", argv: remove, cwd: "/workspace/repo", startContainer: true });

    // t3's `FileSystem.exists` on the removed checkout answers false, and the directory's removal forgets it.
    expect(await Effect.runPromise(fs.access(checkout).pipe(Effect.as(true), Effect.orElseSucceed(() => false)))).toBe(false);
    await Effect.runPromise(fs.remove(dir, { recursive: true }));
    expect(scratchProjectOf(checkout)).toBeUndefined();
  });

  it("forgets the directory when t3's scope closes", async () => {
    bind();
    const dir = await Effect.runPromise(Effect.scoped(fs.makeTempDirectoryScoped({ directory: "/w/.wt", prefix: "review-guide-" })));
    expect((await run(["worktree", "add", "--detach", `${dir}/checkout`, "HEAD"], "/w/demo")).exitCode).toBe(128);
  });

  it("refuses a detached worktree anywhere else, and temporary directories elsewhere in /w", async () => {
    bind();
    const answer = await run(["worktree", "add", "--detach", "/w/.wt/demo/x", "HEAD"], "/w/demo");
    expect(answer.exitCode).toBe(128);
    expect(answer.stderr).toContain("scratch directory");
    expect(calls).toEqual([]);
    expect(await Effect.runPromise(fs.makeTempDirectory({ directory: "/w/demo" }).pipe(Effect.as("made"), Effect.orElseSucceed(() => "refused")))).toBe("refused");
    expect(await Effect.runPromise(fs.makeTempDirectory({ directory: "/w/.wt", prefix: "../x" }).pipe(Effect.as("made"), Effect.orElseSucceed(() => "refused")))).toBe("refused");
  });

  it("binds a checkout to one project only", async () => {
    bind();
    const dir = await Effect.runPromise(fs.makeTempDirectory({ directory: "/w/.wt", prefix: "review-guide-" }));
    expect((await run(["worktree", "add", "--detach", `${dir}/a/b`, "HEAD"], "/w/demo")).exitCode).toBe(128);
    expect(calls).toEqual([]);
  });
});

describe("Codex's investigation (`codex exec`)", () => {
  const context = { proxyUrl: "https://proxy.example", models: [], readStateFile: (path: string) => (path === "/t3/state/tmp/schema" ? '{"type":"object"}' : undefined), piExtensionSource: "" };
  const launch = (args: ReadonlyArray<string>) => profileLaunch({ cli: "codex", args, key: "proc-1", cwd: "/w/.wt/review-guide-x/checkout", env: {}, allowProbe: false }, context);

  it("runs read-only, never asking, with the schema copied into its home", () => {
    const answer = launch(codexExecArgs("gpt-6-luna", "/t3/state/tmp/schema"));
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv.slice(-11)).toEqual(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--model", "gpt-6-luna", "--output-schema", "/var/lib/t3flare/cli/proc-1/output-schema.json", "-"]);
    expect(answer.argv).toContain('approval_policy="never"');
    expect(answer.argv.filter((arg) => arg.startsWith("approval_policy=") || arg.startsWith("sandbox_mode="))).toEqual(['approval_policy="never"']);
    expect(answer.argv.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
    expect(answer.files).toContainEqual({ path: "/var/lib/t3flare/cli/proc-1/output-schema.json", text: '{"type":"object"}' });
  });

  it("refuses any other exec", () => {
    expect(launch(["exec", "hi"])).toHaveProperty("refused");
    expect(launch(codexExecArgs("gpt-6-luna", "/t3/state/other"))).toHaveProperty("refused");
    expect(launch(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "--model", "m", "--output-schema", "/t3/state/tmp/schema", "-"])).toHaveProperty("refused");
    expect(launch(codexExecArgs("m; rm -rf /", "/t3/state/tmp/schema"))).toHaveProperty("refused");
  });

  it("answers the last agent message of `--json`'s events, or why the turn failed", () => {
    const events = [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "1", type: "agent_message", text: "looking" } },
      { type: "item.completed", item: { id: "2", type: "command_execution", command: "git log" } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: '{"summary":"x"}' } },
      { type: "turn.completed" },
    ];
    expect(execOutcome(events.map((event) => JSON.stringify(event)).join("\n"))).toEqual({ message: '{"summary":"x"}' });
    expect(execOutcome(`${JSON.stringify({ type: "turn.failed", error: { message: "quota" } })}\n`)).toEqual({ error: "quota" });
    expect(execOutcome("")).toEqual({ error: "Codex gave no answer" });
  });
});
