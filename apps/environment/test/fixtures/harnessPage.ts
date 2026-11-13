// @effect-diagnostics globalDate:off
// The harness panel's fixture state (SPI-1086): what the page snapshot test renders and `scripts/panel-preview.ts` writes
// for a local look. Four MCP servers in every state the page draws: Commissary listed with no tools, a direct server
// listed with tools (one class set by the owner, one tool refused), one whose listing failed, and an OAuth server never
// signed in. Fixed times, so the render is stable.
import { applyChange, EMPTY_HARNESS, resolveHarness } from "@t3flare/harness-registry";

import type { McpRow, PageInput } from "../../src/harness/page.ts";
import type { AuditEntry } from "../../src/harness/store.ts";

export const FIXTURE_NOW = Date.UTC(2026, 10, 13, 9, 41);
const minutes = (count: number) => FIXTURE_NOW - count * 60_000;

const changed = applyChange({ ...EMPTY_HARNESS, revision: 5 }, { extension: "codemode", settings: { inlineBudget: 3000 } });
if (!changed.ok) throw new Error(changed.error);

const tool = (upstream: string, cls: "read" | "write", hinted: "read" | "write" = cls) => ({ name: `mcp__fixture__${upstream}`, upstream, class: cls, hinted, exposure: "deferred" });

export const FIXTURE_MCP: ReadonlyArray<McpRow> = [
  { name: "commissary", setting: { kind: "commissary", enabled: true, exposure: "deferred" }, status: "ok", listedAt: minutes(12), error: null, tools: [], overrides: {}, refused: [] },
  {
    name: "fixture",
    setting: { kind: "direct", enabled: true, exposure: "deferred", url: "https://t3flare-mcpfixture-panel.example.workers.dev/mcp", auth: { kind: "header", header: "Authorization" } },
    secret: { set: true, setAt: minutes(30), fingerprint: "9e2b" },
    status: "ok",
    listedAt: minutes(3),
    error: null,
    tools: [tool("fixture_echo", "write", "read"), { ...tool("fixture_note", "write"), exposure: "hidden" }, tool("fixture_inject", "read"), tool("fixture_slow", "read"), tool("fixture_ask", "write"), tool("fixture_page", "read")],
    overrides: { fixture_echo: "write" },
    toolExposure: { fixture_note: "hidden" },
    refused: [{ tool: "fixture.flip", reason: "its name collides with fixture_flip as mcp__fixture__fixture_flip" }],
  },
  {
    name: "docs",
    setting: { kind: "direct", enabled: true, exposure: "deferred", url: "https://mcp.docs-fixture.invalid/mcp", auth: { kind: "header", header: "Authorization" } },
    secret: { set: true, setAt: minutes(40), fingerprint: "232d" },
    status: "failed",
    listedAt: null,
    error: "Unreachable: The server is unavailable (HTTP 530)",
    tools: [],
    overrides: {},
    refused: [],
  },
  { name: "linear", setting: { kind: "direct", enabled: true, exposure: "deferred", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth" } }, oauth: { signedIn: false }, status: "never", listedAt: null, error: null, tools: [], overrides: {}, refused: [] },
];

export const FIXTURE_AUDIT: ReadonlyArray<AuditEntry> = [
  { at: minutes(2), caller: "owner:7f3c9a", action: "mcp.class", target: "fixture/fixture_echo", after: { classes: { fixture_echo: "write" } } },
  { at: minutes(3), caller: "service-token", action: "mcp.test", target: "fixture", after: { status: "ok" } },
  { at: minutes(5), caller: "service-token", action: "mcp.test", target: "docs", after: { status: "failed" } },
  { at: minutes(9), caller: "owner:7f3c9a", action: "extension.change", target: "codemode", after: { settings: { inlineBudget: 3000 } } },
  { at: minutes(40), caller: "owner:7f3c9a", action: "mcp.add", target: "docs", after: { kind: "direct", url: "https://mcp.docs-fixture.invalid/mcp", auth: { kind: "header", header: "Authorization" }, secret: { set: true, fingerprint: "232d" } } },
];

export const fixturePage = (overrides: Partial<PageInput> = {}): PageInput => ({
  resolved: resolveHarness(changed.harness),
  csrf: "fixture-csrf-token",
  mcp: FIXTURE_MCP,
  audit: FIXTURE_AUDIT,
  status: {
    "settings revision": changed.harness.revision,
    "last taken by a Session (revision)": 5,
    "last taken by a Session (at)": new Date(minutes(7)).toISOString(),
    Skills: "deferred (SPI-1001)",
  },
  ...overrides,
});
