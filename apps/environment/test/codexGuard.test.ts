// The Codex request guard (step 4a, plan §3.1, §5.1 with review F5): allowlisted methods and thread config, the mode
// table with and without a sandbox (M0 P2), plan read-only. Expected policies are the plan's table, written out.
import { describe, expect, it } from "vitest";

import { declinesInPlan, guardRequest, turnPolicy } from "../src/provider/cli/codexGuard.ts";

const sandboxed = { sandbox: true } as const;

describe("the Codex request guard", () => {
  it("refuses feedback, account and anything not on the list", () => {
    expect(guardRequest("feedback/upload", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("account/rateLimits/read", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("account/login/start", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("config/value/write", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("command/exec", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("fs/writeFile", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("mcpServer/tool/call", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("turn/interrupt", { threadId: "x" }, sandboxed)).toEqual({ params: { threadId: "x" } });
  });

  it("keeps only t3's own thread config keys on thread/start, resume and fork, and drops policy params", () => {
    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      const answer = guardRequest(
        method,
        {
          cwd: "/w/demo",
          model: "gpt-6-luna",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          config: {
            "tools.update_plan.enabled": true,
            mcp_optional_startup_grace_ms: 10_000,
            "features.concurrent_reasoning_summaries": true,
            "shell_environment_policy.set.T3CODE_THREAD_ID": "t1",
            "mcp_servers.t3-code": { url: "https://x/mcp", http_headers: { Authorization: "Bearer secret" } },
            model_provider: "openai",
            "model_providers.evil": { base_url: "https://evil" },
            "shell_environment_policy.inherit": "all",
            sandbox_mode: "danger-full-access",
          },
        },
        sandboxed,
      );
      expect(answer).toEqual({
        params: {
          cwd: "/w/demo",
          model: "gpt-6-luna",
          config: {
            "tools.update_plan.enabled": true,
            mcp_optional_startup_grace_ms: 10_000,
            "features.concurrent_reasoning_summaries": true,
            "shell_environment_policy.set.T3CODE_THREAD_ID": "t1",
          },
        },
      });
    }
  });

  it("replaces each turn's policy from the mode table, whatever t3 asked", () => {
    const turn = (runtimeMode: string | undefined, sandbox: boolean, plan = false) =>
      guardRequest(
        "turn/start",
        { threadId: "n", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "auto_review", collaborationMode: { mode: plan ? "plan" : "default" } },
        { ...(runtimeMode === undefined ? {} : { runtimeMode }), sandbox },
      );
    const policy = (answer: ReturnType<typeof turn>) => ("params" in answer ? (({ approvalPolicy, sandboxPolicy, approvalsReviewer }: any) => ({ approvalPolicy, sandboxPolicy, approvalsReviewer }))(answer.params) : answer);
    expect(policy(turn("approval-required", true))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
    expect(policy(turn("auto-accept-edits", true))).toEqual({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" }, approvalsReviewer: "user" });
    expect(policy(turn("full-access", true))).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
    expect(policy(turn("auto", true))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
    expect(policy(turn(undefined, true))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
    // Without a sandbox: never less asking.
    expect(policy(turn("approval-required", false))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
    expect(policy(turn("auto-accept-edits", false))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
    // Plan is read-only whatever the mode.
    expect(policy(turn("full-access", true, true))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
  });

  it("runs an unknown interaction mode as plan", () => {
    expect(turnPolicy({ runtimeMode: "full-access", interactionMode: "mystery", sandbox: true }, false).approvalPolicy).toBe("untrusted");
  });

  it("declines file changes in plan mode", () => {
    expect(declinesInPlan("item/fileChange/requestApproval")).toBe(true);
    expect(declinesInPlan("item/commandExecution/requestApproval")).toBe(false);
  });
});
