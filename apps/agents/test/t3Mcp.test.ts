// The `t3-mcp` extension (step 3, plan section 4.3) on a real pi-durable Harness with pi-ai's faux provider, and its
// catalog: the denylist, t3's tool names, the approvals per mode and annotation (accepted per tool name), the replay of a
// call cut off by a Session restart (the same clientRequestId; refused under a credential t3 issued again), a 401 as a
// tool error, plan mode, and waits in 50 s pieces.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { ApprovalStore, PLAN_MODE_REFUSAL } from "../src/extensions/permissions.ts";
import { OTHER_MACHINES } from "../src/extensions/t3-guidance.ts";
import { type CatalogTool, catalogOf, type McpCallAnswer, t3McpExtension, t3ToolName, T3_TOOL_DENYLIST } from "../src/extensions/t3-mcp.ts";
import { context, memoryKv, restartingHarness, textOf, until } from "./harness.fixture.ts";

const schema = (properties: Record<string, unknown>) => ({ type: "object", properties });

const LISTED: ReadonlyArray<CatalogTool> = [
  { name: "t3_thread_read", inputSchema: schema({ threadId: { type: "string" } }), annotations: { readOnlyHint: true } },
  { name: "delegate_task", inputSchema: schema({ task: { type: "string" }, clientRequestId: { type: "string" } }), annotations: { readOnlyHint: false } },
  { name: "t3_thread_update", inputSchema: schema({ threadId: { type: "string" }, action: { type: "string" } }), annotations: { readOnlyHint: false } },
  { name: "t3_thread_wait", inputSchema: schema({ threadId: { type: "string" }, timeoutMs: { type: "number" } }), annotations: { readOnlyHint: true } },
  { name: "request_secret", inputSchema: schema({}), annotations: { readOnlyHint: false } },
  { name: "preview_open", inputSchema: schema({}), annotations: { readOnlyHint: false } },
  { name: "t3_environment_link", inputSchema: schema({}), annotations: { readOnlyHint: false } },
];

const call = (tool: string, args: Record<string, unknown>, id = "call-1"): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(t3ToolName(tool), args as never, { id })], { stopReason: "toolUse" });

interface Setup {
  mode?: RuntimeMode;
  interaction?: InteractionMode;
  /** Answers each call; a never-settling promise holds it (a restart cuts it off). */
  answer?: (tool: string, args: Readonly<Record<string, unknown>>, nth: number) => Promise<McpCallAnswer>;
}

const setup = (options: Setup = {}) => {
  const kv = memoryKv();
  const store = new ApprovalStore(kv, () => {});
  const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
  let credential: string | undefined = "provider-session-1";
  const extension = () =>
    t3McpExtension(catalogOf(LISTED), {
      store,
      mode: () => options.mode ?? "approval-required",
      interaction: () => options.interaction ?? "default",
      turn: () => "turn-1",
      credential: () => credential,
      instructions: () => "## T3 Code orchestration",
      call: (tool, args) => {
        calls.push({ tool, args });
        return options.answer?.(tool, args, calls.length) ?? Promise.resolve({ kind: "result", text: `{"ok":"${tool}"}`, isError: false });
      },
    });
  return {
    store,
    calls,
    extension,
    reissue: () => {
      credential = "provider-session-2";
    },
  };
};

describe("t3-mcp catalog", () => {
  it("offers every listed tool but the denied ones under t3's names, and reports what it left out", () => {
    const catalog = catalogOf([...LISTED, { name: "t3_brand_new_tool" }, { name: "t3_attachment_prepare_upload" }, { name: "t3_worktree_handoff" }]);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["delegate_task", "request_secret", "t3_brand_new_tool", "t3_thread_read", "t3_thread_update", "t3_thread_wait"]);
    expect(catalog.left).toEqual(["preview_open", "t3_attachment_prepare_upload", "t3_environment_link", "t3_worktree_handoff"]);
    expect(t3ToolName("delegate_task")).toBe("mcp__t3-code__delegate_task");
    const extension = setup().extension();
    expect(extension.tools?.map((tool) => tool.name)).toContain("mcp__t3-code__t3_thread_read");
    // D5 lifted (owner, 2026-11-12, back to stock): an agent may ask the owner for a secret.
    expect(T3_TOOL_DENYLIST.has("request_secret")).toBe(false);
  });

  it("changes its hash when t3's catalog changes, and only then", () => {
    const first = catalogOf(LISTED);
    expect(catalogOf([...LISTED].reverse()).hash).toBe(first.hash);
    expect(catalogOf(LISTED.map((tool) => (tool.name === "delegate_task" ? { ...tool, description: "new" } : tool))).hash).not.toBe(first.hash);
    expect(catalogOf([...LISTED, { name: "html_render" }]).hash).toBe(first.hash);
  });
});

