// @effect-diagnostics globalDate:off
// The Settings page's fixture state (SPI-1086): what the page snapshot test renders and `scripts/panel-preview.ts` writes
// for a local look. Four MCP servers in every state the page draws: Commissary (added by hand with its `x-api-key`
// header, SPI-1160) listed with no tools, a direct server listed with tools (one class set by the owner, one tool refused), one whose listing failed, and an OAuth server never
// signed in. Fixed times, so the render is stable.
import { applyChange, applyToolsChange, EMPTY_HARNESS, resolveHarness, type T3ToolListing } from "@t3flare/harness-registry";

import type { WorkspaceRow, WorkspacesView } from "../../src/agents/workspaceView.ts";
import type { McpRow, PageInput } from "../../src/harness/page.ts";
import type { AuditEntry } from "../../src/harness/store.ts";

export const FIXTURE_NOW = Date.UTC(2026, 10, 13, 9, 41);
const minutes = (count: number) => FIXTURE_NOW - count * 60_000;

const budget = applyChange({ ...EMPTY_HARNESS, revision: 4 }, { extension: "codemode", settings: { inlineBudget: 3000 } });
if (!budget.ok) throw new Error(budget.error);
// ask_user hidden (an MCP server asks instead), grep for scripts only, the terminals deferred; one of t3's tools set.
const changed = applyToolsChange(budget.harness, {
  tools: { ask_user: "hidden", grep: "codemode", terminal_start: "deferred", terminal_send: "deferred", terminal_stop: "deferred", terminal_list: "deferred", terminal_wait: "deferred" },
  t3: { tools: { t3_preview_open: "deferred" } },
});
if (!changed.ok) throw new Error(changed.error);

/** t3's tools as a Session listed them: two it asks for in every request, a wait, and a denied one left out. */
export const FIXTURE_T3_TOOLS: T3ToolListing = {
  listedAt: minutes(9),
  tools: [
    { name: "request_secret", description: "Request a secret from the user", readOnly: false, asksForDirect: true },
    { name: "send_to_user", description: "Send a message to the user", readOnly: true, asksForDirect: true },
    { name: "t3_preview_open", description: "Open a preview tab", readOnly: false, asksForDirect: false },
    { name: "t3_thread_read", description: "Read a thread", readOnly: true, asksForDirect: false },
    { name: "t3_thread_wait", description: "Wait for a thread", readOnly: true, asksForDirect: false },
  ],
  left: ["t3_attachment_upload"],
};

const tool = (upstream: string, cls: "read" | "write", hinted: "read" | "write" = cls) => ({ name: `mcp__fixture__${upstream}`, upstream, class: cls, hinted, exposure: "deferred" });

export const FIXTURE_MCP: ReadonlyArray<McpRow> = [
  {
    name: "commissary",
    setting: { kind: "direct", enabled: true, exposure: "deferred", url: "https://api.commissary-fixture.invalid/mcp?toolkits=fixture", auth: { kind: "header", header: "x-api-key" } },
    secret: { set: true, setAt: minutes(60), fingerprint: "51c0" },
    status: "ok",
    listedAt: minutes(12),
    error: null,
    tools: [],
    overrides: {},
    refused: [],
  },
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
  { at: minutes(2), entity: "harness", caller: "owner:7f3c9a", action: "mcp.class", target: "fixture/fixture_echo", after: { classes: { fixture_echo: "write" } } },
  { at: minutes(3), entity: "harness", caller: "service-token", action: "mcp.test", target: "fixture", after: { status: "ok" } },
  { at: minutes(5), entity: "harness", caller: "service-token", action: "mcp.test", target: "docs", after: { status: "failed" } },
  { at: minutes(9), entity: "harness", caller: "owner:7f3c9a", action: "extension.change", target: "codemode", after: { settings: { inlineBudget: 3000 } } },
  { at: minutes(40), entity: "harness", caller: "owner:7f3c9a", action: "mcp.add", target: "docs", after: { kind: "direct", url: "https://mcp.docs-fixture.invalid/mcp", auth: { kind: "header", header: "Authorization" }, secret: { set: true, fingerprint: "232d" } } },
];

const DAY = 24 * 60 * 60_000;

