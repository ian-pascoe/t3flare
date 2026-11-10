// @effect-diagnostics globalDate:off asyncFunction:off
// M0's exit check (step 2a plan, section 7): `POST /_t3flare/check/agents`. Calls into the agents Worker and back,
// starts Containers in two Workspaces, checks the paths, the Container budget, and a GitHub token's scope. Never boots t3.
import { CONTAINER_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";

import { byName } from "../agents/rpc.ts";
import type { EnvironmentDO } from "../environmentDO.ts";

const pathsScript = (workspaceId: string) => `
set -u
echo "git: $(git --version)"
echo "mise: $(mise ls --current 2>/dev/null | tr -s ' ' | tr '\\n' ';')"
mkdir -p /workspace/repo /w
echo "from the container" > /workspace/repo/from-container.txt
target=/w/${workspaceId}
if mkdir -p "$target" && mount --bind /workspace/repo "$target" 2>/dev/null; then echo "link: bind"; else rmdir "$target" 2>/dev/null; ln -sfn /workspace/repo "$target" && echo "link: symlink"; fi
cd /workspace/repo && git init -q 2>/dev/null
cd "$target" && echo "pwd -P: $(pwd -P)" && echo "toplevel: $(git rev-parse --show-toplevel)"
echo "agent file: $(cat /workspace/repo/from-do.txt 2>/dev/null || echo missing)"
`;

const lsRemote = (repo: string, token: string) =>
  `git -c credential.helper= ls-remote https://x-access-token:${token}@github.com/${repo}.git HEAD >/dev/null 2>&1 && echo ok || echo refused`;

export const agentsCheck = async (environment: EnvironmentDO, request: Request) => {
  const url = new URL(request.url);
  const agents = environment.agents;
  const report: Record<string, unknown> = { at: new Date().toISOString() };

  // 1. Both directions of the cross-Worker binding.
  report.sessionRoundTrip = await byName(agents.SESSIONS, "thread:m0-check", "SESSIONS").ping("m0");

  // 2. Containers in two Workspaces: start, tools, paths (agent writes on the DO side first).
  const workspaces = ["m0-a", "m0-b"];
  const containers: Record<string, unknown> = {};
  for (const id of workspaces) {
    const workspace = byName(agents.WORKSPACES, id, "WORKSPACES");
    await workspace.writeText("/workspace/repo/from-do.txt", `written by the agent in ${id}`);
    const started = Date.now();
    const result = await workspace.exec({ script: pathsScript(id), timeoutMs: 180_000 });
    containers[id] = {
      exitCode: result.exitCode,
      wallMs: Date.now() - started,
      execMs: result.ms,
      stdout: result.stdout.trim().split("\n"),
      stderr: result.stderr.trim().slice(-2000),
      // A file the Container wrote is read from the Workspace's own files.
      readFromDo: await workspace.readText("/workspace/repo/from-container.txt"),
      state: await workspace.containerState(),
    };
  }
  report.containers = containers;

  // 3. The budget: with three slots held by others, a fourth start is refused.
  if (url.searchParams.get("budget") !== "0") {
    const budget = byName(agents.CONTAINER_BUDGET, "budget", "CONTAINER_BUDGET");
    const held = ["m0-fake-1", "m0-fake-2", "m0-fake-3"];
    for (const id of workspaces) await byName(agents.WORKSPACES, id, "WORKSPACES").stopContainer();
    const acquired = [];
    for (const holder of held) acquired.push(await budget.acquire(holder));
    const refused = await byName(agents.WORKSPACES, "m0-c", "WORKSPACES")
      .exec({ script: "echo should-not-run", timeoutMs: 60_000 })
      .then(
        (ran) => ({ refused: false, ran }),
        (error: unknown) => ({ refused: true, error: String(error).slice(0, 500) }),
      );
    const stateWhileFull = await budget.state();
    for (const holder of held) await budget.release(holder);
    report.budget = { acquired: acquired.map((a) => a.ok), fourthStart: refused, stateWhileFull, after: await budget.state() };
  }

  // 4. A Container token names its one repo.
  const repo = url.searchParams.get("repo") ?? "ian-pascoe/t3flare-fixture";
  const other = url.searchParams.get("other") ?? "ian-pascoe/mac-bridge";
  if (environment.github.configured) {
    const [owner = "", name = ""] = repo.split("/");
    const minted = await environment.github.mint({ owner, repositories: [name], permissions: CONTAINER_GITHUB_PERMISSIONS });
    const workspace = byName(agents.WORKSPACES, "m0-a", "WORKSPACES");
    const result = await workspace.exec({
      script: `echo "own: $(${lsRemote(repo, "$T")})"; echo "other: $(${lsRemote(other, "$T")})"`,
      env: { T: minted.token },
      timeoutMs: 180_000,
    });
    report.githubToken = {
      repo,
      other,
      expiresInMinutes: Math.round((minted.expiresAt - Date.now()) / 60_000),
      stdout: result.stdout.trim().split("\n"),
      exitCode: result.exitCode,
    };
  } else {
    report.githubToken = "not configured";
  }

  for (const id of [...workspaces, "m0-c"]) await byName(agents.WORKSPACES, id, "WORKSPACES").stopContainer();
  report.stopped = true;
  return report;
};
