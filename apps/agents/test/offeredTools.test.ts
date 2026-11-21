// Each tool's Exposure as the Session applies it (harness-registry's tools.ts): direct, deferred, code mode only or
// hidden, with the fallbacks when tool search or code mode is not installed, and t3's tools by the owner's choice or
// t3's own hint.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { Exposure } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { effectiveExposure, type ExposureRules, offeredToolsExtension, registeredExposure } from "../src/extensions/codemode.ts";
import { asksForDirect, t3ExposureOf } from "../src/extensions/t3-mcp.ts";

const ALL: ExposureRules = { toolSearch: true, codemode: true };

const tool = (name: string, extra: Partial<ToolRegistration> = {}): ToolRegistration =>
  ({ ...(defineTool({ name, description: name, parameters: obj({}), execute: async () => ({ output: [] }) }) as unknown as ToolRegistration), ...extra }) as ToolRegistration;

type ToolWrap = { readonly tool: string; wrap(tool: ToolRegistration): ToolRegistration };
const toolWraps = (chosen: ReadonlyArray<{ name: string; exposure?: Exposure }>, rules: ExposureRules = ALL): ReadonlyArray<ToolWrap> =>
  (offeredToolsExtension(chosen, rules).wraps ?? []).filter((each) => "tool" in each) as unknown as ReadonlyArray<ToolWrap>;

const wrapped = (given: ToolRegistration, exposure: Exposure | undefined, rules: ExposureRules = ALL): ToolRegistration => {
  const wrap = toolWraps([{ name: given.name, ...(exposure === undefined ? {} : { exposure }) }], rules)[0];
  if (wrap === undefined) throw new Error(`${given.name}: not wrapped`);
  return wrap.wrap(given);
};

describe("effectiveExposure", () => {
  it("keeps an Exposure the Session can honour", () => {
    for (const exposure of ["direct", "deferred", "codemode", "hidden"] as const) expect(effectiveExposure(exposure, ALL)).toBe(exposure);
  });

  it("defers a codemode tool without code mode, offers a deferred one direct without tool search, and a direct-only tool direct", () => {
    expect(effectiveExposure("codemode", { toolSearch: true, codemode: false })).toBe("deferred");
    expect(effectiveExposure("codemode", { toolSearch: false, codemode: false })).toBe("direct");
    expect(effectiveExposure("deferred", { toolSearch: false, codemode: true })).toBe("direct");
    expect(effectiveExposure("codemode", ALL, false)).toBe("direct");
    expect(effectiveExposure("hidden", { toolSearch: false, codemode: false })).toBe("hidden");
  });
});

describe("offeredToolsExtension", () => {
  it("wraps each tool to its Exposure: direct, deferred, scripts only, or callable by no one", () => {
    expect(wrapped(tool("read", { deferred: true }), "direct")).not.toHaveProperty("deferred");
    expect(wrapped(tool("read"), "deferred").deferred).toBe(true);
    expect(wrapped(tool("ask_user"), "codemode").callers).toEqual(["tools"]);
    expect(wrapped(tool("bash"), "hidden").callers).toEqual([]);
    for (const exposure of ["direct", "deferred", "codemode", "hidden"] as const) expect(registeredExposure(wrapped(tool("x"), exposure))).toBe(exposure);
  });

  it("keeps an MCP tool's own Exposure, with the fallbacks", () => {
    expect(registeredExposure(wrapped(tool("mcp__x__a", { deferred: true }), undefined))).toBe("deferred");
    expect(registeredExposure(wrapped(tool("mcp__x__a", { deferred: true }), undefined, { toolSearch: false, codemode: true }))).toBe("direct");
    expect(registeredExposure(wrapped(tool("mcp__x__b", { callers: ["tools"] }), undefined, { toolSearch: true, codemode: false }))).toBe("deferred");
  });

  it("keeps a direct-only tool for the model: t3's waits are never code mode only", () => {
    const wait = wrapped(tool("mcp__t3-code__t3_thread_wait", { callers: ["model"] }), "codemode");
    expect(wait.callers).toEqual(["model"]);
    expect(wrapped(tool("mcp__t3-code__t3_thread_wait", { callers: ["model"] }), "deferred")).toMatchObject({ callers: ["model"], deferred: true });
  });

  it("never wraps the tools that are always offered", () => {
    expect(toolWraps([{ name: "codemode" }, { name: "tool_search" }, { name: "propose_plan" }, { name: "read", exposure: "direct" }]).map((each) => each.tool)).toEqual(["read"]);
  });
});

describe("t3's tools", () => {
  const listed = (name: string, alwaysLoad = false) => ({ name, ...(alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}) });

  it("takes the owner's Exposure for a tool, else direct when t3 asks for it, else the card's", () => {
    const t3 = { exposure: "deferred" as const, tools: { send_to_user: "codemode" as const } };
    expect(asksForDirect(listed("request_secret", true))).toBe(true);
    expect(t3ExposureOf(t3, listed("request_secret", true))).toBe("direct");
    expect(t3ExposureOf(t3, listed("send_to_user", true))).toBe("codemode");
    expect(t3ExposureOf(t3, listed("t3_thread_read"))).toBe("deferred");
  });
});
