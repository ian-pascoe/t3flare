// Code mode and tool search for the Durable agent (ADR-0027; plan §2.1-§2.2): pi-durable's `codemode` tool, whose
// scripts call the Session's tools as nested calls, over pi-codemode's QuickJS VM in the codemode sandbox Worker (one
// object per Session), pi-durable's `tool_search`, and each tool's Exposure (harness-registry's tools.ts), set by a wrap:
// direct, deferred (loaded by `tool_search`), code mode only, or hidden (callable by no one).
//
// No rule lives here: every guard is in the tools (the `permissions` wraps, t3-mcp's own check), and pi-durable runs a
// script's nested call through the registered, wrapped tool, so a call from a script is judged exactly as a direct one.
// @effect-diagnostics preferEffectArray:off
import { type CodemodeRemote, type CodemodeSandboxBase, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineExtension, type Extension, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CodemodeNamespace, CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import type { Exposure } from "@t3flare/harness-registry";
import { PROPOSE_PLAN_TOOL } from "@t3flare/session-protocol";

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
    // handling (ADR-0034 §8).
    models: false,
  });
  return { ...base, sections: [...(base.sections ?? []), section("codemode_rules", () => CODEMODE_RULES)] };
};

/**
 * The tools no setting defers: `tool_search` is the way to every other deferred tool, and code mode reaches them all;
 * `propose_plan` (SPI-996) ends a plan-mode turn and scripts cannot call it.
 */
export const ALWAYS_OFFERED: ReadonlyArray<string> = [TOOL_SEARCH_TOOL_NAME, CODEMODE_TOOL_NAME, PROPOSE_PLAN_TOOL];

/** What the Session has installed, which decides what an Exposure can mean. */
export interface ExposureRules {
  /** Whether `tool_search` is installed: without it a deferred tool could never load, so it is direct. */
  readonly toolSearch: boolean;
  /** Whether code mode is installed: without it a `codemode` tool could never run, so it is deferred. */
  readonly codemode: boolean;
}

/** The Exposure a tool's registration gives it (an MCP tool's, set by its server's settings). */
export const registeredExposure = (tool: Pick<ToolRegistration, "callers" | "deferred">): Exposure => {
  if (tool.callers !== undefined && tool.callers.length === 0) return "hidden";
  if (tool.callers !== undefined && !tool.callers.includes("model")) return "codemode";
  return tool.deferred === true ? "deferred" : "direct";
};

/**
 * The Exposure a tool gets under `rules`: `codemode` needs code mode (else deferred) and a tool scripts may call (a
 * direct-only one, such as t3's waits, is direct); `deferred` needs tool search (else direct).
 */
export const effectiveExposure = (exposure: Exposure, rules: ExposureRules, scriptable = true): Exposure => {
  const runnable = exposure === "codemode" && !scriptable ? "direct" : exposure === "codemode" && !rules.codemode ? "deferred" : exposure;
  return runnable === "deferred" && !rules.toolSearch ? "direct" : runnable;
};

/** Whether scripts may call the tool: its registration does not keep it for the model alone. */
const scriptable = (tool: ToolRegistration): boolean => tool.callers === undefined || tool.callers.length !== 1 || tool.callers[0] !== "model";

const withExposure = (tool: ToolRegistration, exposure: Exposure): ToolRegistration => {
  const { deferred: _deferred, callers, ...rest } = tool;
  // A tool its registration kept from the model (code mode only, or hidden) is offered to it again with no callers.
  const offered = callers === undefined || !callers.includes("model") ? rest : { ...rest, callers };
  switch (exposure) {
    case "hidden":
      return { ...rest, callers: [] };
    case "codemode":
      return { ...rest, callers: ["tools"] };
    case "deferred":
      return { ...offered, deferred: true };
    case "direct":
      return offered;
  }
};

/** What the model is told about deferred tools: their names, whether loaded or not, so the text changes only with them. */
const deferredTools = section("deferred_tools", (input) => {
  if (!input.agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME)) return undefined;
  const names = [...new Set([...input.agent.tools, ...input.agent.deferred].filter((tool) => tool.deferred === true).map((tool) => tool.name))].sort();
  if (names.length === 0) return undefined;
  return `Tools the settings defer: each is offered once you load it with \`${TOOL_SEARCH_TOOL_NAME}\` (code mode scripts call them without loading): ${names.join(", ")}.`;
});

/** `tool_search` and what the model is told about the deferred tools. */
export const toolSearchExtension = (): Extension =>
  defineExtension({
    name: "tool-search",
    tools: [createToolSearchTool()],
    sections: [deferredTools],
  });

/**
 * Each tool's Exposure: `chosen` names the tools and the Exposure the settings give them, or none for a tool whose
 * registration has its own (an MCP server's); either way under `rules`. `tool_search`, `codemode` and `propose_plan` are
 * never wrapped. Wraps are pure: install a new one over this (same name) when the settings or the tools change.
 */
export const offeredToolsExtension = (chosen: ReadonlyArray<{ readonly name: string; readonly exposure?: Exposure }>, rules: ExposureRules): Extension =>
  defineExtension({
    name: "offered-tools",
    wraps: [...new Map(chosen.map((tool) => [tool.name, tool.exposure])).entries()]
      .filter(([name]) => !ALWAYS_OFFERED.includes(name))
      .map(([name, exposure]) => ({
        tool: name,
        wrap: (tool: ToolRegistration) => withExposure(tool, effectiveExposure(exposure ?? registeredExposure(tool), rules, scriptable(tool))),
      })),
  });
