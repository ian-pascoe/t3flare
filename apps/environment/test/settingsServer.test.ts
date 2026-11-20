// @effect-diagnostics globalDate:off
// T-own (plan §5; ADR-0035, plan D2, D7, D14, D16, D17), M3 (SPI-1198): the Settings server for t3flare's own agents,
// through the MCP host as the Environment wires it. D7's mode table, every cell, for a Durable caller (modes from the
// adapter's record) and a relayed CLI caller (modes from its live session); the access switch; no `resume` and no Pause;
// reads that carry no secret value, fingerprint, URL query or authorization URL; the applied cap. Since M4 (SPI-1199) an
// asked change asks on the owner-only card in every mode but plan (settingsCard.test.ts covers the card itself).
import { applyMcpChange, EMPTY_HARNESS, PLAN_REFUSAL, type StoredHarness } from "@t3flare/harness-registry";
import { MCP_QUESTION_MARKER, type McpAsker, type McpQuestionAnswer, type McpQuestionCard } from "@t3flare/session-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { harnessSecrets } from "../src/harness/secrets.ts";
import { addMcpServer, beginMcpSignIn } from "../src/harness/ops.ts";
import { harnessStore } from "../src/harness/store.ts";
import { pauseOf } from "../src/mcp/elicitation.ts";
import { type McpCallAnswer, McpHost } from "../src/mcp/host.ts";
import { registerCliAsker } from "../src/provider/cli/cliAsk.ts";
import { cliThreadState } from "../src/provider/cli/cliAsk.ts";
import { DURABLE_AGENT, durableModes, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import { APPLIED_CAP, settingsChanges } from "../src/settings/changes.ts";
import { OFF_MESSAGE, type OwnCaller, type ThreadLink } from "../src/settings/caller.ts";
import { LINKED_REFUSAL, NO_MODES_REFUSAL, READ_ONLY_REFUSAL, settingsCall, UNKNOWN_REFUSAL } from "../src/settings/server.ts";
import { SETTINGS_TOOLS } from "../src/settings/tools.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { memory, structured, textOf } from "./settingsFixture.ts";

const NOW = Date.UTC(2026, 10, 14, 12, 0);
const ORIGIN = "https://t3.example.dev";
const SECRET = "sekret-header-value-0042";


const MODES = {
  plan: { runtimeMode: "full-access", interactionMode: "plan" },
  "approval-required": { runtimeMode: "approval-required", interactionMode: "default" },
  "auto-accept-edits": { runtimeMode: "auto-accept-edits", interactionMode: "default" },
  "full-access": { runtimeMode: "full-access", interactionMode: "default" },
} as const;
type ModeName = keyof typeof MODES;

const unregisters: Array<() => void> = [];
const owner = {};
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});

/** Records `mode` for `caller`'s thread where the Environment keeps it: the adapter's record, or the CLI's live session. */
const recordModes = (caller: OwnCaller, mode: ModeName) => {
  const modes = MODES[mode];
  if (caller.agent === DURABLE_AGENT) {
    noteDurableModes(caller.thread!, modes, owner);
    unregisters.push(() => forgetDurableModes(caller.thread!, owner));
  } else {
    unregisters.push(registerCliAsker(caller.thread!, { state: () => ({ ...modes, workspace: "ws-1" }), ask: async () => ({ approved: false, reason: "not this card" }) }));
  }
};