describe("t3-mcp tools", () => {
  it("a read-only tool runs without asking in approval-required", async () => {
    const host = setup();
    const harness = await restartingHarness([host.extension()], [call("t3_thread_read", { threadId: "a" }), fauxAssistantMessage("ok")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(textOf(await harness.lastToolResult())).toBe('{"ok":"t3_thread_read"}');
    expect(host.calls).toEqual([{ tool: "t3_thread_read", args: { threadId: "a" } }]);
  });

  it("a tool that changes state asks as an MCP tool by name, and sends its task's clientRequestId once accepted", async () => {
    const host = setup();
    const harness = await restartingHarness([host.extension()], [call("delegate_task", { task: "x" }), fauxAssistantMessage("ok")]);
    await until(() => host.store.pending().length === 1, "the request");
    const request = host.store.pending()[0]!;
    expect(request.kind).toBe("mcp-tool");
    expect(request.tool).toBe("mcp__t3-code__delegate_task");
    expect(host.calls).toEqual([]);
    host.store.answer(request.requestId, "acceptForSession");
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(host.calls[0]!.args.clientRequestId).toMatch(/^pi-durable:/);
    expect(host.store.acceptedFor({ tool: "mcp__t3-code__delegate_task", kind: "mcp-tool" })).toBe(true);
    expect(host.store.acceptedFor({ tool: "mcp__t3-code__t3_thread_update", kind: "mcp-tool" })).toBe(false);
  });

  it("nothing asks in full access", async () => {
    const host = setup({ mode: "full-access" });
    const harness = await restartingHarness([host.extension()], [call("t3_thread_update", { threadId: "a", action: "rename" }), fauxAssistantMessage("ok")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(host.calls.length).toBe(1);
  });

  it("in plan mode a tool that changes state is refused and a read-only one runs", async () => {
    const refused = setup({ mode: "full-access", interaction: "plan" });
    const first = await restartingHarness([refused.extension()], [call("t3_thread_update", { threadId: "a", action: "rename" }), fauxAssistantMessage("ok")]);
    await until(async () => (await first.lastToolResult()) !== undefined, "the refusal");
    expect(textOf(await first.lastToolResult())).toBe(PLAN_MODE_REFUSAL);
    expect(refused.calls).toEqual([]);
    expect(refused.store.pending()).toEqual([]);
    const read = setup({ mode: "full-access", interaction: "plan" });
    const second = await restartingHarness([read.extension()], [call("t3_thread_read", { threadId: "a" }), fauxAssistantMessage("ok")]);
    await until(async () => (await second.lastToolResult()) !== undefined, "the read");
    expect(read.calls.map((c) => c.tool)).toEqual(["t3_thread_read"]);
  });

  it("a keyed call cut off by a Session restart runs again with the same clientRequestId", async () => {
    const host = setup({ mode: "full-access", answer: (_tool, _args, nth) => (nth === 1 ? new Promise(() => {}) : Promise.resolve({ kind: "result", text: "{}", isError: false })) });
    const harness = await restartingHarness([host.extension()], [call("delegate_task", { task: "x" }), fauxAssistantMessage("ok")]);
    await until(() => host.calls.length === 1, "the first call");
    await harness.restart();
    await until(() => host.calls.length === 2, "the rerun");
    expect(host.calls[1]!.args.clientRequestId).toBe(host.calls[0]!.args.clientRequestId);
  });

  it("a call cut off and rerun under a credential t3 issued again is refused, not repeated (review C9)", async () => {
    const host = setup({ mode: "full-access", answer: () => new Promise(() => {}) });
    const harness = await restartingHarness([host.extension()], [call("delegate_task", { task: "x" }), fauxAssistantMessage("ok")]);
    await until(() => host.calls.length === 1, "the first call");
    host.reissue();
    await harness.restart();
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(textOf(await harness.lastToolResult())).toContain("cut off by a restart");
    expect(host.calls.length).toBe(1);
  });

  it("an unkeyed call that changes state is not run again after it started", async () => {
    const host = setup({ mode: "full-access", answer: () => new Promise(() => {}) });
    const harness = await restartingHarness([host.extension()], [call("t3_thread_update", { threadId: "a", action: "rename" }), fauxAssistantMessage("ok")]);
    await until(() => host.calls.length === 1, "the first call");
    await harness.restart();
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(textOf(await harness.lastToolResult())).toContain("cut off by a restart");
    expect(host.calls.length).toBe(1);
  });

  it("t3's tools unavailable (a 401) is a tool error the model sees", async () => {
    const host = setup({ mode: "full-access", answer: () => Promise.resolve({ kind: "unavailable", message: "T3's tools are unavailable until the next turn." }) });
    const harness = await restartingHarness([host.extension()], [call("t3_thread_read", { threadId: "a" }), fauxAssistantMessage("ok")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    const result = await harness.lastToolResult();
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("unavailable until the next turn");
  });

  it("a wait goes to t3 in pieces of at most 50 s until it is not a timeout", async () => {
    const host = setup({
      answer: (_tool, _args, nth) => Promise.resolve({ kind: "result", text: nth < 3 ? '{"timedOut":true}' : '{"status":"completed","timedOut":false}', isError: false }),
    });
    const harness = await restartingHarness([host.extension()], [call("t3_thread_wait", { threadId: "a", timeoutMs: 600_000 }), fauxAssistantMessage("ok")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(host.calls.length).toBe(3);
    expect(host.calls.every((c) => typeof c.args.timeoutMs === "number" && c.args.timeoutMs <= 50_000)).toBe(true);
    expect(textOf(await harness.lastToolResult())).toContain("completed");
  });

  it("t3's orchestration instructions are a prompt section while the tools are installed", async () => {
    const section = setup().extension().sections![0]!;
    expect(await section.render({} as never, context)).toBe(`## T3 Code orchestration\n\n${OTHER_MACHINES}`);
  });
});

describe("t3-mcp guidance (SPI-1060)", () => {
  const GUIDANCE = [
    "## T3 Code orchestration",
    "",
    "Ordinary coding tasks need no T3 tools.",
    "",
    "- Call `delegate_task` with a `task`.",
    "- Another machine: call `t3_environment_link` with a `hint`.",
    "- A secret: call `request_secret`,",
    "  never a chat ask.",
    "- Given a thread id, `t3_thread_read` it.",
    "",
    "### Visuals and preview",
    "",
    "- Show it with `html_preview`, then `html_render`.",
    "- Never use `preview_*` unasked.",
  ].join("\n");

  const render = (instructions: string, listed: ReadonlyArray<CatalogTool> = LISTED) =>
    t3McpExtension(catalogOf(listed), {
      store: new ApprovalStore(memoryKv(), () => {}),
      mode: () => "approval-required",
      interaction: () => "default",
      turn: () => null,
      credential: () => "provider-session-1",
      instructions: () => instructions,
      call: () => Promise.resolve({ kind: "result", text: "{}", isError: false }),
    });

  it("drops each bullet naming a denied tool, and a heading left with none, then adds our line", async () => {
    const text = await render(GUIDANCE).sections![0]!.render({} as never, context);
    expect(text).toBe(
      [
        "## T3 Code orchestration",
        "",
        "Ordinary coding tasks need no T3 tools.",
        "",
        "- Call `delegate_task` with a `task`.",
        "- A secret: call `request_secret`,",
        "  never a chat ask.",
        "- Given a thread id, `t3_thread_read` it.",
        "",
        OTHER_MACHINES,
      ].join("\n"),
    );
  });

  it("keeps a bullet naming a tool it does not know: t3's own guidance, as stock t3 gives it", async () => {
    const text = await render("- Call `delegate_task`.\n- Call `t3_brand_new_tool`.").sections![0]!.render({} as never, context);
    expect(text).toBe(`- Call \`delegate_task\`.\n- Call \`t3_brand_new_tool\`.\n\n${OTHER_MACHINES}`);
  });

  it("drops each sentence of an offered tool's description that names a denied tool", () => {
    const listed: ReadonlyArray<CatalogTool> = [
      {
        name: "t3_environment_links",
        description:
          "List linked environments and whether each answers now. Pass one's `environmentId` to a tool; `delegate_task` takes it. Expired: link it again with `t3_environment_link`.",
        annotations: { readOnlyHint: true },
      },
      ...LISTED,
    ];
    const tool = render("", listed).tools!.find((each) => each.name === t3ToolName("t3_environment_links"))!;
    expect(tool.description).toBe("List linked environments and whether each answers now. Pass one's `environmentId` to a tool; `delegate_task` takes it.");
  });
});
