// SPI-1060 (plan SPI-1061 §11.1, D8; U40): a Durable agent is never told about a t3 tool it does not have. Every
// backticked tool-like name in t3's orchestration guidance (as our adapter hands it to the Session) and in the offered
// tools' descriptions is classified: offered (`T3_TOOL_ALLOWLIST`), withheld, or not a tool. A bump whose text names
// something new fails here until it is classified.
import * as NodeFs from "node:fs";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { beforeAll, describe, expect, it } from "vitest";

import { NOT_T3_TOOLS, toolLikeNamesIn, WITHHELD_T3_TOOLS } from "../../agents/src/extensions/t3-guidance.ts";
import { type CatalogTool, catalogOf, t3McpExtension, T3_TOOL_ALLOWLIST } from "../../agents/src/extensions/t3-mcp.ts";

const TOOLKITS = new URL("../../../t3code/apps/server/src/mcp/toolkits/", import.meta.url);

/** Every tool t3's MCP server defines, as it lists them: name and description. */
let t3Tools: ReadonlyArray<CatalogTool> = [];

beforeAll(async () => {
  const dirs = NodeFs.readdirSync(TOOLKITS).filter((dir) => NodeFs.existsSync(new URL(`${dir}/tools.ts`, TOOLKITS)));
  const modules = await Promise.all(dirs.map((dir) => import(new URL(`${dir}/tools.ts`, TOOLKITS).href) as Promise<Record<string, unknown>>));
  const byName = new Map<string, CatalogTool>();
  for (const exported of modules.flatMap((module) => Object.values(module))) {
    const tools = (exported as { tools?: unknown } | null)?.tools;
    if (tools === null || typeof tools !== "object") continue;
    for (const tool of Object.values(tools as Record<string, { name: string; description?: string }>)) {
      if (typeof tool?.name === "string") byName.set(tool.name, { name: tool.name, description: tool.description });
    }
  }
  t3Tools = [...byName.values()];
}, 120_000);

const offeredDescriptions = () => t3Tools.filter((tool) => T3_TOOL_ALLOWLIST.has(tool.name)).map((tool) => tool.description ?? "");
const isT3Tool = (name: string) =>
  name.endsWith("*") ? t3Tools.some((tool) => tool.name.startsWith(name.slice(0, -1))) : t3Tools.some((tool) => tool.name === name);

describe("t3's guidance and tool descriptions, classified (U40)", () => {
  it("finds t3's tools", () => {
    expect(t3Tools.length).toBeGreaterThan(40);
    expect([...T3_TOOL_ALLOWLIST].filter((name) => !isT3Tool(name))).toEqual([]);
  });

  it("classifies every backticked name in the guidance and in the offered tools' descriptions", () => {
    const names = toolLikeNamesIn([T3_CODE_ORCHESTRATION_INSTRUCTIONS, ...offeredDescriptions()].join("\n"));
    const unclassified = names.filter((name) => !T3_TOOL_ALLOWLIST.has(name) && !WITHHELD_T3_TOOLS.has(name) && !NOT_T3_TOOLS.has(name));
    expect(unclassified, "classify these in packages/harness-registry/src/t3Guidance.ts").toEqual([]);
  });

  it("classifies honestly: withheld names are t3 tools not offered, and the rest name no t3 tool", () => {
    expect([...WITHHELD_T3_TOOLS].filter((name) => !isT3Tool(name))).toEqual([]);
    expect([...WITHHELD_T3_TOOLS].filter((name) => [...T3_TOOL_ALLOWLIST].some((offered) => (name.endsWith("*") ? offered.startsWith(name.slice(0, -1)) : offered === name)))).toEqual([]);
    expect([...NOT_T3_TOOLS].filter(isT3Tool)).toEqual([]);
  });
});

describe("the Durable agent's prompt and tools (SPI-1060)", () => {
  it("name no t3 tool outside the offered set", async () => {
    const catalog = catalogOf(t3Tools);
    const extension = t3McpExtension(catalog, {
      store: {} as never,
      mode: () => "approval-required",
      interaction: () => "default",
      turn: () => null,
      credential: () => "provider-session",
      instructions: () => T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      call: () => Promise.reject(new Error("not called")),
    });
    const prompt = (await extension.sections![0]!.render({} as never, {} as never)) as string;
    const texts = [prompt, ...extension.tools!.map((tool) => tool.description)];
    const offered = new Set(catalog.tools.map((tool) => tool.name));
    const notOffered = t3Tools.map((tool) => tool.name).filter((name) => !offered.has(name));
    const named = notOffered.filter((name) => texts.some((text) => new RegExp(`\\b${name}\\b`).test(text)));
    expect(named).toEqual([]);
    for (const family of ["preview_", "html_", "device_", "t3_attachment_", "t3_worktree_"]) {
      expect(texts.filter((text) => new RegExp(`\\b${family}`).test(text))).toEqual([]);
    }
    // What survives is still t3's guidance, with our line on other machines.
    expect(prompt).toContain("## T3 Code orchestration");
    expect(prompt).toContain("`delegate_task`");
    expect(prompt).toContain("`t3_environment_links`");
    expect(prompt).toMatch(/this Environment cannot link to another machine/);
    expect(prompt).not.toContain("### Visuals and preview");
  });
});
