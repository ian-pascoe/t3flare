// T-card's Stop (plan D9), SPI-1199 review: a Stop reaches the Settings server through the production path, not an
// injected signal. A Session's call runs through `sessionMcpCall` (what `EnvironmentDO.mcpCall` runs) under its
// `stopId`, and a CLI's through the relay and `stoppableCall` (what `EnvironmentDO.mcpRelay` wires) under its `askId`;
// `stopCall` is what `EnvironmentDO.cancelAsk` runs when the Session stops the call or the CLI's request goes away. The
// change needs the page, so the owner chose "Opened it" and no card is left open to close: only the stop can withdraw it.
import type { McpRelayInput } from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { sessionMcpCall, stopCall, stoppableCall } from "../src/mcp/callStops.ts";
import { relayMessage } from "../src/mcp/relay.ts";
import { registerCliAsker } from "../src/provider/cli/cliAsk.ts";
import { DURABLE_AGENT } from "../src/provider/threadCaller.ts";
import { settingsFixture, type SettingsFixture, until } from "./settingsFixture.ts";

/** A header add: it takes a secret, so it is answered on the Change page alone and its card offers "Opened it". */
const ADD = { expectedRevision: 0, change: { op: "add", server: "notes", url: "https://notes.example/mcp", auth: { kind: "header", header: "X-Key" } } };

let fixture: SettingsFixture | undefined;
const unregisters: Array<() => void> = [];
afterEach(() => {
  fixture?.dispose();
  for (const unregister of unregisters.splice(0)) unregister();
});

describe("a Stop withdraws the Open change after \"Opened it\" (plan D9)", () => {
  it("a Session's call: its Stop names the call's stopId (cancelAsk), and the Open change closes withdrawn by stop", async () => {
    const f = (fixture = settingsFixture({ answer: { decision: "accept" } }));
    const caller = f.durable("thread-stop");
    const pending = sessionMcpCall(f.host, { server: "settings", tool: "change_mcp", args: ADD, judged: "write", asker: { ask: async (card) => (f.cards.push(card), { decision: "accept" }), withdraw: () => undefined }, thread: caller.thread!, stopId: "session:s1:call-1" }, DURABLE_AGENT);
    await until(() => f.cards.length === 1);
    const [record] = f.deps.changes.open();
    expect(record?.needsPage).toBe("secret");
    // "Opened it" was answered: the call waits for the page, with no card open.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.deps.changes.get(record!.id)?.state).toBe("open");
    stopCall("session:s1:call-1");
    const answer = await pending;
    expect(answer).toMatchObject({ kind: "result", structured: { status: "withdrawn" } });
    expect(f.deps.changes.get(record!.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop" } });
  });

  it("a Session's call of another server is never given the stop", async () => {
    const f = (fixture = settingsFixture());
    const seen: Array<unknown> = [];
    await sessionMcpCall({ call: async (input) => (seen.push(input), { kind: "result", isError: false, text: "ok" }) }, { server: "commissary", tool: "echo", args: {}, thread: "t", stopId: "session:s1:call-2" }, DURABLE_AGENT);
    expect(seen).toEqual([{ server: "commissary", tool: "echo", args: {}, caller: { door: "own", thread: "t", agent: DURABLE_AGENT } }]);
    void f;
  });

  it("a CLI's relayed call: the CLI going away (cancelAsk with its askId) withdraws the Open change", async () => {
    const f = (fixture = settingsFixture({ answer: { decision: "accept" } }));
    unregisters.push(registerCliAsker("thread-cli", { state: () => ({ runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" }), ask: async () => ({ approved: false }) }));
    const input: McpRelayInput = {
      workspace: "ws-1",
      thread: "thread-cli",
      cli: "codex",
      server: "settings",
      askId: "relay-ask-1",
      message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "change_mcp", arguments: ADD } },
    } as McpRelayInput;
    const pending = relayMessage(input, {
      view: () => f.host.view(),
      call: stoppableCall(f.host),
      asker: () => ({ ask: async (card) => (f.cards.push(card), { decision: "accept" }), withdraw: () => undefined }),
      state: () => ({ runtimeMode: "approval-required", interactionMode: "default" }),
      ask: async () => ({ approved: false }),
      accepted: { has: () => false, add: () => undefined },
      log: () => undefined,
    });
    await until(() => f.cards.length === 1);
    const [record] = f.deps.changes.open();
    stopCall("relay-ask-1");
    const answer = await pending;
    expect(JSON.stringify(answer)).toContain("withdrawn");
    expect(f.deps.changes.get(record!.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop" } });
  });
});