const setup = (options: { links?: Record<string, ThreadLink>; answer?: McpQuestionAnswer; harness?: StoredHarness; cardWaitMs?: number } = {}) => {
  let now = NOW;
  const kv = memory();
  const store = harnessStore(kv);
  if (options.harness !== undefined) store.save(options.harness);
  const secrets = harnessSecrets(kv, () => now);
  const cards: Array<McpQuestionCard> = [];
  const withdrawn: Array<string> = [];
  const asker: McpAsker = {
    ask: async (card) => {
      cards.push(card);
      return options.answer ?? { decision: "accept" };
    },
    withdraw: (id) => void withdrawn.push(id),
  };
  const oauth = {
    begin: async () => ({ ok: true as const, value: { authorizationUrl: "https://auth.example/authorize?state=s3cr3t-state", registration: "dynamic" } }),
    status: () => ({ signedIn: false, expiresAt: null, refreshable: false }),
    forget: () => undefined,
    accessToken: async () => undefined,
  };
  const changes = settingsChanges(nodeSqlStorage(), () => now);
  const logs: Array<Record<string, unknown>> = [];
  const host: McpHost = new McpHost({
    kv,
    engine: undefined,
    settings: () => store.load(),
    now: () => now,
    settingsServer: (input) =>
      settingsCall(
        {
          ops: { store, mcp: host, secrets, oauth, now: () => now },
          oauthStatus: oauth.status,
          link: (thread) => options.links?.[thread] ?? "own",
          // As the Environment DO wires it: a Durable thread's modes are the adapter's record, a CLI's its live session's.
          modes: (caller) => (caller.thread === undefined ? undefined : caller.agent === DURABLE_AGENT ? durableModes(caller.thread) : cliThreadState(caller.thread)),
          changes,
          origin: () => ORIGIN,
          status: () => ({ "settings revision": store.load().revision }),
          running: async () => ({ count: 0, holders: [] }),
          log: (event) => void logs.push(event),
          ...(options.cardWaitMs === undefined ? {} : { cardWaitMs: options.cardWaitMs }),
        },
        input,
      ),
  });
  const call = (caller: OwnCaller, tool: string, args: Record<string, unknown> = {}) => host.call({ server: "settings", tool, args, caller, asker });
  return { kv, store, secrets, oauth, host, call, cards, withdrawn, logs, advance: (ms: number) => (now += ms) };
};


const durable = (thread = "thread-d"): OwnCaller => ({ door: "own", thread, agent: DURABLE_AGENT });
const relayed = (thread = "thread-c"): OwnCaller => ({ door: "own", thread, agent: "codex" });

/** A free change (idle time is free either way) and an asked one (the budget turned up), both to the Environment. */
const FREE = { expectedRevision: 0, settings: { containerIdleMinutes: 7 } };
const ASKED = { expectedRevision: 0, settings: { containerBudget: 4 } };

describe("the Settings server: D7's mode table, every cell", () => {
  for (const [kind, caller] of [
    ["a Durable caller", durable],
    ["a relayed CLI caller", relayed],
  ] as const) {
    describe(kind, () => {
      for (const mode of Object.keys(MODES) as Array<ModeName>) {
        it(`${mode}: a read runs`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "get_settings", { entity: "environment" });
          expect(answer).toMatchObject({ kind: "result", isError: false });
          expect(structured(answer)).toMatchObject({ entity: "environment", revision: 0 });
          expect(run.cards).toEqual([]);
        });

        it(`${mode}: a free change ${mode === "plan" ? "is refused" : mode === "full-access" ? "runs" : "asks on one card"}`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "change_environment", FREE);
          if (mode === "plan") {
            expect(structured(answer)).toEqual({ status: "refused" });
            expect(textOf(answer)).toBe(PLAN_REFUSAL);
            expect(run.store.loadEnvironment().revision).toBe(0);
            expect(run.cards).toEqual([]);
            return;
          }
          expect(structured(answer)).toMatchObject({ status: "applied", revision: 1 });
          expect(run.store.loadEnvironment().settings.containerIdleMinutes).toBe(7);
          expect(run.cards.length).toBe(mode === "full-access" ? 0 : 1);
        });

        it(`${mode}: an asked change ${mode === "plan" ? "is refused" : "asks on one card, full access included"}`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "change_environment", ASKED);
          if (mode === "plan") {
            expect(answer).toMatchObject({ kind: "result", isError: true });
            expect(textOf(answer)).toBe(PLAN_REFUSAL);
            expect(run.store.loadEnvironment().revision).toBe(0);
            expect(run.cards).toEqual([]);
            return;
          }
          expect(structured(answer)).toMatchObject({ status: "applied", revision: 1 });
          expect(run.store.loadEnvironment().settings.containerBudget).toBe(4);
          expect(run.cards.length).toBe(1);
          expect(run.cards[0]!.prompt).toContain("containerBudget: 3 to 4 (turned up)");
          expect(run.store.auditLog(1)[0]).toMatchObject({ tier: "asked", mode: "card", answeredBy: "card" });
        });
      }
    });
  }
});

