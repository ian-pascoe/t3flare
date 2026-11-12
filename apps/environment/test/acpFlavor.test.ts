// The ACP flavors' shared policy (step 4b, plan §5 with review F1, F9; back to stock, owner 2026-11-12): the agent is
// pinned to its asking mode and t3 decides as stock t3's adapters do. Request and option shapes are the ones M0's
// probes recorded from claude-agent-acp 0.106.0 and opencode 2.2.7.
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vitest";

import {
  cliModelId,
  cliPermissionDisposition,
  cliPromptFailure,
  cliRuntimeModeForSessionMode,
  cliSessionModeForPolicy,
  exitPlanMarkdown,
  KEY_NAME,
} from "../src/provider/cli/acpFlavor.ts";

const CWD = "/w/ws-1";
const policy = (runtimeMode: string, interactionMode: "default" | "plan" = "default") => ({ runtimeMode, interactionMode, cwd: CWD }) as never;
const request = (kind: string | null, paths: ReadonlyArray<string> | null = null, rawInput?: unknown) =>
  ({ toolCall: { toolCallId: "t", kind, locations: paths === null ? null : paths.map((path) => ({ path })), ...(rawInput === undefined ? {} : { rawInput }) } }) as never;

describe("permission disposition (the agent asks, t3 decides)", () => {
  it("at approval-required asks for every edit and command, and lets reads through", () => {
    expect(cliPermissionDisposition(policy("approval-required"), request("edit", [`${CWD}/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("execute", [CWD]))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("fetch"))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request(null))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("read", [`${CWD}/a.txt`]))).toBe("allow");
    expect(cliPermissionDisposition(policy("approval-required"), request("search"))).toBe("allow");
  });

  it("at auto-accept-edits allows every edit, wherever it points, and asks for the rest (stock t3's rule)", () => {
    const mode = policy("auto-accept-edits");
    for (const paths of [[`${CWD}/src/a.ts`], ["/etc/claude-code/managed-settings.json"], [`${CWD}/.claude/settings.json`], [], null]) {
      expect(cliPermissionDisposition(mode, request("edit", paths)), JSON.stringify(paths)).toBe("allow");
    }
    expect(cliPermissionDisposition(mode, request("move", [`${CWD}/a.txt`, "/tmp/a.txt"]))).toBe("allow");
    expect(cliPermissionDisposition(mode, request("execute", [CWD]))).toBe("ask");
  });

  it("at full-access allows every request", () => {
    expect(cliPermissionDisposition(policy("full-access"), request("edit", ["/etc/x"]))).toBe("allow");
    expect(cliPermissionDisposition(policy("full-access"), request("execute"))).toBe("allow");
  });

  it("in a plan turn denies edits and leaving plan mode, and asks for commands, whatever the runtime mode (review F1)", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"]) {
      expect(cliPermissionDisposition(policy(mode, "plan"), request("edit", [`${CWD}/a.txt`]))).toBe("deny");
      expect(cliPermissionDisposition(policy(mode, "plan"), request("switch_mode", null, { plan: "# Plan" }))).toBe("deny");
      expect(cliPermissionDisposition(policy(mode, "plan"), request("execute"))).toBe("ask");
      expect(cliPermissionDisposition(policy(mode, "plan"), request("read"))).toBe("allow");
    }
  });

  it("asks for whatever the agent asks at `auto` (Claude's own auto mode decides what to ask; OpenCode asks, as stock), and runs an unknown mode as approval-required", () => {
    expect(cliPermissionDisposition(policy("auto"), request("edit", [`${CWD}/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(policy("auto"), request("execute"))).toBe("ask");
    expect(cliPermissionDisposition(policy("auto"), request("read"))).toBe("allow");
    expect(cliPermissionDisposition(policy("yolo"), request("execute"))).toBe("ask");
  });
});

describe("modes", () => {
  it("pins the asking mode, and puts Claude in its own auto mode for t3's `auto` outside plan turns (stock t3's Claude adapter)", () => {
    expect(cliSessionModeForPolicy("claude")(policy("approval-required"))).toBe("default");
    expect(cliSessionModeForPolicy("claude")(policy("full-access"))).toBe("default");
    expect(cliSessionModeForPolicy("claude")(policy("auto"))).toBe("auto");
    expect(cliSessionModeForPolicy("claude")(policy("auto", "plan"))).toBe("default");
  });

  it("places the pinned, plan and auto modes under a runtime mode, and nothing else", () => {
    expect(cliRuntimeModeForSessionMode("claude")("default")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("claude")("plan")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("claude")("auto")).toBe("auto");
    expect(cliRuntimeModeForSessionMode("claude")("acceptEdits")).toBeUndefined();
    expect(cliRuntimeModeForSessionMode("claude")("bypassPermissions")).toBeUndefined();
    expect(cliRuntimeModeForSessionMode("opencode")("build")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("opencode")("sneaky")).toBeUndefined();
  });

  it("reads Claude's plan from its ExitPlanMode request", () => {
    expect(exitPlanMarkdown(request("switch_mode", null, { plan: "  # Add d.txt\n\n1. Write it  " }))).toBe("# Add d.txt\n\n1. Write it");
    expect(exitPlanMarkdown(request("switch_mode", null, {}))).toBeUndefined();
    expect(exitPlanMarkdown(request("edit", null, { plan: "x" }))).toBeUndefined();
  });
});

describe("models and failures", () => {
  it("names a catalog model as each CLI does", () => {
    expect(cliModelId("claude", "anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(cliModelId("claude", "anthropic/gpt-6-luna")).toBe("gpt-6-luna");
    expect(cliModelId("opencode", "anthropic/deepseek-v4-pro")).toBe("t3flare/deepseek-v4-pro");
  });

  const acpError = (message: string, data?: unknown) => new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: message, ...(data === undefined ? {} : { data }) });
  const NOW = Date.parse("2026-11-12T00:00:00Z");

  it("turns the proxy's 429 into t3's usage limit with its reset (review F9)", () => {
    const failure = cliPromptFailure(
      acpError('Internal error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Spend limit for this key is reached; it resets at 2026-11-13T00:00:00Z"}}'),
      NOW,
    );
    expect(failure.class).toBe("usage_limit");
    expect(failure.code).toBe("proxy_spend_limit");
    expect(failure.resetAt).toBe("2026-11-13T00:00:00.000Z");
  });

  it("names the deploy's key when the proxy refuses it, never a sign-in", () => {
    const flat = cliPromptFailure(acpError('Internal error: API Error: 401 {"error":"invalid key"}'), NOW);
    expect(flat.class).toBe("permission_error");
    expect(flat.message).toContain(KEY_NAME);
    const auth = cliPromptFailure(new EffectAcpErrors.AcpRequestError({ code: -32000, errorMessage: "Authentication required" }), NOW);
    expect(auth.class).toBe("permission_error");
    expect(auth.message).toContain(KEY_NAME);
    expect(auth.message).not.toMatch(/sign in to/i);
  });

  it("leaves other errors the provider's", () => {
    expect(cliPromptFailure(acpError("Internal error: API Error: 410 Model gemini-3-flash has been deprecated."), NOW).class).toBe("provider_error");
    expect(cliPromptFailure(new Error("socket hang up"), NOW).class).toBe("provider_error");
  });
});
