// @effect-diagnostics globalDate:off globalConsole:off
// Plan §5's hostile list (ADR-0034), M6 (SPI-1202): the cases that can be driven without a stage, end to end through the
// doors as the Environment wires them (the MCP host, the CLI relay, the Owner-client endpoint, the Harness panel). Each
// `describe` names its line of the list; `docs/steps/settings-mcp.md` maps every line to its tests here and elsewhere,
// and `docs/steps/settings-mcp/m6-stage-run.md` to what the stage run records.
import { MCP_QUESTION_MARKER, type McpAsker, type McpQuestionAnswer, type McpQuestionCard } from "@t3flare/session-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { addMcpServer } from "../src/harness/ops.ts";
import { handleHarness } from "../src/harness/panel.ts";
import { changePagePath } from "../src/harness/paths.ts";
import { pauseOf } from "../src/mcp/elicitation.ts";
import { OWNER_ONLY_REFUSAL, refuseOwnerOnly } from "../src/mcp/ownerOnly.ts";
import { relayMessage, type RelayDeps } from "../src/mcp/relay.ts";
import { registerCliAsker } from "../src/provider/cli/cliAsk.ts";
import { DURABLE_AGENT, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import type { OwnCaller } from "../src/settings/caller.ts";
import { OPENED_CAP } from "../src/settings/changes.ts";
import { OPEN_ACROSS, STRIKES } from "../src/settings/openChanges.ts";
import { OFF_MESSAGE, READ_ONLY_REFUSAL } from "../src/settings/server.ts";
import { bodyOf, endpointOf, modern } from "./settingsEndpointFixture.ts";
import { HOST, settingsFixture, type SettingsFixture, structured, textOf, until } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const unregisters: Array<() => void> = [];
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  for (const unregister of unregisters.splice(0)) unregister();
  vi.restoreAllMocks();
});
const world = (options: Parameters<typeof settingsFixture>[0] = {}) => {
  fixture = settingsFixture(options);
  return fixture;
};
const never = () => new Promise<McpQuestionAnswer>(() => undefined);


/** A recording asker standing for one thread's cards (the Session's, or the CLI wrapper's). */
const askerFor = (answer: McpQuestionAnswer | (() => Promise<McpQuestionAnswer>)) => {
  const cards: Array<McpQuestionCard> = [];
  const asker: McpAsker = {
    ask: async (card) => {
      cards.push(card);
      return typeof answer === "function" ? answer() : answer;
    },
    withdraw: () => undefined,
  };
  return { asker, cards };
};

/** The panel's write headers for the owner (Origin, Sec-Fetch-Site, the CSRF token). */
const panelHeaders = async (f: SettingsFixture) => ({
  "content-type": "application/json",
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  "x-t3flare-csrf": await csrfToken(f.store.csrfKey(), "owner-sub", f.now()),
});
const panelPost = async (f: SettingsFixture, path: string, body: unknown) =>
  handleHarness(new Request(`https://${HOST}/_t3flare/harness${path}`, { method: "POST", headers: await panelHeaders(f), body: JSON.stringify(body) }), f.panel());