describe("the Settings server's card for a free change", () => {
  it("is an owner-only approval card with no field, written by the server", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    await run.call(durable(), "change_environment", FREE);
    const [card] = run.cards;
    expect(card).toMatchObject({ kind: "approval", server: "settings", title: "settings: change_environment?" });
    expect(card!.id).toContain(MCP_QUESTION_MARKER);
    expect(card!.questions).toBeUndefined();
    expect(card!.options?.map((option) => option.decision)).toEqual(["accept", "decline", "cancel"]);
    expect(card!.prompt).toContain("containerIdleMinutes: 2 to 7");
    expect(card!.prompt).toContain(`Asked by ${DURABLE_AGENT} on thread thread-d`);
    expect(card!.prompt).toContain("Applies when each Workspace's Container next starts");
  });

  it("a decline changes nothing; an unanswered card is withdrawn and changes nothing", async () => {
    const declined = setup({ answer: { decision: "decline" } });
    recordModes(durable(), "approval-required");
    expect(structured(await declined.call(durable(), "change_environment", FREE))).toEqual({ status: "declined" });
    expect(declined.store.loadEnvironment().revision).toBe(0);
    const late = setup({ answer: { decision: "cancel", reason: "no answer in time" } });
    const answer = await late.call(durable(), "change_environment", FREE);
    expect(structured(answer)).toEqual({ status: "withdrawn" });
    expect(late.withdrawn).toEqual([late.cards[0]!.id]);
    expect(late.store.loadEnvironment().revision).toBe(0);
  });

  it("a card-approved free change is audited with mode card and answeredBy card; in full access with neither (ADR-0035 §11)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    await run.call(durable(), "change_environment", FREE);
    expect(run.store.auditLog(1)[0]).toMatchObject({ tier: "free", mode: "card", answeredBy: "card" });
    const full = setup();
    recordModes(durable("thread-full"), "full-access");
    await full.call(durable("thread-full"), "change_environment", FREE);
    expect(full.store.auditLog(1)[0]!.mode).toBeUndefined();
    expect(full.store.auditLog(1)[0]!.answeredBy).toBeUndefined();
  });

  for (const [what, change] of [
    ["off", { enabled: false }],
    ["read-only", { writes: false }],
  ] as const) {
    it(`the access switch turned ${what} while the card waited: nothing applies`, async () => {
      const run = setup();
      recordModes(durable(), "approval-required");
      const asker: McpAsker = {
        ask: async () => {
          const switched = applyMcpChange(run.store.load(), { op: "server", server: "settings", ...change });
          if (!switched.ok) throw new Error(switched.error);
          run.store.save(switched.harness);
          return { decision: "accept" };
        },
        withdraw: () => undefined,
      };
      // A free change (its card) and an asked one (its Open change) alike.
      for (const args of [FREE, ASKED]) {
        const answer = await run.host.call({ server: "settings", tool: "change_environment", args, caller: durable(), asker });
        expect(textOf(answer)).toContain(what === "off" ? OFF_MESSAGE : READ_ONLY_REFUSAL);
        expect(structured(answer).status).toBe("refused");
        run.store.save({ ...run.store.load(), mcp: { servers: {} } });
      }
      expect(run.store.loadEnvironment().revision).toBe(0);
    });
  }

  it("a revision that moved while the card waited is refused as moved", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const asker: McpAsker = {
      ask: async () => {
        run.store.saveEnvironment({ ...run.store.loadEnvironment(), revision: 5 });
        return { decision: "accept" };
      },
      withdraw: () => undefined,
    };
    const answer = await run.host.call({ server: "settings", tool: "change_environment", args: FREE, caller: durable(), asker });
    expect(structured(answer)).toMatchObject({ status: "moved", revision: 5 });
  });
});

