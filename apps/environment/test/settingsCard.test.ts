// @effect-diagnostics globalDate:off
// T-card (plan §5; ADR-0034, plan D6, D9), M4 (SPI-1199): an own agent's asked change on its owner-only card. An
// `approval` card with no field, whose id `refuseOwnerOnly` refuses to an agent; the prompt's server-written parts and
// fixed lines; no Approve on a change that needs the page; the page answering first withdraws the card; a Stop
// withdraws the Open change.
import { applyChange, CARD_TEXT_MAX, EMPTY_HARNESS, MAX_GLOBAL_MISE_BYTES } from "@t3flare/harness-registry";
import { MCP_QUESTION_MARKER, type McpQuestionCard } from "@t3flare/session-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { handleHarness } from "../src/harness/panel.ts";
import { OWNER_ONLY_REFUSAL, refuseOwnerOnly } from "../src/mcp/ownerOnly.ts";
import { CHANGES_API_PATH, changePagePath } from "../src/harness/paths.ts";
import { HINT_TRUST_LINE } from "../src/settings/render.ts";
import { addMcpServer } from "../src/harness/ops.ts";
import { HOST, PANEL, settingsFixture, type SettingsFixture, structured, until } from "./settingsFixture.ts";
import { csrfToken } from "../src/harness/csrf.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());

const open = () => new Promise<never>(() => undefined);
const ASKED = { expectedRevision: 0, settings: { containerBudget: 4 } };

