// The ACP flavors' shared policy (step 4b, plan §5 with review F1, F2, F4, F9): every mode fails closed. Request and
// option shapes are the ones M0's probes recorded from claude-agent-acp 0.106.0 and opencode 2.2.7.
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vitest";

import {
  cliApprovalOptions,
  cliModelId,
  cliPermissionDisposition,
  cliPromptFailure,
  cliRuntimeModeForSessionMode,
  configModeProblem,
  exitPlanMarkdown,
  KEY_NAME,
  modeStateProblem,
} from "../src/provider/cli/acpFlavor.ts";

const CWD = "/w/ws-1";
const policy = (runtimeMode: string, interactionMode: "default" | "plan" = "default") => ({ runtimeMode, interactionMode, cwd: CWD }) as never;
const request = (kind: string | null, paths: ReadonlyArray<string> | null = null, rawInput?: unknown) =>
  ({ toolCall: { toolCallId: "t", kind, locations: paths === null ? null : paths.map((path) => ({ path })), ...(rawInput === undefined ? {} : { rawInput }) } }) as never;

// M0 P1/P4: claude-agent-acp's cards.
const CLAUDE_EDIT_OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
] as const;
const CLAUDE_EXIT_PLAN_OPTIONS = [
  { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
  { optionId: "exit-plan-clear-accept-edits", name: "Yes, clear context and auto-accept edits", kind: "allow_always" },
  { optionId: "exit-plan-accept-edits", name: "Yes, auto-accept edits", kind: "allow_always" },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
] as const;
// M0 P2: opencode's card.
const OPENCODE_OPTIONS = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as const;

describe("permission disposition (the agent asks, t3 decides)", () => {
  it("at approval-required asks for every edit and command, and lets reads through", () => {
    expect(cliPermissionDisposition(policy("approval-required"), request("edit", [`${CWD}/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("execute", [CWD]))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("fetch"))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request(null))).toBe("ask");
    expect(cliPermissionDisposition(policy("approval-required"), request("read", [`${CWD}/a.txt`]))).toBe("allow");
    expect(cliPermissionDisposition(policy("approval-required"), request("search"))).toBe("allow");
  });

  it("at auto-accept-edits allows only edits that name paths inside the cwd (review F2)", () => {
    const mode = policy("auto-accept-edits");
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}/src/a.ts`, "b.ts"]))).toBe("allow");
    expect(cliPermissionDisposition(mode, request("delete", [`${CWD}/old.txt`]))).toBe("allow");
    // Outside the cwd, through `..`, or nowhere named: the owner is asked.
    expect(cliPermissionDisposition(mode, request("edit", ["/etc/claude-code/managed-settings.json"]))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}/../ws-2/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}-evil/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", []))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", null))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("move", [`${CWD}/a.txt`, "/tmp/a.txt"]))).toBe("ask");
    // git's own files and each CLI's project configuration.
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}/.git/hooks/pre-commit`]))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}/.claude/settings.json`]))).toBe("ask");
    expect(cliPermissionDisposition(mode, request("edit", [`${CWD}/pkg/.opencode/opencode.json`]))).toBe("ask");
    // Commands still ask.
    expect(cliPermissionDisposition(mode, request("execute", [CWD]))).toBe("ask");
  });

  it("with no cwd contains nothing", () => {
    expect(cliPermissionDisposition({ runtimeMode: "auto-accept-edits", interactionMode: "default", cwd: null }, request("edit", ["/w/ws-1/a"]))).toBe("ask");
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

  it("runs an unknown or `auto` runtime mode as approval-required", () => {
    expect(cliPermissionDisposition(policy("auto"), request("edit", [`${CWD}/a.txt`]))).toBe("ask");
    expect(cliPermissionDisposition(policy("yolo"), request("execute"))).toBe("ask");
  });
});

describe("the approval card", () => {
  it("offers once and reject, never the agent's always (Claude's rules, OpenCode's saved approvals, ExitPlanMode's auto modes)", () => {
    for (const options of [CLAUDE_EDIT_OPTIONS, CLAUDE_EXIT_PLAN_OPTIONS, OPENCODE_OPTIONS]) {
      expect(cliApprovalOptions({ options } as never).map((option) => option.decision)).toEqual(["cancel", "decline", "accept"]);
    }
  });
});

describe("modes", () => {
  it("places only the pinned and plan modes under a runtime mode", () => {
    expect(cliRuntimeModeForSessionMode("claude")("default")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("claude")("plan")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("claude")("acceptEdits")).toBeUndefined();
    expect(cliRuntimeModeForSessionMode("claude")("bypassPermissions")).toBeUndefined();
    expect(cliRuntimeModeForSessionMode("opencode")("build")).toBe("approval-required");
    expect(cliRuntimeModeForSessionMode("opencode")("sneaky")).toBeUndefined();
  });

  it("trusts Claude's managed modes and refuses auto, bypass, or a session not in default (review F4)", () => {
    const managed = [
      { id: "default", name: "Manual" },
      { id: "acceptEdits", name: "Accept edits" },
      { id: "plan", name: "Plan" },
    ];
    expect(modeStateProblem("claude", { currentModeId: "default", availableModes: managed })).toBeUndefined();
    expect(modeStateProblem("claude", { currentModeId: "auto", availableModes: [...managed, { id: "auto", name: "Auto" }] })).toMatch(/auto/);
    expect(modeStateProblem("claude", { currentModeId: "default", availableModes: [...managed, { id: "bypassPermissions", name: "Bypass" }] })).toMatch(/bypassPermissions/);
    expect(modeStateProblem("claude", { currentModeId: "acceptEdits", availableModes: managed })).toMatch(/acceptEdits/);
    expect(modeStateProblem("claude", undefined)).toBeDefined();
    expect(modeStateProblem("opencode", undefined)).toBeUndefined();
  });

  it("refuses an OpenCode agent we did not pin", () => {
    const mode = (currentValue: string) => [{ id: "mode", name: "Mode", type: "select", currentValue, options: [] }] as never;
    expect(configModeProblem("opencode", mode("build"))).toBeUndefined();
    expect(configModeProblem("opencode", mode("plan"))).toBeUndefined();
    expect(configModeProblem("opencode", mode("sneaky"))).toMatch(/sneaky/);
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
