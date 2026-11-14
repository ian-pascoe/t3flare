// The Codex request guard (step 4a, plan §3.1, §5.1; back to stock, owner 2026-11-12): t3's requests pass as t3 sends
// them but the provider pin, `feedback/*` and `account/*`; each turn's policy is t3's own mode table (CodexAdapterV2's
// `auto` with its reviewer included), with the no-sandbox fallback; plan read-only. Expected policies written out.
import { describe, expect, it } from "vitest";

import { codexModelRoute, declinesInPlan, guardRequest, turnPolicy } from "../src/provider/cli/codexGuard.ts";

const sandboxed = { sandbox: true } as const;

describe("the Codex request guard", () => {
  it("refuses feedback and account (no vendor upload or sign-in, K3), and passes every other method as t3 sends it", () => {
    expect(guardRequest("feedback/upload", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("account/rateLimits/read", {}, sandboxed)).toHaveProperty("refused");
    expect(guardRequest("account/login/start", {}, sandboxed)).toHaveProperty("refused");
    for (const method of ["config/value/write", "command/exec", "fs/writeFile", "mcpServer/tool/call", "thread/brandNew"]) {
      expect(guardRequest(method, { a: 1 }, sandboxed), method).toEqual({ params: { a: 1 } });
    }
    expect(guardRequest("turn/interrupt", { threadId: "x" }, sandboxed)).toEqual({ params: { threadId: "x" } });
  });

  it("keeps t3's thread config as sent but the provider pin, and drops policy and provider params", () => {
    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      const answer = guardRequest(
        method,
        {
          cwd: "/w/demo",
          model: "gpt-6-luna",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          modelProvider: "openai",
          profile: "evil",
          config: {
            "tools.update_plan.enabled": true,
            "shell_environment_policy.set.T3CODE_THREAD_ID": "t1",
            "mcp_servers.t3-code": { url: "https://x/mcp", http_headers: { Authorization: "Bearer secret" } },
            "mcp_servers.other": { command: "npx", args: ["server"] },
            "features.brand_new": true,
            model_provider: "openai",
            "model_providers.evil": { base_url: "https://evil" },
            profile: "evil",
            "profiles.evil": { model_provider: "evil" },
            openai_base_url: "https://evil",
            chatgpt_base_url: "https://evil",
            approval_policy: "never",
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
            "shell_environment_policy.set.T3CODE_THREAD_ID": "t1",
            "mcp_servers.t3-code": { url: "https://x/mcp", http_headers: { Authorization: "Bearer secret" } },
            "mcp_servers.other": { command: "npx", args: ["server"] },
            "features.brand_new": true,
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
    // t3's `auto` (CodexAdapterV2): on-request with Codex's own reviewer.
    expect(policy(turn("auto", true))).toEqual({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" }, approvalsReviewer: "auto_review" });
    expect(policy(turn(undefined, true))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
    // Without a sandbox: never less asking.
    expect(policy(turn("approval-required", false))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
    expect(policy(turn("auto-accept-edits", false))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
    expect(policy(turn("auto", false))).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" });
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

  describe("Model endpoints (SPI-1167)", () => {
    const route = (model: string) => codexModelRoute(model, new Set(["openai", "work"]), (id) => `t3flare-endpoint-${id}`, "t3flare-proxy");

    it("routes an endpoint's slug to its provider with the model's own id, and anything else to the proxy as sent", () => {
      expect(route("openai/gpt-5-mini")).toEqual({ provider: "t3flare-endpoint-openai", model: "gpt-5-mini" });
      expect(route("work/org/model-a")).toEqual({ provider: "t3flare-endpoint-work", model: "org/model-a" });
      expect(route("gpt-6-luna")).toEqual({ provider: "t3flare-proxy", model: "gpt-6-luna" });
      expect(route("other/x")).toEqual({ provider: "t3flare-proxy", model: "other/x" });
      expect(route("openai/")).toEqual({ provider: "t3flare-proxy", model: "openai/" });
    });

    it("names each thread's provider from its model, over anything t3 or a config sent", () => {
      for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
        expect(guardRequest(method, { model: "openai/gpt-5-mini", modelProvider: "evil", config: { model_provider: "evil" } }, { ...sandboxed, route })).toEqual({
          params: { model: "gpt-5-mini", modelProvider: "t3flare-endpoint-openai", config: {} },
        });
      }
      expect(guardRequest("thread/resume", { threadId: "t1" }, { ...sandboxed, route })).toEqual({ params: { threadId: "t1" } });
    });

    it("gives a turn the model's own id, and refuses a turn on another provider than its thread's", () => {
      const context = { ...sandboxed, route, threadProvider: (thread: string) => (thread === "t1" ? "t3flare-endpoint-openai" : undefined) };
      const answer = guardRequest("turn/start", { threadId: "t1", model: "openai/gpt-5-mini", collaborationMode: { mode: "default", settings: { model: "openai/gpt-5-mini" } } }, context);
      expect(answer).toMatchObject({ params: { model: "gpt-5-mini", collaborationMode: { mode: "default", settings: { model: "gpt-5-mini" } } } });
      expect(guardRequest("turn/start", { threadId: "t1", model: "gpt-6-luna" }, context)).toHaveProperty("refused");
      expect(guardRequest("turn/start", { threadId: "t1", model: "work/m" }, context)).toHaveProperty("refused");
      // A thread the client has not seen yet is not judged.
      expect(guardRequest("turn/start", { threadId: "t2", model: "work/m" }, context)).toMatchObject({ params: { model: "m" } });
    });
  });
});