/** The owner's POST from the Change page. */
const pagePost = async (run: SettingsFixture, id: string, body: Record<string, unknown>) => {
  const deps = run.panel();
  const csrf = await csrfToken(run.store.csrfKey(), "owner-sub", run.now());
  return handleHarness(
    new Request(`https://${HOST}${CHANGES_API_PATH}/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "x-t3flare-csrf": csrf },
      body: JSON.stringify(body),
    }),
    deps,
  );
};

describe("the asked change's card", () => {
  it("is an approval card with no field, and an agent's t3_pending_request on its id is refused", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable(), "change_environment", ASKED);
    const [card] = run.cards;
    expect(card).toMatchObject({ kind: "approval", server: "settings", title: "settings: change_environment?" });
    expect(card!.questions).toBeUndefined();
    expect(card!.options).toEqual([
      { decision: "accept", label: "Approve" },
      { decision: "decline", label: "Decline" },
      { decision: "cancel", label: "Cancel" },
    ]);
    expect(card!.id).toContain(MCP_QUESTION_MARKER);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "t3_pending_request", arguments: { action: "respond", requestId: card!.id, answer: "accept" } } });
    expect(refuseOwnerOnly(body)).toContain(OWNER_ONLY_REFUSAL.slice(0, 40));
  });

  it("is written by the server: the change, why, when, who, the page's link, and the agent's call last", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable("thread-x"), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4, variables: { FOO: "bar" } } });
    const prompt = run.cards[0]!.prompt;
    const [record] = run.deps.changes.closedBy("own:thread-x", 0);
    expect(prompt.startsWith("A change to the Environment settings (revision 0):")).toBe(true);
    expect(prompt).toContain("- containerBudget: 3 to 4");
    expect(prompt).toContain('added FOO="bar"');
    expect(prompt).toContain("It waits for the owner because:\n- containerBudget: 3 to 4 (turned up)");
    expect(prompt).toContain("Applies when each Workspace's Container next starts");
    expect(prompt).toContain("Asked by piDurable on thread thread-x.");
    expect(prompt).toContain(`The Change page: https://${HOST}${changePagePath(record!.id)}`);
    expect(prompt.indexOf("The agent's call: settings: change_environment")).toBeGreaterThan(prompt.indexOf("The Change page"));
  });

  it("carries the Guard line when a Guard is turned off, and the hint-trust line for a new server", async () => {
    const guarded = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true });
    if (!guarded.ok) throw new Error(guarded.error);
    fixture = settingsFixture({ harness: guarded.harness, answer: { decision: "decline" } });
    const run = fixture;
    await run.call(run.durable(), "change_extension", { expectedRevision: 1, extension: "guardian", enabled: false });
    expect(run.cards[0]!.prompt).toContain("This turns off the Guardian, which reviews risky tool calls.");
    await run.call(run.durable("thread-2"), "change_mcp", { expectedRevision: 1, change: { op: "add", server: "fixture", url: "https://fixture.example/mcp?key=q", auth: { kind: "none" } } });
    expect(run.cards[1]!.prompt).toContain(HINT_TRUST_LINE);
    // An add shows the whole URL it would store, query included (SPI-1199 review): the owner approves exactly that.
    expect(run.cards[1]!.prompt).toContain("https://fixture.example/mcp?key=q (host fixture.example)");
  });

  for (const [what, setup] of [
    ["a header value", async (run: SettingsFixture) => {
      await addMcpServer(run.deps.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "old" }, { actor: { caller: "owner:o" } });
      return ["change_mcp", { expectedRevision: 1, change: { op: "header-value", server: "keyed" } }] as const;
    }],
    ["a header add", async () => ["change_mcp", { expectedRevision: 0, change: { op: "add", server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" } } }] as const],
    ["a sign-in", async (run: SettingsFixture) => {
      await addMcpServer(run.deps.ops, { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } }, { actor: { caller: "owner:o" } });
      return ["start_mcp_sign_in", { expectedRevision: 1, server: "oauthy" }] as const;
    }],
    ["text too long for a card", async () => ["change_environment", { expectedRevision: 0, settings: { globalMiseConfig: `[tools]\n${"# a comment line of the config, long enough\n".repeat(Math.floor((MAX_GLOBAL_MISE_BYTES - 64) / 44))}` } }] as const],
  ] as const) {
    it(`needs the page for ${what}: no Approve, and "Opened it" only keeps the call waiting`, async () => {
      fixture = settingsFixture({ cardWaitMs: 50 });
      const run = fixture;
      const [tool, args] = await setup(run);
      const revisions = () => run.store.load().revision + run.store.loadEnvironment().revision;
      const before = revisions();
      const answer = await run.call(run.durable(), tool, args as Record<string, unknown>);
      const card = run.cards[0] as McpQuestionCard;
      expect(card.options?.map((option) => option.label)).toEqual(["Opened it", "Decline", "Cancel"]);
      expect(card.prompt).toContain(`${PANEL}/changes/`);
      expect(card.prompt.length).toBeLessThanOrEqual(CARD_TEXT_MAX + 200);
      // The card said "Opened it" (the fixture accepts): nothing applied, and the change expired with no page answer.
      expect(structured(answer)).toMatchObject({ status: "expired" });
      expect(revisions()).toBe(before);
      expect(run.begun).toEqual([]);
    });
  }

  it("the page answering first withdraws the card, and the call answers applied", async () => {
    fixture = settingsFixture({ answer: open });
    const run = fixture;
    const pending = run.call(run.durable(), "change_environment", ASKED);
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    const response = await pagePost(run, record!.id, { action: "approve" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied", revision: 1 });
    const answer = await pending;
    expect(structured(answer)).toMatchObject({ status: "applied", revision: 1, changeId: record!.id });
    expect(answer.kind === "result" ? answer.text : "").toContain("on the Change page");
    expect(run.withdrawn).toEqual([run.cards[0]!.id]);
    expect(run.store.auditLog(1)[0]).toMatchObject({ action: "environment.change", via: "mcp", tier: "asked", mode: "card", answeredBy: "page", change: record!.id, caller: "agent:thread-d" });
  });

  it("a Stop withdraws the Open change and the card", async () => {
    fixture = settingsFixture({ answer: open });
    const run = fixture;
    const stop = new AbortController();
    const pending = run.call(run.durable(), "change_environment", ASKED, { signal: stop.signal });
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    stop.abort();
    expect(structured(await pending)).toMatchObject({ status: "withdrawn" });
    expect(run.deps.changes.get(record!.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop" } });
    expect(run.withdrawn).toEqual([run.cards[0]!.id]);
    // The page then finds it closed.
    expect((await pagePost(run, record!.id, { action: "approve" })).status).toBe(409);
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("the card's decline closes it as declined; its cancel as withdrawn", async () => {
    fixture = settingsFixture({ answer: { decision: "decline" } });
    expect(structured(await fixture.call(fixture.durable(), "change_environment", ASKED))).toMatchObject({ status: "declined" });
    fixture.dispose();
    fixture = settingsFixture({ answer: { decision: "cancel" } });
    expect(structured(await fixture.call(fixture.durable(), "change_environment", ASKED))).toMatchObject({ status: "withdrawn" });
    expect(fixture.store.loadEnvironment().revision).toBe(0);
  });

  it("asks in full access too (plan D7: the tier is what full access does not skip)", async () => {
    fixture = settingsFixture();
    const run = fixture;
    expect(structured(await run.call(run.durable("thread-full", "full-access"), "change_environment", ASKED))).toMatchObject({ status: "applied" });
    expect(run.cards.length).toBe(1);
  });
});