describe("the Settings server's write checks", () => {
  it("Linked and unknown work read and change nothing; a thread-less caller is unknown", async () => {
    const run = setup({ links: { "thread-linked": "linked", "thread-unknown": "unknown" } });
    for (const thread of ["thread-linked", "thread-unknown"]) {
      recordModes(durable(thread), "full-access");
      expect(structured(await run.call(durable(thread), "get_settings", { entity: "harness" }))).toMatchObject({ entity: "harness" });
      const answer = await run.call(durable(thread), "change_environment", FREE);
      expect(textOf(answer)).toBe(thread === "thread-linked" ? LINKED_REFUSAL : UNKNOWN_REFUSAL);
    }
    expect(textOf(await run.call({ door: "own", thread: undefined, agent: DURABLE_AGENT }, "change_environment", FREE))).toBe(UNKNOWN_REFUSAL);
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("no mode record: writes are refused, reads run", async () => {
    const run = setup();
    expect(textOf(await run.call(durable("thread-fresh"), "change_environment", FREE))).toBe(NO_MODES_REFUSAL);
    expect(textOf(await run.call(relayed("thread-fresh"), "change_environment", FREE))).toBe(NO_MODES_REFUSAL);
    expect(structured(await run.call(durable("thread-fresh"), "get_status"))).toMatchObject({ access: { enabled: true, writes: true }, openChanges: [] });
  });

  it("expectedRevision is required and a moved one is refused with the current revision; a change that moves nothing is unchanged", async () => {
    const run = setup();
    recordModes(durable(), "full-access");
    expect(structured(await run.call(durable(), "change_environment", { settings: { containerIdleMinutes: 7 } }))).toEqual({ status: "refused" });
    expect(structured(await run.call(durable(), "change_environment", { ...FREE, expectedRevision: 3 }))).toEqual({ status: "moved", revision: 0 });
    expect(structured(await run.call(durable(), "change_environment", { expectedRevision: 0, settings: { containerIdleMinutes: 2 } }))).toEqual({ status: "unchanged", revision: 0 });
    // Validation by the registry comes before the tier: an out-of-range value is refused, never asked.
    expect(textOf(await run.call(durable(), "change_environment", { expectedRevision: 0, settings: { containerIdleMinutes: 0 } }))).toMatch(/^Not changed: /);
  });

  it("an applied change is audited as the Settings server's, with the caller derived by the Environment", async () => {
    const run = setup();
    recordModes(relayed(), "full-access");
    await run.call(relayed(), "change_environment", FREE);
    expect(run.store.auditLog(1)[0]).toMatchObject({ action: "environment.change", caller: "agent:thread-c", via: "mcp", thread: "thread-c", agent: "codex", tier: "free" });
    expect(run.store.auditLog(1)[0]!.answeredBy).toBeUndefined();
  });

  it("a free MCP change runs; turning a server on, adding one and changing the Settings server's own entry are asked", async () => {
    // A Direct server the owner added (revision 1).
    const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "docs", url: "https://docs.example/mcp", auth: { kind: "none" } });
    if (!added.ok) throw new Error(added.error);
    const run = setup({ answer: { decision: "decline" }, harness: added.harness });
    recordModes(durable(), "full-access");
    const off = await run.call(durable(), "change_mcp", { expectedRevision: 1, change: { op: "server", server: "docs", enabled: false } });
    expect(structured(off)).toMatchObject({ status: "applied", revision: 2 });
    for (const args of [
      { expectedRevision: 2, change: { op: "server", server: "docs", enabled: true } },
      { expectedRevision: 2, change: { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } } },
      { expectedRevision: 2, change: { op: "server", server: "settings", exposure: "hidden" } },
    ]) {
      expect(structured(await run.call(durable(), "change_mcp", args)), JSON.stringify(args)).toMatchObject({ status: "declined" });
    }
    expect(run.cards.length).toBe(3);
    expect(run.store.load().revision).toBe(2);
  });

  it(`at most ${APPLIED_CAP} applied changes per caller per hour`, async () => {
    const run = setup();
    recordModes(durable(), "full-access");
    for (let index = 0; index < APPLIED_CAP; index++) {
      const answer = await run.call(durable(), "change_environment", { expectedRevision: index, settings: { containerIdleMinutes: index % 2 === 0 ? 7 : 8 } });
      expect(structured(answer).status).toBe("applied");
    }
    const capped = await run.call(durable(), "change_environment", { expectedRevision: APPLIED_CAP, settings: { containerIdleMinutes: 9 } });
    expect(textOf(capped)).toContain(`${APPLIED_CAP} settings changes in the last hour`);
    // Another caller has its own count; an hour later the first may change again.
    recordModes(durable("thread-other"), "full-access");
    expect(structured(await run.call(durable("thread-other"), "change_environment", { expectedRevision: APPLIED_CAP, settings: { containerIdleMinutes: 9 } })).status).toBe("applied");
    run.advance(60 * 60_000 + 1);
    expect(structured(await run.call(durable(), "change_environment", { expectedRevision: APPLIED_CAP + 1, settings: { containerIdleMinutes: 10 } })).status).toBe("applied");
  });
});