describe("hostile: an injected agent asking repeatedly is stopped by the caps; 17 children leave the 17th refused", () => {
  it("one thread: a repeat of a declined change is refused, and the third decline in a row locks it out without a card", async () => {
    const f = world({ answer: { decision: "decline" } });
    const agent = f.durable("thread-injected");
    const ask = (settings: Record<string, unknown>) => f.call(agent, "change_environment", { expectedRevision: 0, settings });
    expect(structured(await ask({ containerBudget: 4 }))).toMatchObject({ status: "declined" });
    // The same change again: refused before any card.
    expect(structured(await ask({ containerBudget: 4 }))).toMatchObject({ status: "refused", reason: "declined-repeat" });
    expect(f.cards).toHaveLength(1);
    expect(structured(await ask({ containerBudget: 5 }))).toMatchObject({ status: "declined" });
    expect(structured(await ask({ containerSize: "standard-3" }))).toMatchObject({ status: "declined" });
    expect(f.cards).toHaveLength(STRIKES);
    // Locked: every further asked change is refused with no card; a free change still runs on its own card.
    for (const settings of [{ containerBudget: 6 }, { variables: { INJECTED: "1" } }]) {
      expect(structured(await ask(settings))).toMatchObject({ status: "refused", reason: "strikes" });
    }
    expect(f.cards).toHaveLength(STRIKES);
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it(`SPI-1195 review: 40 asks each dropped by a Stop, or cancelled on the card: past ${OPENED_CAP} in an hour the rest are refused with no card, naming the panel`, async () => {
    const f = world({ answer: never });
    const agent = f.durable("thread-dropper");
    const statuses: Array<Record<string, unknown> | undefined> = [];
    let refusal = "";
    for (let index = 0; index < 40; index++) {
      const stop = new AbortController();
      const before = f.cards.length;
      let settled = false;
      const pending = f.call(agent, "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } }, { signal: stop.signal }).finally(() => (settled = true));
      await until(() => settled || f.cards.length > before);
      stop.abort();
      const answer = await pending;
      statuses.push(structured(answer));
      if (index === OPENED_CAP) refusal = textOf(answer);
    }
    expect(statuses.slice(0, OPENED_CAP).every((status) => status?.status === "withdrawn")).toBe(true);
    expect(statuses.slice(OPENED_CAP).every((status) => status?.status === "refused" && status.reason === "opened-cap")).toBe(true);
    expect(f.cards).toHaveLength(OPENED_CAP);
    expect(refusal).toContain("Harness panel");
    expect(f.store.loadEnvironment().revision).toBe(0);

    // The card's Cancel is no different: each closes withdrawn, and the asks past the cap get no card.
    const g = world({ answer: { decision: "cancel" } });
    const other = g.durable("thread-canceller");
    const cancelled: Array<unknown> = [];
    for (let index = 0; index < OPENED_CAP + 2; index++) cancelled.push(structured(await g.call(other, "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } }))?.status);
    expect(cancelled).toEqual([...Array.from({ length: OPENED_CAP }, () => "withdrawn"), "refused", "refused"]);
    expect(g.cards).toHaveLength(OPENED_CAP);
    f.dispose();
  });

  it(`${OPEN_ACROSS + 1} children asking at once: ${OPEN_ACROSS} wait for the owner, the next is refused naming the panel's list, with no card`, async () => {
    const f = world({ answer: never });
    for (let index = 0; index < OPEN_ACROSS; index++) {
      void f.call(f.durable(`child-${index}`), "change_environment", { expectedRevision: 0, settings: { variables: { [`CHILD_${index}`]: "1" } } });
    }
    await until(() => f.cards.length === OPEN_ACROSS);
    const last = await f.call(f.durable(`child-${OPEN_ACROSS}`), "change_environment", { expectedRevision: 0, settings: { variables: { LAST_CHILD: "1" } } });
    expect(structured(last)).toMatchObject({ status: "refused", reason: "open-across" });
    expect(textOf(last)).toContain("Open changes list");
    expect(textOf(last)).toContain(`https://${HOST}/_t3flare/harness`);
    expect(f.cards).toHaveLength(OPEN_ACROSS);
    expect(f.deps.changes.open()).toHaveLength(OPEN_ACROSS);
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("hostile: a leak scan finds a typed secret nowhere but the secret store", () => {
  it("after a header value is typed on the Change page: no SQLite row, no other kept key, no result, card, log line or audit entry holds it", async () => {
    const SECRET = "hostile-typed-s3cr3t-0042";
    const f = world();
    const lines: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void lines.push(args.map(String).join(" ")));
    await addMcpServer(f.deps.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "old-value" }, { actor: { caller: "owner:o" } });
    const pending = f.call(f.durable(), "change_mcp", { expectedRevision: 1, change: { op: "header-value", server: "keyed" } });
    await until(() => f.cards.length === 1);
    const [open] = f.deps.changes.open();
    const page = await (await handleHarness(new Request(`https://${HOST}${changePagePath(open!.id)}`), f.panel())).text();
    const answered = await panelPost(f, `/api/changes/${open!.id}`, { action: "approve", value: SECRET });
    expect(answered.status).toBe(200);
    const answerText = await answered.text();
    const result = await pending;
    expect(result).toMatchObject({ kind: "result", structured: { status: "applied" } });
    // It is in the secret store, under the secret store's own keys alone.
    expect(f.secrets.read("keyed", "header")).toBe(SECRET);
    const holders = f.kv.entries().filter(([, value]) => JSON.stringify(value).includes(SECRET));
    expect(holders.length).toBeGreaterThan(0);
    for (const [key] of holders) expect(key.startsWith("t3flare/secret/")).toBe(true);
    // Every SQLite table, whole.
    const tables = f.sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain("t3flare_settings_changes");
    for (const { name } of tables) {
      const rows = f.sql.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows), name).not.toContain(SECRET);
    }
    // Everything else the run produced.
    const reads = await Promise.all(
      [
        ["read_audit", { limit: 50 }],
        ["list_mcp_servers", { server: "keyed" }],
        ["get_status", {}],
      ].map(([tool, args]) => f.call(f.durable(), tool as string, args as Record<string, unknown>)),
    );
    for (const text of [page, answerText, JSON.stringify(result), JSON.stringify(reads), JSON.stringify(f.cards), JSON.stringify(f.logs), lines.join("\n"), JSON.stringify(f.store.auditLog(1000))]) {
      expect(text).not.toContain(SECRET);
    }
  });
});

describe("hostile: t3flare's own agents, by Session and by each CLI, see no resume and no Pause from this server", () => {
  const MODES = [
    { runtimeMode: "approval-required", interactionMode: "default" },
    { runtimeMode: "auto-accept-edits", interactionMode: "default" },
    { runtimeMode: "full-access", interactionMode: "default" },
    { runtimeMode: "full-access", interactionMode: "plan" },
  ] as const;
  // Approved, declined, cancelled (as an unanswered card ends), and a change that needs the page (its card "Opened it").
  const ANSWERS: ReadonlyArray<McpQuestionAnswer> = [{ decision: "accept" }, { decision: "decline" }, { decision: "cancel", reason: "no answer in time" }];
  const recordOwner = {};
  const isPause = (answer: unknown) => {
    const text = JSON.stringify(answer);
    return text.includes("approval-required") || text.includes("call resume") || text.includes('"requestId"');
  };

  it("a Durable Session: no resume in the view, resume is no tool, and no write's result in any mode or answer is a Pause", async () => {
    for (const modes of MODES) {
      for (const answer of ANSWERS) {
        // A short card wait: "Opened it" on a change that needs the page keeps the call waiting for the page.
        const f = world({ cardWaitMs: 5 });
        const thread = `thread-${modes.runtimeMode}-${modes.interactionMode}-${answer.decision}`;
        noteDurableModes(thread, modes, recordOwner);
        unregisters.push(() => forgetDurableModes(thread, recordOwner));
        const caller: OwnCaller = { door: "own", thread, agent: DURABLE_AGENT };
        const { asker } = askerFor(answer);
        const view = await f.host.view();
        const tools = view.servers.find((server) => server.name === "settings")!.tools.map((tool) => tool.upstream);
        expect(tools).not.toContain("resume");
        await addMcpServer(f.deps.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "v" }, { actor: { caller: "owner:o" } });
        const results = [
          await f.call(caller, "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } }, { asker }),
          await f.call(caller, "change_environment", { expectedRevision: 0, settings: { containerIdleMinutes: 7 } }, { asker }),
          await f.call(caller, "change_mcp", { expectedRevision: 1, change: { op: "header-value", server: "keyed" } }, { asker }),
          await f.call(caller, "resume", { requestId: "chg_x", response: { action: "accept" } }, { asker }),
        ];
        for (const result of results) {
          expect(isPause(result), JSON.stringify(result)).toBe(false);
          expect(pauseOf({ structuredContent: structured(result) })).toBeUndefined();
        }
        expect(textOf(results[3]!)).toContain("no tool resume");
        f.dispose();
      }
    }
  });

  it.each(["codex", "claudeCode", "opencode", "pi"])("a CLI (%s) through the relay: no resume listed, resume is no tool, and no result in any mode or answer is a Pause", async (cli) => {
    for (const modes of MODES) {
      for (const answer of ANSWERS) {
        // A short card wait: "Opened it" on a change that needs the page keeps the call waiting for the page.
        const f = world({ cardWaitMs: 5 });
        const thread = `cli-${cli}-${modes.runtimeMode}-${modes.interactionMode}-${answer.decision}`;
        unregisters.push(registerCliAsker(thread, { state: () => ({ ...modes, workspace: "ws-1" }), ask: async () => ({ approved: false, reason: "not this card" }) }));
        const { asker } = askerFor(answer);
        const deps: RelayDeps = {
          view: () => f.host.view(),
          call: (input) => f.host.call(input),
          asker: () => asker,
          state: () => modes,
          ask: async () => ({ approved: false, reason: "the relay's own card is never raised for settings" }),
          accepted: { has: () => false, add: () => undefined },
          log: () => undefined,
        };
        await addMcpServer(f.deps.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "v" }, { actor: { caller: "owner:o" } });
        const relay = (message: unknown) => relayMessage({ workspace: "ws-1", thread, cli, server: "settings", message, askId: `ask-${thread}` }, deps);
        const listed = await relay({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const names = ((listed as { body: { result: { tools: Array<{ name: string }> } } }).body.result.tools ?? []).map((tool) => tool.name);
        expect(names).toContain("change_environment");
        expect(names).not.toContain("resume");
        const calls = [
          { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 4 } } },
          { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerIdleMinutes: 7 } } },
          { name: "change_mcp", arguments: { expectedRevision: 1, change: { op: "header-value", server: "keyed" } } },
          { name: "resume", arguments: { requestId: "chg_x", response: { action: "accept" } } },
        ];
        const results: Array<unknown> = [];
        for (const [index, params] of calls.entries()) results.push(await relay({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params }));
        for (const result of results) expect(isPause(result), JSON.stringify(result)).toBe(false);
        expect(JSON.stringify(results[3])).toContain("offers no tool resume");
        f.dispose();
      }
    }
  });
});

describe("hostile: a parent agent cannot answer a child's card", () => {
  it("the child's asked change raises its card on the child's thread alone; the parent's t3_pending_request on it is refused", async () => {
    const f = world();
    const parent = askerFor(never);
    const child = askerFor(never);
    f.durable("thread-parent");
    void f.call(f.durable("thread-child"), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } }, { asker: child.asker });
    await until(() => child.cards.length === 1);
    expect(parent.cards).toEqual([]);
    const [card] = child.cards;
    // An approval card, with no field: t3 lets an agent answer user_input requests only.
    expect(card).toMatchObject({ kind: "approval" });
    expect(card!.questions).toBeUndefined();
    expect(card!.id).toContain(MCP_QUESTION_MARKER);
    // The parent names the child's request as t3 lists it; read and respond are refused before t3 sees them.
    const requestId = `runtime-request:piDurable:thread:thread-child:approval:${card!.id}`;
    for (const args of [
      { action: "respond", requestId, decision: "accept" },
      { action: "respond", requestId, answers: { approve: "yes" } },
      { action: "read", requestId },
    ]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "t3_pending_request", arguments: args } });
      expect(JSON.parse(refuseOwnerOnly(body)!)).toEqual({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: OWNER_ONLY_REFUSAL }], isError: true } });
    }
    expect(f.deps.changes.open()).toHaveLength(1);
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("hostile: turning the access switch off through the server; only the panel turns it back", () => {
  it("off: the next call by any door finds no server, nothing reaches it to turn it on, and the panel does", async () => {
    const f = world();
    const agent = f.durable("thread-off", "full-access");
    // Turning the server's own entry off is asked (plan D5): the owner approves it on the card.
    const off = await f.call(agent, "change_mcp", { expectedRevision: 0, change: { op: "server", server: "settings", enabled: false } });
    expect(structured(off)).toMatchObject({ status: "applied", revision: 1 });
    expect(f.cards).toHaveLength(1);
    // A Session: gone from the view; every call is unavailable naming the panel.
    expect((await f.host.view()).servers.map((server) => server.name)).not.toContain("settings");
    const back = await f.call(agent, "change_mcp", { expectedRevision: 1, change: { op: "server", server: "settings", enabled: true } });
    expect(back).toEqual({ kind: "unavailable", message: OFF_MESSAGE, mayHaveRun: false });
    // A CLI: the relay lists nothing and offers no tool.
    unregisters.push(registerCliAsker("thread-cli", { state: () => ({ runtimeMode: "full-access", interactionMode: "default", workspace: "ws-1" }), ask: async () => ({ approved: true }) }));
    const deps: RelayDeps = {
      view: () => f.host.view(),
      call: (input) => f.host.call(input),
      state: () => ({ runtimeMode: "full-access", interactionMode: "default" }),
      ask: async () => ({ approved: true }),
      accepted: { has: () => false, add: () => undefined },
      log: () => undefined,
    };
    const relay = (message: unknown) => relayMessage({ workspace: "ws-1", thread: "thread-cli", cli: "codex", server: "settings", message, askId: "ask-1" }, deps);
    expect(await relay({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ body: { result: { tools: [] } } });
    const relayed = await relay({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "change_mcp", arguments: { expectedRevision: 1, change: { op: "server", server: "settings", enabled: true } } } });
    expect(relayed).toMatchObject({ body: { result: { isError: true } } });
    // An Owner client: no tools listed, and its call refused naming the panel.
    const endpoint = endpointOf(f);
    expect((await bodyOf(await endpoint(modern("tools/list")))).result?.tools).toEqual([]);
    const owner = await bodyOf(await endpoint(modern("tools/call", { name: "change_mcp", arguments: { expectedRevision: 1, change: { op: "server", server: "settings", enabled: true } } })));
    expect(JSON.stringify(owner)).toContain(OFF_MESSAGE);
    expect(f.store.load().revision).toBe(1);
    expect(f.store.load().mcp?.servers.settings).toMatchObject({ enabled: false });
    // The panel turns it back on, and the next call runs.
    const panel = await panelPost(f, "/api/mcp", { op: "server", server: "settings", enabled: true });
    expect(panel.status).toBe(200);
    expect((await f.host.view()).servers.map((server) => server.name)).toContain("settings");
    expect(structured(await f.call(agent, "get_status"))).toMatchObject({ access: { enabled: true, writes: true } });
  });

  it("read-only: no agent's write turns writes back on, through either door", async () => {
    const f = world();
    const agent = f.durable("thread-ro", "full-access");
    const readOnly = await f.call(agent, "change_mcp", { expectedRevision: 0, change: { op: "server", server: "settings", writes: false } });
    expect(structured(readOnly)).toMatchObject({ status: "applied", revision: 1 });
    const again = await f.call(agent, "change_mcp", { expectedRevision: 1, change: { op: "server", server: "settings", writes: true } });
    expect(textOf(again)).toBe(READ_ONLY_REFUSAL);
    const endpoint = endpointOf(f);
    const owner = await bodyOf(await endpoint(modern("tools/call", { name: "change_mcp", arguments: { expectedRevision: 1, change: { op: "server", server: "settings", writes: true } } })));
    expect(JSON.stringify(owner)).toContain(READ_ONLY_REFUSAL);
    expect(f.store.load().mcp?.servers.settings).toMatchObject({ writes: false });
    expect((await panelPost(f, "/api/mcp", { op: "server", server: "settings", writes: true })).status).toBe(200);
    expect(f.store.load().mcp?.servers.settings).toMatchObject({ writes: true });
  });
});
