// SPI-1060 (plan SPI-1061 §11.1, D8; U49): a Durable agent is never told about a t3 tool it is denied. The denylist
// (`T3_TOOL_DENYLIST`; owner, 2026-11-12, back to stock) names only real t3 tools, so a bump that renames or drops one
// fails here; the prompt and the offered tools' descriptions name no denied tool.
import * as NodeFs from "node:fs";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { TOOL_SEARCH } from "t3/src/mcp/McpToolExposure.ts";
import { beforeAll, describe, expect, it } from "vitest";

import { T3_TOOL_DENYLIST } from "../../agents/src/extensions/t3-guidance.ts";
import { type CatalogTool, catalogOf, t3McpExtension } from "../../agents/src/extensions/t3-mcp.ts";

const TOOLKITS = new URL("../../../t3code/apps/server/src/mcp/toolkits/", import.meta.url);

/**
 * Every tool t3's MCP server defines, as it lists them to a client that does not defer its tools (the Session sends no
 * `t3-tool-exposure: deferred`): name and description, without `tool_search` (t3's `layerDeferredListing`).
 */
let t3Tools: ReadonlyArray<CatalogTool> = [];

beforeAll(async () => {
  const dirs = NodeFs.readdirSync(TOOLKITS).filter((dir) => NodeFs.existsSync(new URL(`${dir}/tools.ts`, TOOLKITS)));
  const modules = await Promise.all(dirs.map((dir) => import(new URL(`${dir}/tools.ts`, TOOLKITS).href) as Promise<Record<string, unknown>>));
  const byName = new Map<string, CatalogTool>();
  for (const exported of modules.flatMap((module) => Object.values(module))) {
    const tools = (exported as { tools?: unknown } | null)?.tools;
    if (tools === null || typeof tools !== "object") continue;
    for (const tool of Object.values(tools as Record<string, { name: string; description?: string }>)) {
      if (typeof tool?.name === "string" && tool.name !== TOOL_SEARCH) byName.set(tool.name, { name: tool.name, description: tool.description });
    }
  }
  t3Tools = [...byName.values()];
}, 120_000);

const isT3Tool = (name: string) =>
  name.endsWith("*") ? t3Tools.some((tool) => tool.name.startsWith(name.slice(0, -1))) : t3Tools.some((tool) => tool.name === name);

describe("the denylist (U49)", () => {
  it("names only t3's tools: each name, and each family's prefix, is still a tool t3 defines", () => {
    expect(t3Tools.length).toBeGreaterThan(40);
    expect([...T3_TOOL_DENYLIST].filter((name) => !isT3Tool(name)), "t3 renamed or dropped these; update packages/harness-registry/src/t3Tools.ts").toEqual([]);
  });

  it("leaves request_secret and t3's orchestration tools offered (D5 lifted)", () => {
    const offered = catalogOf(t3Tools).tools.map((tool) => tool.name);
    expect(offered).toContain("request_secret");
    expect(offered).toContain("delegate_task");
    expect(offered).toContain("t3_environment_links");
    // SPI-1061 (ADR-0029): the link tools are offered again.
    expect(offered).toContain("t3_environment_link");
    expect(offered).toContain("t3_environment_unlink");
  });
});

describe("the Durable agent's prompt and tools (SPI-1060)", () => {
  it("name no denied t3 tool", async () => {
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
    for (const family of ["preview_", "t3_preview_", "html_", "device_", "t3_attachment_", "t3_worktree_"]) {
      expect(texts.filter((text) => new RegExp(`\\b${family}`).test(text))).toEqual([]);
    }
    // What survives is t3's own guidance, its lines on linking included (SPI-1061), and no line of ours.
    expect(prompt).toContain("## T3 Code orchestration");
    expect(prompt).toContain("`delegate_task`");
    expect(prompt).toContain("`t3_environment_links`");
    expect(prompt).toContain("`t3_environment_link`");
    expect(prompt).not.toMatch(/this Environment cannot link to another machine/);
    expect(prompt).not.toContain("### Visuals and preview");
  });
});