describe("the Settings server's access switch", () => {
  const stored = (change: { enabled?: boolean; writes?: boolean }): StoredHarness => {
    const applied = applyMcpChange(EMPTY_HARNESS, { op: "server", server: "settings", ...change });
    if (!applied.ok) throw new Error(applied.error);
    return applied.harness;
  };

  it("on: every tool is listed, deferred, with readOnlyHint from its fixed class; resume never", async () => {
    const run = setup();
    const view = await run.host.view();
    const settings = view.servers.find((server) => server.name === "settings")!;
    expect(settings).toMatchObject({ kind: "settings", state: "available", exposure: "deferred" });
    expect(settings.tools.map((tool) => [tool.upstream, tool.class])).toEqual(SETTINGS_TOOLS.map((tool) => [tool.name, tool.class]));
    expect(settings.tools.some((tool) => tool.upstream === "resume")).toBe(false);
    expect(settings.tools.map((tool) => tool.name)).toContain("mcp__settings__change_mcp");
  });

  it("off: the server is not in the view, and through the host every call is unavailable with the off message", async () => {
    let reached = 0;
    const run = setup({ harness: stored({ enabled: false }) });
    const host = new McpHost({
      kv: run.kv,
      engine: undefined,
      settings: () => run.store.load(),
      settingsServer: async () => {
        reached++;
        return { kind: "result", isError: false, text: "ran" };
      },
    });
    expect((await host.view()).servers.map((server) => server.name)).not.toContain("settings");
    recordModes(durable(), "full-access");
    for (const [tool, args] of [
      ["get_settings", { entity: "harness" }],
      ["change_mcp", { expectedRevision: 1, change: { op: "server", server: "settings", enabled: true } }],
    ] as const) {
      expect(await host.call({ server: "settings", tool, args, caller: durable() })).toEqual({ kind: "unavailable", message: OFF_MESSAGE, mayHaveRun: false });
    }
    // Nothing reached the server: it cannot turn itself back on.
    expect(reached).toBe(0);
    expect(run.store.load().revision).toBe(1);
    expect(OFF_MESSAGE).toContain("only the Settings page");
  });

  it("read-only: write tools are not listed and a write call is refused; reads run", async () => {
    const run = setup({ harness: stored({ writes: false }) });
    recordModes(durable(), "full-access");
    const tools = (await run.host.view()).servers.find((server) => server.name === "settings")!.tools;
    expect(tools.every((tool) => tool.class === "read")).toBe(true);
    expect(tools.length).toBe(SETTINGS_TOOLS.filter((tool) => tool.class === "read").length);
    expect(textOf(await run.call(durable(), "change_environment", FREE))).toBe(READ_ONLY_REFUSAL);
    expect(structured(await run.call(durable(), "get_status"))).toMatchObject({ access: { enabled: true, writes: false } });
  });

  it("without the Environment's caller, nothing reaches it", async () => {
    const run = setup();
    expect(await run.host.call({ server: "settings", tool: "get_settings", args: { entity: "harness" } })).toMatchObject({ kind: "unavailable" });
  });
});

