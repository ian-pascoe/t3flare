// Patch 0006 (settings-mcp plan D4, SPI-1076): t3's pi extension lets a server tool of pi's built-in MCP client through
// its `tool_call` hook when its server is one the relay serves this process (`T3FLARE_RELAY_SERVERS`, SPI-1199 review),
// since t3flare's MCP relay judges and asks for those; every other tool is asked as before. The
// Patch is applied here as build.ts applies it (`git apply` to a copy of the pinned file), and the extension it yields
// runs against a stand-in for pi's API.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const T3 = path.resolve(here, "../../../t3code");
const PATCH = path.resolve(here, "../../../patches/0006-pi-relay-tools-are-judged-by-the-relay.patch");
const SOURCE = "packages/provider-pi/src/server/mcpExtensionSource.ts";

interface ToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly path?: string; readonly source?: string };
}
type Hook = (event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-patch-0006-"));

/** Replaces `from` exactly once in `text`: a t3 bump that moves it fails here, loudly. */
const replaceOnce = (text: string, from: string, to: string): string => {
  expect(text.split(from).length - 1).toBe(1);
  return text.replace(from, () => to);
};

/** The extension's source as t3's module builds it, from the pinned file with the Patch applied (or without). */
const extensionSource = async (patched: boolean): Promise<string> => {
  if (!patched) return PI_T3_MCP_EXTENSION_SOURCE;
  const dir = path.join(work, "t3");
  fs.mkdirSync(path.join(dir, path.dirname(SOURCE)), { recursive: true });
  fs.copyFileSync(path.join(T3, SOURCE), path.join(dir, SOURCE));
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", PATCH], { cwd: dir, encoding: "utf8" });
  expect(applied.stderr).toBe("");
  expect(applied.status).toBe(0);
  // The copy imports t3's orchestration text by package name, which resolves only inside the repo.
  const module = path.join(dir, SOURCE);
  const text = replaceOnce(
    fs.readFileSync(module, "utf8"),
    '"@t3tools/provider-core/server/orchestrationInstructions"',
    JSON.stringify(path.join(T3, "packages/provider-core/src/server/orchestrationInstructions.ts")),
  );
  fs.writeFileSync(module, text);
  const loaded = (await import(/* @vite-ignore */ module)) as { PI_T3_MCP_EXTENSION_SOURCE: string };
  return loaded.PI_T3_MCP_EXTENSION_SOURCE;
};

/** Loads the extension with pi's packages stubbed out (the hook uses neither) and returns its `tool_call` hook. */
const toolCallHook = async (source: string, name: string, tools: () => ReadonlyArray<ToolInfo> | undefined): Promise<Hook> => {
  let text = replaceOnce(
    source,
    'import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";',
    "const stripFrontmatter = (text: string) => text; type ExtensionAPI = any; type ExtensionContext = any;",
  );
  text = replaceOnce(text, 'import { Type } from "typebox";', "const Type = { Object: () => ({}) };");
  const file = path.join(work, `${name}.ts`);
  fs.writeFileSync(file, text);
  const factory = ((await import(/* @vite-ignore */ file)) as { default: (pi: unknown) => Promise<void> }).default;
  const hooks: Array<Hook> = [];
  const listed = tools();
  await factory({
    on: (event: string, hook: Hook) => {
      if (event === "tool_call") hooks.push(hook);
    },
    registerCommand: () => undefined,
    getCommands: () => [],
    registerTool: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    ...(listed === undefined ? {} : { getAllTools: () => tools() }),
  });
  expect(hooks).toHaveLength(1);
  return hooks[0]!;
};

const RELAY_TOOL = "mcp__settings__change_environment";
const TOOLS: ReadonlyArray<ToolInfo> = [
  { name: RELAY_TOOL, sourceInfo: { path: "builtin:mcp", source: "builtin" } },
  { name: "mcp__commissary__search", sourceInfo: { path: "builtin:mcp" } },
  // A built-in MCP tool of a server the relay does not serve this process (another source added it).
  { name: "mcp__stranger__write", sourceInfo: { path: "builtin:mcp" } },
  // A tool of another extension that takes an MCP-shaped name.
  { name: "mcp__lookalike__write", sourceInfo: { path: "/root/.pi/agent/extensions/other.ts" } },
  { name: "mcp__t3-code__delegate_task", sourceInfo: { path: "/var/lib/t3flare/cli/proc-1/ext/pi-t3-mcp-extension.ts" } },
  // pi's resource tools come from its MCP extension too, but are not a relayed server's tool.
  { name: "read_mcp_resource", sourceInfo: { path: "builtin:mcp" } },
  { name: "bash", sourceInfo: { path: "builtin:bash" } },
  { name: "write", sourceInfo: { path: "builtin:write" } },
];

/** Whether the hook asked (and, the answer being no, blocked) a call of `toolName` in `mode`. */
const asks = async (hook: Hook, mode: string, toolName: string): Promise<boolean> => {
  process.env.T3_PI_RUNTIME_MODE = mode;
  const confirm = vi.fn(async () => false);
  const result = await hook({ type: "tool_call", toolName, toolCallId: "call-1", input: {} }, { ui: { confirm, notify: () => undefined }, signal: undefined });
  expect(result?.block === true).toBe(confirm.mock.calls.length > 0);
  return confirm.mock.calls.length > 0;
};

describe("Patch 0006: pi's relay tools are judged by the relay", () => {
  const saved = { ...process.env };
  let patched: Hook;
  let stock: Hook;
  let noToolList: Hook;
  let noServers: Hook;

  beforeAll(async () => {
    // Without t3's MCP URL the extension registers its hooks and connects nothing.
    delete process.env.T3_MCP_URL;
    delete process.env.T3_MCP_BEARER_TOKEN;
    delete process.env.T3_PI_MCP_EXTENSION_PATH;
    // The profile names the relayed servers (cliProfiles.ts); the extension reads them when it loads.
    process.env.T3FLARE_RELAY_SERVERS = "commissary,settings";
    const source = await extensionSource(true);
    expect(source).not.toBe(PI_T3_MCP_EXTENSION_SOURCE);
    patched = await toolCallHook(source, "patched", () => TOOLS);
    stock = await toolCallHook(await extensionSource(false), "stock", () => TOOLS);
    noToolList = await toolCallHook(source, "no-tool-list", () => undefined);
    // A process the profile named no relayed server for.
    delete process.env.T3FLARE_RELAY_SERVERS;
    noServers = await toolCallHook(source, "no-servers", () => TOOLS);
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("does not ask for a built-in MCP server's tool, which the relay judges, outside full access", async () => {
    for (const mode of ["approval-required", "auto-accept-edits"]) {
      expect(await asks(patched, mode, RELAY_TOOL)).toBe(false);
      expect(await asks(patched, mode, "mcp__commissary__search")).toBe(false);
    }
  });

  it("asks, as stock t3 does, for every tool not from pi's built-in MCP client", async () => {
    for (const mode of ["approval-required", "auto-accept-edits"]) {
      for (const tool of ["mcp__lookalike__write", "mcp__t3-code__delegate_task", "read_mcp_resource", "bash", "mcp__unlisted__call", "mcp__stranger__write"]) {
        expect([mode, tool, await asks(patched, mode, tool)]).toEqual([mode, tool, true]);
        expect([mode, tool, await asks(stock, mode, tool)]).toEqual([mode, tool, true]);
      }
    }
    // Unchanged: auto-accept-edits lets file changes through, and approval-required asks for them.
    expect(await asks(patched, "auto-accept-edits", "write")).toBe(false);
    expect(await asks(patched, "approval-required", "write")).toBe(true);
  });

  it("asks for a built-in MCP tool when pi cannot list its tools' sources", async () => {
    expect(await asks(noToolList, "approval-required", RELAY_TOOL)).toBe(true);
  });

  it("asks for every built-in MCP tool when the profile named no relayed server", async () => {
    expect(await asks(noServers, "approval-required", RELAY_TOOL)).toBe(true);
    expect(await asks(noServers, "approval-required", "mcp__commissary__search")).toBe(true);
  });

  it("is what changes the answer: stock t3 asks for the relay's tool", async () => {
    expect(await asks(stock, "approval-required", RELAY_TOOL)).toBe(true);
  });

  it("asks for nothing in full access, with or without the Patch", async () => {
    expect(await asks(patched, "full-access", "bash")).toBe(false);
    expect(await asks(stock, "full-access", RELAY_TOOL)).toBe(false);
  });
});