const workspace = (overrides: Partial<WorkspaceRow> & Pick<WorkspaceRow, "id" | "title" | "status">): WorkspaceRow => ({
  kind: "project",
  parent: null,
  branch: null,
  repo: "acme/app",
  createdAt: FIXTURE_NOW - 40 * DAY,
  confirmName: overrides.id.split("/").at(-1)!,
  references: [],
  unreferencedSince: null,
  deletedAt: null,
  lastError: null,
  purgeDue: null,
  planned: { action: "skip", why: "" },
  sessions: 0,
  worktrees: [],
  can: { purge: false, restore: false, stop: true },
  ...overrides,
});

/**
 * The Workspaces section (ADR-0044 §1): a deleted project with a worktree waiting out its Grace and a Tombstone, a project
 * in use, and a Tombstone kept because a removal step could not run.
 */
export const FIXTURE_WORKSPACES: WorkspacesView = {
  purging: true,
  graceDays: 7,
  graceMs: 7 * DAY,
  overridden: false,
  purgingSince: FIXTURE_NOW - 20 * DAY,
  rows: [
    workspace({
      id: "acme",
      title: "Acme",
      status: "unreferenced",
      unreferencedSince: FIXTURE_NOW - 2 * DAY,
      purgeDue: FIXTURE_NOW + 5 * DAY,
      planned: { action: "skip", why: "unreferenced since 2026-11-11T09:41:00.000Z, in its Grace until 2026-11-18T09:41:00.000Z" },
      sessions: 3,
      can: { purge: true, restore: false, stop: true },
      worktrees: [
        workspace({
          id: ".wt/acme/feat-a",
          kind: "worktree",
          parent: "acme",
          branch: "feat-a",
          title: "feat-a",
          status: "unreferenced",
          unreferencedSince: FIXTURE_NOW - 2 * DAY,
          purgeDue: FIXTURE_NOW + 5 * DAY,
          sessions: 1,
          can: { purge: true, restore: false, stop: true },
        }),
        workspace({
          id: ".wt/acme/feat-b",
          kind: "worktree",
          parent: "acme",
          branch: "t3/feat-b",
          title: "t3/feat-b",
          status: "tombstone",
          deletedAt: FIXTURE_NOW - 3 * DAY,
          purgeDue: FIXTURE_NOW + 4 * DAY,
          lastError: "uncommitted work (--force)",
          can: { purge: true, restore: true, stop: false },
        }),
      ],
    }),
    workspace({ id: "live", title: "Live app", repo: "acme/live", status: "in use", references: ["project “Live app”", "thread “Fix the bug”", "2 open terminals"], planned: { action: "skip", why: "project p-live" } }),
    workspace({
      id: ".wt/old/kept",
      kind: "worktree",
      parent: "old",
      branch: "kept",
      title: "kept",
      status: "tombstone (kept)",
      deletedAt: FIXTURE_NOW - 9 * DAY,
      lastError: "the removal could not check the worktree: no Container",
      planned: { action: "skip", why: "tombstone kept (a removal step could not run)" },
      can: { purge: true, restore: true, stop: false },
    }),
  ],
};

export const fixturePage = (overrides: Partial<PageInput> = {}): PageInput => ({
  resolved: resolveHarness(changed.harness),
  csrf: "fixture-csrf-token",
  mcp: FIXTURE_MCP,
  t3Tools: FIXTURE_T3_TOOLS,
  audit: FIXTURE_AUDIT,
  status: {
    "settings revision": changed.harness.revision,
    "last taken by a Session (revision)": 5,
    "last taken by a Session (at)": new Date(minutes(7)).toISOString(),
    Skills: "Repo skills on; 2 Environment skills, 1 enabled, set 3f1c0a9b2e44",
  },
  skills: {
    skills: [
      {
        name: "grill-me",
        description: "Grill the user about a plan until each branch of its design tree is settled.",
        repo: "mattpocock/skills",
        path: "skills/grill-me",
        ref: null,
        commit: "5863806dd4e15c63174bee4e7515a4256792ecfa",
        enabled: true,
        savedAt: minutes(30),
        files: 1,
        bytes: 2_310,
      },
      {
        name: "tdd",
        description: "Test-driven development: red, green, then refactor at agreed seams.",
        repo: "mattpocock/skills",
        path: "skills/tdd",
        ref: "main",
        commit: "5863806dd4e15c63174bee4e7515a4256792ecfa",
        enabled: false,
        savedAt: minutes(12),
        files: 3,
        bytes: 9_840,
      },
    ],
    totals: { count: 2, enabled: 1, disabled: 1, bytes: 12_150, disabledBytes: 9_840, maxBytes: 8_388_608, maxSkills: 100 },
    unauthenticated: false,
  },
  workspaces: FIXTURE_WORKSPACES,
  ...overrides,
});