describe("the Settings server's reads (plan D14)", () => {
  it("carry no secret value, fingerprint, URL query or authorization URL, and no result is a Pause", async () => {
    const run = setup({ cardWaitMs: 5 });
    const ops = { store: run.store, secrets: run.secrets, oauth: run.oauth, now: () => NOW };
    const added = await addMcpServer(ops, { server: "keyed", url: "https://keyed.example/mcp?key=q-s3cr3t", auth: { kind: "header", header: "X-Api-Key" }, value: SECRET }, { actor: { caller: "owner:sub-1" } });
    expect(added.ok).toBe(true);
    const signed = await addMcpServer(ops, { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } }, { actor: { caller: "owner:sub-1" } });
    expect(signed.ok).toBe(true);
    expect((await beginMcpSignIn({ ...ops, mcp: run.host }, "oauthy", { actor: { caller: "owner:sub-1" } })).ok).toBe(true);
    recordModes(durable(), "full-access");
    const answers: Array<McpCallAnswer> = [];
    for (const [tool, args] of [
      ["get_settings", { entity: "harness" }],
      ["get_settings", { entity: "environment" }],
      ["list_mcp_servers", {}],
      ["list_mcp_servers", { server: "keyed" }],
      ["get_status", {}],
      ["read_audit", { limit: 50 }],
      ["test_mcp_server", { server: "keyed" }],
    ] as const) {
      answers.push(await run.call(durable(), tool, args));
    }
    // A write's results too.
    answers.push(await run.call(durable(), "change_mcp", { expectedRevision: 2, change: { op: "header-value", server: "keyed" } }));
    answers.push(await run.call(durable(), "start_mcp_sign_in", { expectedRevision: 2, server: "oauthy" }));
    for (const answer of answers) {
      const all = JSON.stringify(answer);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain("fingerprint");
      expect(all).not.toContain("q-s3cr3t");
      expect(all).not.toContain("auth.example");
      expect(all).not.toContain("s3cr3t-state");
      expect(pauseOf({ structuredContent: answer.kind === "result" ? answer.structured : undefined })).toBeUndefined();
    }
    const listed = structured(answers[2]!) as unknown as { servers: Array<{ name: string; url?: string; secret?: unknown }> };
    expect(listed.servers.find((server) => server.name === "keyed")).toMatchObject({ url: "https://keyed.example/mcp", secret: { set: true, setAt: NOW } });
    // The audit log keeps the subject on the panel; a reader through the server sees `owner`.
    const audit = structured(answers[5]!) as unknown as { entries: Array<{ caller: string }> };
    expect(audit.entries.every((entry) => !entry.caller.includes("sub-1"))).toBe(true);
  });

  it("names a stored server the set ignores", async () => {
    const run = setup({ harness: { ...EMPTY_HARNESS, mcp: { servers: { settings: { kind: "direct", url: "https://x.example/mcp", enabled: true, exposure: "direct" } } } } });
    recordModes(durable(), "full-access");
    const listed = structured(await run.call(durable(), "list_mcp_servers")) as unknown as { servers: Array<{ name: string; kind: string }>; ignored: Array<string> };
    expect(listed.servers.find((server) => server.name === "settings")?.kind).toBe("settings");
    expect(listed.ignored).toEqual([expect.stringContaining("settings:")]);
  });
});
