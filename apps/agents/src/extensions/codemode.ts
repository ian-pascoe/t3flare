// Code mode and tool search for the Durable agent (ADR-0027; plan §2.1-§2.2): pi-durable's `codemode` tool, whose
// scripts call the Session's tools as nested calls, over pi-codemode's QuickJS VM in the codemode sandbox Worker (one
// object per Session), and pi-durable's `tool_search` with the offered-tools rule ported from cloudpid
// (`packages/extensions/src/tool-search.ts`): a tool the harness settings do not offer is deferred by a wrap, so a
// later extension's tools need no naming.
//
// No rule lives here: every guard is in the tools (the `permissions` wraps, t3-mcp's own check), and pi-durable runs a
// script's nested call through the registered, wrapped tool, so a call from a script is judged exactly as a direct one.
// @effect-diagnostics preferEffectArray:off
import { type CodemodeRemote, type CodemodeSandboxBase, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineExtension, type Extension, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CodemodeNamespace, CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";

/** The sandbox Durable Object namespace, as the agents Worker binds it from the codemode Worker (`scriptName`). */
export interface CodemodeSandboxNamespace {
  getByName(name: string): CodemodeRemote;
}

/** A sandbox that runs each of a Session's scripts on the Session's own object (`name`), never another Session's. */
export const remoteSandbox = (namespace: CodemodeSandboxNamespace, name: string): CodemodeSandboxBase =>
  new RemoteCodemodeSandbox({ remote: () => namespace.getByName(name) });

/** t3's own tools as a code mode namespace (`tools.mcp__t3_code__…` in a script). */
export const T3_NAMESPACE: CodemodeNamespace = {
  name: "t3",
  description: "T3 Code: threads, tasks, projects, pull requests",
  prefix: "mcp__t3-code__",
};

/** What the model is told about scripts beyond pi-durable's own description (plan §2.4, review M6). */
export const CODEMODE_RULES = [
  "A script's tool calls ask for approval exactly as direct calls do; an approval card raised inside a script names the script.",
  "Do not set `timeout_ms` on a script that changes files or runs commands: a deadline that passes while the owner decides ends the script.",
  "If the sandbox that runs a script is lost (a deploy or a reset), the script ends with an error listing the calls it completed; check the state before running it again.",
  "Use scripts for fan-out and reduction (many reads, searches, or tool calls whose results you combine); edit files and run commands directly.",
].join("\n");

/** The `codemode` extension over `sandbox`, with the tool-source `namespaces` and the settings' inline budget. */
export const codemodeExtension = (sandbox: CodemodeSandboxBase, options: { readonly inlineBudget: number; readonly namespaces?: ReadonlyArray<CodemodeNamespace> }): Extension => {
  const base = createCodemodeExtension({
    sandbox,
    namespaces: [T3_NAMESPACE, ...(options.namespaces ?? [])],
    inlineBudget: options.inlineBudget,
    // No `models.*` in scripts: a classifier or image call would be a model request outside a turn's usage-limit
    // handling (ADR-0012), and the proxy serves chat models only.
    models: false,
  });
  return { ...base, sections: [...(base.sections ?? []), section("codemode_rules", () => CODEMODE_RULES)] };
};

/** The tools no setting defers: `tool_search` is the way to every other deferred tool, and code mode reaches them all. */
export const ALWAYS_OFFERED: ReadonlyArray<string> = [TOOL_SEARCH_TOOL_NAME, CODEMODE_TOOL_NAME];

/** Whether `name` matches `pattern`, where `*` matches any run of characters. */
export const matchesToolPattern = (pattern: string, name: string): boolean => {
  if (!pattern.includes("*")) return pattern === name;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(name);
};

/** Whether the settings offer tool `name` without a search. */
export const isOffered = (offered: ReadonlyArray<string>, name: string): boolean =>
  ALWAYS_OFFERED.includes(name) || offered.some((pattern) => matchesToolPattern(pattern, name));

const withDeferral = (tool: ToolRegistration, defer: boolean): ToolRegistration => {
  if (defer) return tool.deferred === true ? tool : { ...tool, deferred: true };
  if (tool.deferred === undefined) return tool;
  const { deferred: _deferred, ...offered } = tool;
  return offered;
};

/** What the model is told about deferred tools: their names, whether loaded or not, so the text changes only with them. */
const deferredTools = section("deferred_tools", (input) => {
  if (!input.agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME)) return undefined;
  const names = [...new Set([...input.agent.tools, ...input.agent.deferred].filter((tool) => tool.deferred === true).map((tool) => tool.name))].sort();
  if (names.length === 0) return undefined;
  return `Tools the settings defer: each is offered once you load it with \`${TOOL_SEARCH_TOOL_NAME}\` (code mode scripts call them without loading): ${names.join(", ")}.`;
});

/**
 * `tool_search`, and the deferral of the tools named `toolNames` (those of every other extension) that `offered` does
 * not offer. Wraps are pure: install a new one over this (same name) when the settings or the tools change.
 */
export const toolSearchExtension = (toolNames: ReadonlyArray<string>, offered: ReadonlyArray<string>): Extension =>
  defineExtension({
    name: "tool-search",
    tools: [createToolSearchTool()],
    sections: [deferredTools],
    wraps: [...new Set(toolNames)]
      .filter((name) => !ALWAYS_OFFERED.includes(name))
      .map((name) => ({ tool: name, wrap: (tool: ToolRegistration) => withDeferral(tool, !isOffered(offered, name)) })),
  });
